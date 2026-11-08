import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../../../../electron/database'
import { insertContinuityBaseline } from '../../../../../electron/migrations/m08-continuity-foundation'
import {
  insertCharacterRelationship,
  readCharacterContinuityNodes,
  readStateChapterRange,
  writeCharacterStateField,
  type StateWriteOrigin,
} from '../../../../../electron/repositories/character-continuity-repository'
import { CharacterRosterRepository, commitCharacterIdentities, refreshCharacterIdentityProjection } from '../../../../../electron/repositories/character-roster-repository'
import { commitAuthorCharacterRoster } from '../../../../../electron/services/character-roster-author'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../../../../../electron/services/generation-source-binding'
import { createMainGenerationOwner } from '../../../../../electron/services/main-generation-owner'
import { readMainGenerationPolicy } from '../../../../../electron/services/main-generation-plan'
import { ModelExecutionLeaseRegistry } from '../../../../../electron/services/model-execution-lease'
import { ProjectCoreRepository } from '../../../../../electron/repositories/project-core-repository'
import { SummaryRepository } from '../../../../../electron/repositories/summary-repository'
import { openCanonicalProjectFixture } from '../../../../../test/helpers/canonical-project-fixture'
import { getBuiltinPromptTemplate } from '../../../builtin-prompt-templates'
import { readBuiltinWritingSkill } from '../../../../shared/builtin-writing-skills'
import type { CharacterStateTextField } from '../../../../shared/character-roster'
import { generationOutputContract, type PrepareDraftContextRequest } from '../../../../shared/generation-owner-contract'
import type { ModelProfile } from '../../../../shared/ipc-channels'
import type { WritingLanguage } from '../../../../shared/writing-language'
import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import type { WorkflowContext } from '../../../../stores/workflow-store'
import { GenerateDraftCommand } from '../generate-draft.command'

const db = () => getProjectDb()!
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const PROSE = '林岚扶着墙走进北塔，周砚留在旧站。'
const QUOTE = '林岚扶着墙走进北塔'

let projectPath = ''
let lin = ''
let zhou = ''
let relationshipCount = 0
let nodesRead: () => unknown = () => readCharacterContinuityNodes(db())
let mainChannels: Record<string, (...args: unknown[]) => unknown> = {}

function finalize(chapter: number): void {
  db().prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(chapter, PROSE)
  db().prepare("INSERT INTO drafts_all (id, chapter_number, version, status, content_id, word_count) VALUES (?, ?, 1, 'finalized', ?, 0)").run(chapter, chapter, chapter)
  db().prepare(`INSERT INTO finalization_outbox_all (finalization_id, draft_id, chapter_number, chapter_title, content_hash, content_revision, content_snapshot, target_file_name, publication_status)
    VALUES (?, ?, ?, '', ?, 1, ?, ?, 'published')`).run(`finalization-${chapter}`, chapter, chapter, hash(PROSE), PROSE, `chapter-${chapter}.txt`)
}

const derivedAt = (chapter: number, quote = QUOTE): StateWriteOrigin => ({
  kind: 'derived', fieldRevision: 1, quote: { start: 0, end: quote.length, text: quote },
  source: { draftId: chapter, finalizationId: `finalization-${chapter}`, chapterNumber: chapter, contentHash: hash(PROSE) },
})
const author = (): StateWriteOrigin => ({ kind: 'author', operationId: 'author-edit', effectiveChapter: readStateChapterRange(db()).next })

function writeState(field: CharacterStateTextField, value: string, origin: StateWriteOrigin = author(), characterId = lin): void {
  db().transaction(() => writeCharacterStateField(db(), { characterId, characterName: '林岚', field, value, origin }))()
}

function relate(relation: string, effectiveChapter?: number): void {
  const relationshipId = `relation-${++relationshipCount}`
  db().transaction(() => insertCharacterRelationship(db(), { relationshipId, sourceId: lin, sourceName: '林岚', targetId: zhou, targetName: '周砚', relation, provenanceJson: '{}' },
    { operationId: 'seed-林岚', action: 'author-edit' }, effectiveChapter))()
  db().transaction(() => refreshCharacterIdentityProjection(db()))()
}

function seedCharacter(name: string, role: 'protagonist' | 'supporting'): string {
  return commitCharacterIdentities(db(), { approval: { operationId: `seed-${name}`, expectedRevision: db().prepare("SELECT revision FROM character_identity_meta WHERE id='main'").pluck().get() as number ?? 0,
    action: 'author-edit', source: { kind: 'author', source: { projectId: 'timeline', epoch: 'lease', sourceId: 'author-fixture', revision: 0, contentHash: 'a'.repeat(64) } } },
  creations: [{ selectionKey: name, fields: { name, role, notes: '静态资料' } }], changes: [], retireIds: [], relationships: [], resolutions: [] }, () => true).created[0].characterId
}

function installIpc(): void {
  vi.stubGlobal('window', { aiNovelAPI: { on: vi.fn(() => () => {}), invoke: async (channel: string, ...args: unknown[]) => {
    if (mainChannels[channel]) return mainChannels[channel](...args)
    switch (channel) {
      case 'prompt:load-global': return { templates: [], diagnostics: [] }
      case 'fs:check-exists': return false
      case 'fs:list-dir': return []
      case 'db:draft-get-latest': return null
      case 'db:blueprint-get-all': return []
      case 'db:blueprint-get': return null
      case 'db:narrative-thread-list-relevant': return []
      case 'db:project-core-get': return ProjectCoreRepository.get()
      case 'db:continuity-list-before': return SummaryRepository.listFinalizedContinuityBefore(Number(args[0]))
      case 'db:continuity-read-source': return SummaryRepository.readFinalizedSource(Number(args[0]))
      case 'db:draft-get-finalized': return db().prepare("SELECT id FROM drafts WHERE chapter_number=? AND status='finalized'").get(Number(args[0])) ?? null
      case 'kb:search-writing-context': return { success: true, value: [] }
      case 'db:character-roster-read': return CharacterRosterRepository.read()
      case 'db:character-continuity-nodes': return nodesRead()
      default: throw new Error(`unexpected IPC: ${channel}`)
    }
  } } })
}

const promptLog = vi.fn()

async function finalPrompt(chapterNumber: number, language: WritingLanguage = 'zh-CN'): Promise<string> {
  let prompt = ''
  const dependencies = { createRuntime: async () => ({
    execute: async (operation: (scope: { session: unknown }) => Promise<unknown>) => operation({ session: { budget: {}, complete: async (task: { messages: Array<{ role: string; content: string }> }) => {
      prompt = task.messages.find(message => message.role === 'user')?.content ?? ''
      throw new Error('PROMPT_CAPTURED')
    } } }),
    close: async () => {},
  }) }
  useProjectStore.setState({ currentProject: { id: 'timeline', sessionLease: 'lease', name: 'Timeline', path: projectPath, novelConfig: { writingLanguage: language, wordsPerChapter: 3000 } } as never })
  const context = { runId: 'timeline-run', projectPath, projectSession: { projectId: 'timeline', leaseId: 'lease', projectPath }, writingLanguage: language, uiLocale: 'zh-CN', data: {}, cancelled: false } as WorkflowContext
  await expect(new GenerateDraftCommand({ projectPath, chapterNumber, title: '合成章节', role: 'development', purpose: '推进', keyEvents: '两人重逢', characters: ['林岚'], userGuidance: '', wordsTarget: 100 },
    { dependencies: dependencies as never }).execute({ step: {}, context, callbacks: { log: promptLog, setProgress: vi.fn(), appendText: vi.fn(), replaceText: vi.fn() } })).rejects.toThrow('PROMPT_CAPTURED')
  return prompt
}

const profileOf = (prompt: string) => prompt.split('\n').find(line => line.startsWith('林岚 (')) ?? ''
const entriesOf = (prompt: string) => profileOf(prompt).split(' | ').slice(1)

beforeEach(() => {
  const cache = path.resolve('.runtime/.cache/novel-quality-modernization/c4-character-timeline')
  fs.mkdirSync(cache, { recursive: true })
  projectPath = fs.mkdtempSync(path.join(cache, 'case-'))
  openCanonicalProjectFixture(projectPath)
  db().prepare("INSERT OR IGNORE INTO project_core (id, project_name, writing_language) VALUES ('main', 'Timeline', 'zh-CN')").run()
  relationshipCount = 0
  promptLog.mockClear()
  nodesRead = () => readCharacterContinuityNodes(db())
  mainChannels = {}
  lin = seedCharacter('林岚', 'protagonist')
  zhou = seedCharacter('周砚', 'supporting')
  db().transaction(() => refreshCharacterIdentityProjection(db()))()
  installIpc()
  useLLMStore.setState({ defaultModelId: 'test-model' })
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectPath, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useProjectStore.setState({ currentProject: null })
  useLLMStore.setState({ models: [], stageModelIds: {}, defaultModelId: null })
})

describe('写第 N 章时提示词里的人物状态和关系按时间线取', () => {
  it('第 N 章生效的作者设定进提示，第 N+1 章才生效的不进，并标明自第几章起', async () => {
    finalize(1); finalize(2); finalize(3)
    writeState('location', '北塔顶层')
    expect(await finalPrompt(3)).not.toContain('北塔顶层')
    expect(entriesOf(await finalPrompt(4))).toContain('作者设定（自第4章起）位置：北塔顶层')
  })

  it('重写第 N 章时看不到第 N 章定稿派生的节点；之后的章只拿到章号和原文，不把派生值写成事实', async () => {
    finalize(1); finalize(2); finalize(3)
    writeState('location', '派生值不进提示', derivedAt(3))
    expect(profileOf(await finalPrompt(3))).not.toContain(QUOTE)
    const later = await finalPrompt(4)
    expect(entriesOf(later)).toContain(`定稿记录·位置（第3章，原文：${QUOTE}）`)
    expect(later).not.toContain('派生值不进提示')
  })

  it('没有原文的派生节点不进提示', async () => {
    finalize(1)
    writeState('location', '无证据的派生值', derivedAt(1, ''))
    expect(profileOf(await finalPrompt(2))).not.toContain('定稿记录')
  })

  it('同一对角色的多条关系都进提示，并标明要作者自己裁', async () => {
    finalize(1)
    relate('结盟'); relate('死敌')
    const entries = entriesOf(await finalPrompt(2))
    const lines = entries.filter(entry => entry.startsWith('作者设定（自第2章起）与周砚的关系'))
    expect(lines).toHaveLength(2)
    expect(lines.join()).toContain('结盟')
    expect(lines.join()).toContain('死敌')
    for (const line of lines) expect(line).toContain('待作者裁定')
  })

  it('每人最多 8 条，超出时留作者设定和最近的章；每条内容不超过 80 字', async () => {
    for (let chapter = 1; chapter <= 6; chapter += 1) finalize(chapter)
    const derivedFields: CharacterStateTextField[] = ['powerLevel', 'physicalState', 'mentalState']
    derivedFields.forEach((field, index) => writeState(field, `派生${index}`, derivedAt(index + 1)))
    for (const relation of ['同门', '债主', '旧友', '邻居', '同乡', '上司']) relate(relation, 1)
    writeState('location', '北'.repeat(120))
    writeState('keyItems', '钥匙', derivedAt(6))
    const entries = entriesOf(await finalPrompt(7)).filter(entry => !entry.startsWith('notes:'))
    expect(entries).toHaveLength(8)
    expect(entries.filter(entry => entry.startsWith('定稿记录'))).toEqual([expect.stringContaining('第6章')])
    const longest = entries.find(entry => entry.includes('北北'))!
    const content = longest.slice(longest.indexOf('：') + 1)
    expect([...content].length).toBe(80)
    expect(content.endsWith('…')).toBe(true)
  })

  it('有节点时档案里原来的关系行和状态行不再出现', async () => {
    finalize(1)
    relate('师徒')
    writeState('location', '码头')
    db().prepare('UPDATE characters SET cs_updated_at_chapter=1,cs_provenance=? WHERE character_id=?').run(JSON.stringify({ location: { kind: 'author', chapterNumber: 1, revision: 1 } }), lin)
    db().transaction(() => refreshCharacterIdentityProjection(db()))()
    const entries = entriesOf(await finalPrompt(2))
    expect(entries.filter(entry => entry.includes('师徒'))).toEqual(['作者设定（自第2章起）与周砚的关系：师徒'])
    expect(entries.filter(entry => entry.includes('码头'))).toEqual(['作者设定（自第2章起）位置：码头'])
  })

  it('英文写作语言下用英文标注', async () => {
    finalize(1); finalize(2)
    writeState('location', 'North tower')
    writeState('keyItems', 'derived value', derivedAt(2, 'Lin Lan walked in'))
    relate('ally'); relate('enemy')
    const entries = entriesOf(await finalPrompt(3, 'en-US'))
    expect(entries).toContain('Author-set from chapter 3: location: North tower')
    expect(entries).toContain('Finalized record, key items (chapter 2, exact text: Lin Lan walked in)')
    expect(entries.filter(entry => entry.includes('relationship with 周砚'))).toHaveLength(2)
    for (const entry of entries.filter(entry => entry.includes('relationship with 周砚'))) expect(entry).toContain('the author has not decided')
  })

  describe('没有时间线可用的旧项目', () => {
    function seedRosterWithoutNodes(): void {
      db().prepare('UPDATE characters SET cs_location=?,cs_recent_events=?,cs_updated_at_chapter=1,cs_provenance=? WHERE character_id=?').run('作者指定的码头', '来源不明的近况',
        JSON.stringify({ location: { kind: 'author', chapterNumber: 1, revision: 1 }, recentEvents: { kind: 'legacy', revision: 1 } }), lin)
      db().prepare('INSERT INTO character_relationships VALUES(?,?,?,?,?,?,?,?)').run('legacy-1', lin, zhou, '父子', '林岚', '周砚', '{}', 'seed-林岚')
      db().transaction(() => refreshCharacterIdentityProjection(db()))()
    }

    it('节点表为空时档案和改动前逐字相同', async () => {
      finalize(1)
      seedRosterWithoutNodes()
      const entries = entriesOf(await finalPrompt(2))
      expect(entries).toContain('location@chapter1: 作者指定的码头')
      expect(entries).toContain('relationship: 周砚 (父子)')
      expect(profileOf(await finalPrompt(2))).not.toContain('来源不明的近况')
    })

    it('节点读取失败时退回同一份档案，写稿照常', async () => {
      finalize(1)
      seedRosterWithoutNodes()
      const expected = await finalPrompt(2)
      expect(promptLog).not.toHaveBeenCalledWith(expect.stringContaining('人物时间线没能读取'))
      nodesRead = () => { throw new Error('SQLITE_BUSY') }
      expect(await finalPrompt(2)).toBe(expected)
      expect(promptLog).toHaveBeenCalledWith(expect.stringContaining('人物时间线没能读取'))
    })

    it('升级项目的基线节点：关系和作者状态保持原来的写法，来历不明的状态仍不进提示', async () => {
      finalize(1); finalize(2)
      seedRosterWithoutNodes()
      db().transaction(() => insertContinuityBaseline(db()))()
      const next = entriesOf(await finalPrompt(3))
      expect(next).toContain('location@chapter1: 作者指定的码头')
      expect(next).toContain('relationship: 周砚 (父子)')
      expect(next.join()).not.toContain('来源不明的近况')
      const rewrite = entriesOf(await finalPrompt(2))
      expect(rewrite).toContain('relationship: 周砚 (父子)')
      expect(rewrite.join()).not.toContain('来源不明的近况')
    })

    it('升级前作者填的状态按当时记下的章生效，不按升级快照章：之后的章都看得到，更早的章看不到', async () => {
      for (let chapter = 1; chapter <= 10; chapter += 1) finalize(chapter)
      db().prepare('UPDATE characters SET cs_location=?,cs_updated_at_chapter=3,cs_provenance=? WHERE character_id=?').run('作者指定的码头',
        JSON.stringify({ location: { kind: 'author', chapterNumber: 3, revision: 1 } }), lin)
      db().transaction(() => refreshCharacterIdentityProjection(db()))()
      db().transaction(() => insertContinuityBaseline(db()))()
      expect(entriesOf(await finalPrompt(5))).toContain('location@chapter3: 作者指定的码头')
      expect(entriesOf(await finalPrompt(3))).toContain('location@chapter3: 作者指定的码头')
      expect(profileOf(await finalPrompt(2))).not.toContain('作者指定的码头')
    })
  })

  describe('读取档案之后、写稿准备之前作者保存了名册', () => {
    const model = { id: 'test-model', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'synthetic-private-key', baseUrl: 'https://api.openai.com/v1',
      temperature: 0.7, maxTokens: 2048, purposes: ['generation'], capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: false, usage: true } } as ModelProfile
    let saves = 0
    let requests: PrepareDraftContextRequest[] = []
    let boundCharacters = ''
    let beforePrepare: (attempt: number) => void = () => {}
    let modelRequests = 0

    function saveRoster(notes: string, location: string): void {
      const read = CharacterRosterRepository.read(db()), entries = structuredClone(read.entries)
      const entry = entries.find(item => item.characterId === lin)!
      entry.notes = notes
      entry.currentState = { powerLevel: '', physicalState: '', mentalState: '', keyItems: '', recentEvents: '', updatedAtChapter: 1, ...entry.currentState, location }
      commitAuthorCharacterRoster(db(), { operationId: `save-${++saves}`, schemaVersion: 1, intent: 'manual_edit', expectedRevision: read.revision, expectedIdentityRevision: read.identityRevision!,
        entries, stateEffectiveChapter: readStateChapterRange(db()).next }, { projectId: 'timeline', epoch: 'lease' }, () => {})
    }

    const charactersFingerprint = (owner: ReturnType<typeof createMainGenerationOwner>, request: PrepareDraftContextRequest) =>
      JSON.stringify(owner.draftPreparationBinding(request).sourceRefs.find(ref => ref.sourceId === 'characters:all'))

    function installMainOwner(): ReturnType<typeof createMainGenerationOwner> {
      const projectStorageRoot = path.join(projectPath, 'binding-project'), globalDataRoot = path.join(projectPath, 'binding-global')
      fs.mkdirSync(projectStorageRoot); fs.mkdirSync(globalDataRoot)
      const sourceDeps = { db: db(), projectStorageRoot, globalDataRoot,
        readBuiltinPrompt: (key: string, language: 'zh-CN' | 'en-US') => JSON.stringify(getBuiltinPromptTemplate(key, language)), readBuiltinSkill: readBuiltinWritingSkill }
      const owner = createMainGenerationOwner({ database: db(), projectId: 'timeline', epoch: 'lease', assertCurrent: () => {},
        leases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model,
        buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(sourceDeps, { ...selection, projectId: 'timeline', epoch: 'lease', modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
        rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(sourceDeps, previous, 'lease', modelReceipt, readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
      mainChannels['generation:prepare-draft-context'] = raw => {
        const request = raw as PrepareDraftContextRequest
        requests.push(request)
        beforePrepare(requests.length)
        const baseline = owner.draftPreparationBinding(request)
        const knowledge = { version: 1, state: 'empty', storageState: 'absent', query: request.query, topK: 5, canonicalRevision: null, documentsRevision: null, items: [] } as never
        const prepared = owner.prepareDraftContext(request, knowledge, baseline)
        boundCharacters = charactersFingerprint(owner, request)
        return prepared
      }
      return owner
    }

    function runMainDraft(chapterNumber: number): { result: Promise<unknown>; prompt: () => string } {
      let prompt = ''
      const handle = { projectId: 'timeline', epoch: 'lease', rootActionId: 'root', runId: 'run' }
      const view = { handle, status: 'running', nonReplayable: false, artifacts: [], budget: { maxAttempts: 32, maxRequestedOutputTokens: 2_000_000, maxRequestedOutputTokensPerAttempt: 32_768, deadlineAt: Date.now() + 3_600_000 } }
      mainChannels['generation:begin'] = () => view
      mainChannels['generation:read'] = () => view
      mainChannels['generation:execute'] = raw => {
        modelRequests += 1
        prompt = (raw as { task: { messages: Array<{ role: string; content: string }> } }).task.messages.find(message => message.role === 'user')?.content ?? ''
        throw new Error('PROMPT_CAPTURED')
      }
      useProjectStore.setState({ currentProject: { id: 'timeline', sessionLease: 'lease', name: 'Timeline', path: projectPath, novelConfig: { writingLanguage: 'zh-CN', wordsPerChapter: 3000 } } as never })
      const context = { runId: 'timeline-run', projectPath, projectSession: { projectId: 'timeline', leaseId: 'lease', projectPath }, writingLanguage: 'zh-CN', uiLocale: 'zh-CN', generationModelId: 'test-model', data: {}, cancelled: false } as WorkflowContext
      const result = new GenerateDraftCommand({ projectPath, chapterNumber, title: '合成章节', role: 'development', purpose: '推进', keyEvents: '两人重逢', characters: ['林岚'], userGuidance: '', wordsTarget: 100 })
        .execute({ step: {}, context, callbacks: { log: promptLog, setProgress: vi.fn(), appendText: vi.fn(), replaceText: vi.fn() } })
      return { result, prompt: () => prompt }
    }

    async function mainPrompt(chapterNumber: number): Promise<string> {
      const run = runMainDraft(chapterNumber)
      await expect(run.result).rejects.toThrow('PROMPT_CAPTURED')
      return run.prompt()
    }

    beforeEach(() => {
      saves = 0
      requests = []
      boundCharacters = ''
      modelRequests = 0
      beforePrepare = () => {}
      finalize(1)
      db().prepare("INSERT INTO blueprints(chapter_number,title) VALUES(2,'合成章节')").run()
    })

    it('提示词用新档案，绑定指纹对应新名册，作者看不到任何报错', async () => {
      const owner = installMainOwner()
      saveRoster('旧档案备注', '旧码头')
      beforePrepare = attempt => { if (attempt === 1) saveRoster('新档案备注', '新灯塔') }
      const prompt = await mainPrompt(2)
      expect(prompt).toContain('新档案备注')
      expect(prompt).toContain('位置：新灯塔')
      expect(prompt).not.toContain('旧档案备注')
      expect(prompt).not.toContain('位置：旧码头')
      expect(boundCharacters).toBe(charactersFingerprint(owner, requests.at(-1)!))
      expect(modelRequests).toBe(1)
    })

    it('一直有保存时只多试一次，然后按来源变化处理，不发模型请求', async () => {
      installMainOwner()
      beforePrepare = attempt => saveRoster(`第${attempt}次保存`, `地点${attempt}`)
      await expect(runMainDraft(2).result).rejects.toThrow('GENERATION_DRAFT_PREPARATION_CHANGED')
      expect(requests).toHaveLength(2)
      expect(modelRequests).toBe(0)
    })

    it('没有并发保存时只准备一次，提示词和不走准备的路径逐字相同', async () => {
      installMainOwner()
      saveRoster('静态备注', '码头')
      const prompt = await mainPrompt(2)
      expect(requests).toHaveLength(1)
      expect(prompt).toContain('静态备注')
      expect(prompt).toBe(await finalPrompt(2))
    })

    it('重试时时间线一直读不到：日志只留一条警告，写稿照常', async () => {
      installMainOwner()
      saveRoster('旧档案备注', '旧码头')
      nodesRead = () => { throw new Error('SQLITE_BUSY') }
      beforePrepare = attempt => { if (attempt === 1) saveRoster('新档案备注', '新灯塔') }
      expect(await mainPrompt(2)).toContain('新档案备注')
      expect(promptLog.mock.calls.filter(([line]) => String(line).includes('人物时间线没能读取'))).toHaveLength(1)
    })

    it('第一次时间线读不到、重试读到了：不留警告，提示词用时间线', async () => {
      installMainOwner()
      saveRoster('旧档案备注', '旧码头')
      let reads = 0
      nodesRead = () => { if (++reads === 1) throw new Error('SQLITE_BUSY'); return readCharacterContinuityNodes(db()) }
      beforePrepare = attempt => { if (attempt === 1) saveRoster('新档案备注', '新灯塔') }
      expect(await mainPrompt(2)).toContain('位置：新灯塔')
      expect(promptLog).not.toHaveBeenCalledWith(expect.stringContaining('人物时间线没能读取'))
    })
  })
})
