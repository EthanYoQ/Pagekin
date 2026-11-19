import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry, CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { migrateSchema } from '../../migrations/runner'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { captureReviewRevisionContext } from '../review-revision-context'
import { getProjectDb } from '../../database'
import { textHash } from '../../repositories/generation-run-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { SummaryRepository } from '../../repositories/summary-repository'
import { DEFAULT_MATERIAL_ADMISSION, generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { readReviewProof } from '../../../src/shared/review-proof'
import { selectFrozenReviewRevisionMaterials } from '../../../src/services/workflows/commands/review-revision-materials'

vi.mock('../../database', () => ({ getProjectDb: vi.fn(), getCurrentProjectPath: vi.fn(() => null) }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })

type Prepared = { contextId: string; frozen?: unknown; materials?: unknown; context?: unknown }
const storedText = (prepared: Prepared) => JSON.stringify(prepared.frozen ?? prepared.context)
const promptView = (prepared: Prepared) => (prepared.materials ?? prepared.context) as Parameters<typeof selectFrozenReviewRevisionMaterials>[0]
const REVIEW_OUTPUT = JSON.stringify({ summary: '检查完成', items: [] })
const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'synthetic-key',
  baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'],
  capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
const loadModel = (id: string) => id === model.id ? model : null

function project(history: readonly string[]) {
  const base = path.resolve('.runtime/.cache/review-proof-v2')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'owner-'))
  const db = new Database(path.join(root, 'project.db'))
  vi.mocked(getProjectDb).mockReturnValue(db)
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  db.exec("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','合成审稿',100);")
  const insertContent = db.prepare('INSERT INTO contents(id,body) VALUES(?,?)')
  const insertDraft = db.prepare("INSERT INTO drafts_all(id,chapter_number,version,status,content_id,word_count) VALUES(?,?,1,'finalized',?,1)")
  db.transaction(() => history.forEach((body, index) => { insertContent.run(index + 1, body); insertDraft.run(index + 1, index + 1, index + 1) }))()
  const source = '林岚走进北塔。'.repeat(20), sid = history.length + 1
  insertContent.run(sid, source)
  db.prepare("INSERT INTO drafts_all(id,chapter_number,version,status,content_id,word_count) VALUES(?,?,1,'draft',?,280)").run(sid, sid, sid)
  cleanup.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { db, root, source, sid }
}

function owner(f: ReturnType<typeof project>, epoch = 'epoch-1') {
  const deps = { db: f.db, projectStorageRoot: f.root, globalDataRoot: f.root, readBuiltinPrompt: () => '冻结的合成提示词' }
  const instance = createMainGenerationOwner({ database: f.db, projectId: 'project', epoch, assertCurrent: () => {},
    leases: new ModelExecutionLeaseRegistry({ loadModel }), loadModel,
    dispatch: vi.fn(async (_r: unknown, o: { onVisible: (v: unknown) => void }) => { o.onVisible({ kind: 'delta', text: REVIEW_OUTPUT }); return { finishReason: 'stop', usage: null } }) as never,
    buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId: 'project', epoch, modelReceipt, policy,
      outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, epoch, modelReceipt,
      readMainGenerationPolicy(previous.sourceManifest.policy)).binding } as never)
  cleanup.unshift(() => instance.suspendForProjectClose())
  return instance
}

function prepareReview(f: ReturnType<typeof project>, o: ReturnType<typeof owner>) {
  const prepared = o.prepareReviewRevision({ operation: 'review-chapter', draftId: f.sid,
    expectedDraft: { chapterNumber: f.sid, version: 1, status: 'draft', contentHash: textHash(f.source) }, authorInputs: [], uiLocale: 'zh-CN' }) as Prepared
  const selection: BeginGenerationRequest = { operation: 'review-chapter', uiActionNonce: 'action', modelId: model.id, chapterNumber: f.sid,
    selectedDraftIds: [f.sid], selectedFinalizedDraftIds: [], promptKeys: ['consistency_check'], skillStages: ['review'], output: 'structured-data',
    reviewRevisionContextId: prepared.contextId, authorInputs: [{ id: 'review-revision-context', text: storedText(prepared) }] }
  return { prepared, selection }
}

function storedProof(db: import('better-sqlite3').Database, runId: string) {
  const binding = JSON.parse(db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(runId) as string)
  const proof = readReviewProof(binding.sourceManifest, textHash)
  if (proof.kind !== 'recomputable') throw new Error(`proof ${proof.kind}`)
  return proof
}

/** 前文每章当前投影里都记着「林岚已经死亡」，待审章蓝图仍让林岚出场：每章命中一条预检。 */
function deadCharacterContext(priorChapters: number) {
  const db = new Database(':memory:')
  cleanup.push(() => db.close())
  initializeLegacyBaselineSchema(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  vi.mocked(getProjectDb).mockReturnValue(db)
  db.exec("INSERT INTO project_core(id,project_name,worldbuilding) VALUES('main','合成项目','作者世界设定'); INSERT INTO characters(character_id,name) VALUES('lin','林岚')")
  for (let chapter = 1; chapter <= priorChapters; chapter++) {
    const prose = `第${chapter}章。林岚已经死亡。`
    db.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(chapter, '待定稿')
    db.prepare("INSERT INTO drafts_all(id,chapter_number,version,status,content_id) VALUES(?,?,1,'draft',?)").run(chapter, chapter, chapter)
    FinalizationRepository.commit({ finalizationId: `final-${chapter}`, draftId: chapter, chapterNumber: chapter, chapterTitle: `章${chapter}`,
      content: prose, contentHash: textHash(prose), contentRevision: 1, targetFileName: `${chapter}.txt` })
    const generation = db.prepare("SELECT generation FROM continuity_projection_meta WHERE id='main'").pluck().get() as number
    SummaryRepository.saveFinalizedContinuity({ draftId: chapter, chapterNumber: chapter, chapterNotes: '告别', projectionGeneration: generation,
      source: { draftId: chapter, chapterNumber: chapter, finalizationId: `final-${chapter}`, contentHash: textHash(prose) },
      facts: [{ category: 'character-state', entities: ['林岚'], statement: prose, evidence: prose, sourceChapter: chapter,
        characterRefs: [{ characterId: 'lin', displayNameSnapshot: '林岚' }] }] })
  }
  const target = priorChapters + 1, source = '待审正文'
  db.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(10_000, source)
  db.prepare("INSERT INTO drafts_all(id,chapter_number,version,status,content_id) VALUES(10000,?,1,'draft',10000)").run(target)
  db.prepare('INSERT INTO blueprints(chapter_number,title,characters,key_events) VALUES(?,?,?,?)').run(target, '归来', JSON.stringify(['林岚']), '林岚归来')
  const captured = captureReviewRevisionContext(db, { operation: 'review-chapter', draftId: 10_000,
    expectedDraft: { chapterNumber: target, version: 1, status: 'draft', contentHash: textHash(source) }, authorInputs: [], uiLocale: 'zh-CN' }, 'project') as unknown
  return ((captured as { frozen?: unknown }).frozen ?? captured) as Record<string, unknown> & { preflightFindings: unknown[] }
}

describe('新写入的审修证明不随前文章数增长（#702 PR 2）', () => {
  it('去掉预检命中后，前文 3 章与 48 章的冻结上下文相差不超过 64 字节', () => {
    const bytes = (chapters: number) => {
      const { preflightFindings: _findings, ...rest } = deadCharacterContext(chapters)
      return Buffer.byteLength(JSON.stringify(rest))
    }
    expect(Math.abs(bytes(48) - bytes(3))).toBeLessThanOrEqual(64)
  })

  it('预检命中每条不超过 0.7 KB', () => {
    for (const chapters of [3, 48]) {
      const { preflightFindings } = deadCharacterContext(chapters)
      expect(preflightFindings).toHaveLength(chapters)
      expect(Buffer.byteLength(JSON.stringify(preflightFindings))).toBeLessThanOrEqual(700 * chapters)
    }
  })
})

describe('长篇能开 AI 审稿（#702 PR 2）', () => {
  it('前文 1100 章短正文：开审稿、绑定材料裁决、保存审稿都成功', { timeout: 120_000 }, async () => {
    const f = project(Array.from({ length: 1100 }, (_, index) => `第${index + 1}章。林岚走进北塔。`))
    const o = owner(f), { prepared, selection } = prepareReview(f, o)
    const view = o.begin(selection)
    const admission = await selectFrozenReviewRevisionMaterials(promptView(prepared), { projectId: 'project', epoch: 'epoch-1' }, DEFAULT_MATERIAL_ADMISSION, 0)
    expect(admission.decision.included.length + admission.decision.omitted.length).toBeGreaterThan(1024)
    o.bindMaterialDecision(view.handle, { ...admission.decision, promptHash: textHash('检查冻结正文') })
    const run = await o.execute({ handle: view.handle, invocationNonce: 'review-run',
      task: { purpose: 'review-chapter', output: 'structured-data', messages: [{ role: 'user', content: '检查冻结正文' }] } })
    const artifact = run.run.artifacts.at(-1)!
    const saved = o.commitReview({ contextId: prepared.contextId, handle: view.handle,
      artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash } })
    expect(saved.kind).toBe('review')
  })

  it('前文 1000 章、每章 3000 汉字：开审稿成功', { timeout: 120_000 }, () => {
    const body = '林岚走进北塔，灯火照亮了石阶。'.repeat(200).slice(0, 3000)
    const f = project(Array.from({ length: 1000 }, () => body))
    const o = owner(f), { selection } = prepareReview(f, o)
    expect(o.begin(selection).handle.runId).toBeTruthy()
  })
})

describe('续跑仍按捕获时的来源比对（#702 PR 2）', () => {
  it('改掉一章前文后续跑：报来源已变', () => {
    const f = project(['第1章。林岚走进北塔。', '第2章。林岚离开北塔。'])
    const o = owner(f), { selection } = prepareReview(f, o)
    const view = o.begin(selection)
    f.db.prepare('UPDATE contents SET body=? WHERE id=1').run('第1章。作者改过的前文。')
    expect(() => rebuildGenerationSourceBinding({ db: f.db, projectStorageRoot: f.root, globalDataRoot: f.root, readBuiltinPrompt: () => '冻结的合成提示词' },
      JSON.parse(f.db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(view.handle.runId) as string), 'epoch-2'))
      .toThrow('GENERATION_REVIEW_CONTEXT_CHANGED')
  })

  it('重开作品后续跑：拼出的审稿材料与开跑时逐字相同', async () => {
    const f = project(['第1章。林岚走进北塔。', '第2章。林岚离开北塔。'])
    const first = owner(f), { prepared, selection } = prepareReview(f, first)
    const view = first.begin(selection)
    const before = await selectFrozenReviewRevisionMaterials(promptView(prepared), { projectId: 'project', epoch: 'epoch-1' }, DEFAULT_MATERIAL_ADMISSION, 0)
    first.suspendForProjectClose()
    const reopened = owner(f, 'epoch-2')
    const recovery = reopened.readReviewRevisionRecovery(view.handle) as unknown as Prepared & { canResume: boolean }
    expect(recovery.canResume).toBe(true)
    const after = await selectFrozenReviewRevisionMaterials(promptView(recovery), { projectId: 'project', epoch: 'epoch-2' }, DEFAULT_MATERIAL_ADMISSION, 0)
    expect(after.admitted.map(item => item.text)).toEqual(before.admitted.map(item => item.text))
    expect(storedProof(f.db, view.handle.runId).contextJson).toBe(storedText(prepared))
  })
})
