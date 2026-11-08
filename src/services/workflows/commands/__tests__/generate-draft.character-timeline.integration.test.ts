import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../../../../electron/database'
import { insertContinuityBaseline } from '../../../../../electron/migrations/m08-continuity-foundation'
import {
  insertCharacterRelationship,
  readCharacterContinuityNodes,
  writeCharacterStateField,
  type StateWriteOrigin,
} from '../../../../../electron/repositories/character-continuity-repository'
import { CharacterRosterRepository, commitCharacterIdentities, refreshCharacterIdentityProjection } from '../../../../../electron/repositories/character-roster-repository'
import { ProjectCoreRepository } from '../../../../../electron/repositories/project-core-repository'
import { SummaryRepository } from '../../../../../electron/repositories/summary-repository'
import { openCanonicalProjectFixture } from '../../../../../test/helpers/canonical-project-fixture'
import type { CharacterStateTextField } from '../../../../shared/character-roster'
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
const author: StateWriteOrigin = { kind: 'author', operationId: 'author-edit' }

function writeState(field: CharacterStateTextField, value: string, origin: StateWriteOrigin = author, characterId = lin): void {
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
    { dependencies: dependencies as never }).execute({ step: {}, context, callbacks: { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn(), replaceText: vi.fn() } })).rejects.toThrow('PROMPT_CAPTURED')
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
  nodesRead = () => readCharacterContinuityNodes(db())
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
      nodesRead = () => { throw new Error('SQLITE_BUSY') }
      expect(await finalPrompt(2)).toBe(expected)
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
      expect(rewrite.join()).not.toContain('作者指定的码头')
    })
  })
})
