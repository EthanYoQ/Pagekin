import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { CANONICAL_PROJECT_DIRECTORY } from '../../../src/shared/project-format'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { readPortableCurrentAuthority } from '../portable-current-authority'
import { exportPortableProject } from '../project-archive-service'
import { restorePortableProject } from '../project-restore-service'
import { ReviewRepository } from '../../repositories/review-repository'
import { RevisionRepository } from '../../repositories/revision-repository'
import { textHash } from '../../repositories/generation-run-repository'
import { createHumanConfirmedReviewSnapshot, renderHumanConfirmedReviewBrief, serializeHumanConfirmedReviewSnapshot } from '../../../src/shared/human-confirmed-review'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { PreparedReviewRevisionContext } from '../../../src/shared/review-revision-generation'
import { countDraftUnits } from '../../../src/shared/draft-units'

const source = '林岚走进北塔，灯火照亮了石阶。'.repeat(20) + '门闩上的裂纹仍在。'
const revised = '林岚走进北塔，灯火照亮了石阶。'.repeat(20) + '门闩上的裂纹已用石蜡封住。'
const report = JSON.stringify({ summary: '发现门闩事实需要修复。',
  items: [{ category: '表达', severity: 'pass', description: '其余表达可接受。' }],
  goalReviews: [{ id: 'ch1:keyEvents:1', evidence: [{ quote: '门闩上的裂纹仍在' }], description: '门闩裂纹尚未处理。', status: 'unmet' }] })
const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', apiKey: 'synthetic-key',
  baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'],
  capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
const materialDecision = (prompt: string, included: NonNullable<BeginGenerationRequest['materialDecision']>['included'] = []) => ({
  version: 1 as const, verdict: 'admitted' as const, promptHash: textHash(prompt),
  capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1' as const, admittedUnits: included.reduce((sum, item) => sum + item.units, 0) },
  coverage: { required: included.length, included: included.length, complete: true }, included, omitted: [] })

let base = ''
let projectRoot = ''
const owners: Array<{ suspendForProjectClose(): void }> = []
let outputs: string[] = []

beforeEach(() => {
  base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'restored-review-'))
  projectRoot = path.join(base, 'book')
  fs.mkdirSync(projectRoot)
  openCanonicalProjectFixture(projectRoot)
  outputs = [report, revised]
})

afterEach(() => {
  for (const owner of owners.splice(0)) owner.suspendForProjectClose()
  closeProjectDatabase()
  fs.rmSync(base, { recursive: true, force: true })
})

const projectIdOf = (root: string) =>
  JSON.parse(fs.readFileSync(path.join(root, CANONICAL_PROJECT_DIRECTORY, 'project.json'), 'utf8')).projectId as string

function ownerFor(root: string, epoch: string) {
  const db = getProjectDb()!, projectId = projectIdOf(root)
  const storage = path.join(root, CANONICAL_PROJECT_DIRECTORY)
  const deps = { db, projectStorageRoot: storage, globalDataRoot: base, readBuiltinPrompt: () => '冻结的合成提示词' }
  const owner = createMainGenerationOwner({ database: db, projectId, epoch, assertCurrent: () => {},
    leases: new ModelExecutionLeaseRegistry({ loadModel: id => id === model.id ? model : null }),
    loadModel: id => id === model.id ? model : null,
    dispatch: async (_request, options) => { options.onVisible({ kind: 'delta', text: outputs.shift()! }); return { finishReason: 'stop', usage: null } },
    transferOrigin: () => readPortableCurrentAuthority({ database: db, projectStorageRoot: storage, projectId })?.originProjectId,
    buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId, epoch, modelReceipt, policy,
      outputContract: generationOutputContract(selection) }).binding,
    rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, epoch, modelReceipt,
      readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
  owners.push(owner)
  return { db, owner }
}

function selection(prepared: PreparedReviewRevisionContext, nonce: string): BeginGenerationRequest {
  const review = prepared.context.operation === 'review-chapter'
  return { operation: prepared.context.operation, uiActionNonce: nonce, modelId: model.id, chapterNumber: 1,
    selectedDraftIds: [1], selectedFinalizedDraftIds: [], promptKeys: [review ? 'consistency_check' : 'refine_from_review'],
    skillStages: [review ? 'review' : 'refinement'], output: review ? 'structured-data' : 'visible-text',
    reviewRevisionContextId: prepared.contextId, authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(prepared.context) }],
    ...(prepared.parentRootActionId ? { parentRootActionId: prepared.parentRootActionId } : {}) }
}

function seedChapter(db: Database.Database) {
  db.exec("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','合成审稿',100);"
    + " INSERT INTO blueprints(chapter_number,title,key_events) VALUES(1,'北塔','修复门闩上的裂纹');")
  db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run(source)
  db.exec("INSERT INTO drafts_all(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,280)")
}

/** 审稿并保存，作者确认审稿。返回确认稿，供按确认稿修稿。 */
async function reviewAndConfirm(owner: ReturnType<typeof ownerFor>['owner'], db: Database.Database) {
  const prepared = owner.prepareReviewRevision({ operation: 'review-chapter', draftId: 1,
    expectedDraft: { chapterNumber: 1, version: 1, status: 'draft', contentHash: textHash(source) }, authorInputs: [], uiLocale: 'zh-CN' })
  const view = owner.begin(selection(prepared, 'review'))
  owner.bindMaterialDecision(view.handle, materialDecision('检查门闩'))
  const run = await owner.execute({ handle: view.handle, invocationNonce: 'review-run',
    task: { purpose: 'review-chapter', output: 'structured-data', messages: [{ role: 'user', content: '检查门闩' }] } })
  const artifact = run.run.artifacts.at(-1)!
  const saved = owner.commitReview({ contextId: prepared.contextId, handle: view.handle,
    artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash } })
  const snapshot = createHumanConfirmedReviewSnapshot({ sourceReviewId: saved.id, sourceDraft: saved.source,
    summary: '作者确认修复门闩', authorGuidance: '', items: [{ category: '本章目标', severity: 'error',
      description: '修复门闩上的裂纹\n门闩裂纹尚未处理。', quote: '门闩上的裂纹仍在', goalId: 'ch1:keyEvents:1', decision: 'apply', origin: 'ai' }] })!
  const content = serializeHumanConfirmedReviewSnapshot(snapshot)
  const confirmation = ReviewRepository.create({ baseDraftId: 1, content, expectedSource: saved.source }, db)
  return { reviewRoot: view.handle.rootActionId, snapshot, content, confirmationId: confirmation.id }
}

async function startRevision(owner: ReturnType<typeof ownerFor>['owner'], confirmed: Awaited<ReturnType<typeof reviewAndConfirm>>) {
  const prepared = owner.prepareReviewRevision({ operation: 'refine-from-review', draftId: 1,
    expectedDraft: { chapterNumber: 1, version: 1, status: 'draft', contentHash: textHash(source) },
    reviewSourceId: confirmed.confirmationId, confirmedReviewContent: confirmed.content, authorInputs: [], uiLocale: 'zh-CN' })
  const view = owner.begin(selection(prepared, 'revision'))
  const brief = renderHumanConfirmedReviewBrief(confirmed.snapshot, 'zh-CN')
  owner.bindMaterialDecision(view.handle, materialDecision('只修复门闩', [{ sourceId: `review:confirmed:${confirmed.confirmationId}`,
    revision: confirmed.confirmationId, contentHash: textHash(brief), category: 'author', required: true, units: Buffer.byteLength(brief) }]))
  await owner.execute({ handle: view.handle, invocationNonce: 'revision-run',
    task: { purpose: 'refine-from-review', output: 'visible-text', messages: [{ role: 'user', content: '只修复门闩' }] } })
  const candidate = owner.read(view.handle).candidates![0]!
  const composition = owner.composeVisible(view.handle, [candidate.artifactId], textHash(revised), 'visible-append-v1')
  return { contextId: prepared.contextId, handle: view.handle, expectedCompositionHash: composition.textHash }
}

async function reviseFromConfirmation(owner: ReturnType<typeof ownerFor>['owner'], confirmed: Awaited<ReturnType<typeof reviewAndConfirm>>) {
  return owner.commitRevision(await startRevision(owner, confirmed))
}

async function exportAndRestore(): Promise<string> {
  for (const owner of owners.splice(0)) owner.suspendForProjectClose()
  const archivePath = path.join(base, `${randomUUID()}.ainovel`)
  await exportPortableProject({ sourceProjectRoot: projectRoot,
    projectSession: { projectId: projectIdOf(projectRoot), projectPath: projectRoot, leaseId: 'lease' },
    targetArchivePath: archivePath, attemptParentPath: base, assertCurrentContext: () => undefined,
    assets: { snapshot: () => ({ files: [], semanticCounts: { 'provided-assets': 0 }, omittedItems: [],
      transferReceiptIds: [], historyProjectionIds: [], verifyUnchanged: () => undefined }) } })
  const restoredRoot = path.join(base, 'restored')
  await restorePortableProject({ archivePath, targetProjectRoot: restoredRoot })
  closeProjectDatabase()
  initProjectDatabase(restoredRoot)
  return restoredRoot
}

describe('从存档恢复的书在老章节上继续审修（#702）', () => {
  it('恢复前审过稿、作者确认过：恢复后按确认稿修稿，修出的稿与没导出的书一致', async () => {
    const original = ownerFor(projectRoot, 'epoch-1')
    seedChapter(original.db)
    const confirmed = await reviewAndConfirm(original.owner, original.db)
    const restoredRoot = await exportAndRestore()

    const restored = ownerFor(restoredRoot, 'epoch-restored')
    expect(await reviseFromConfirmation(restored.owner, confirmed)).toMatchObject({ kind: 'revision', revisionStatus: 'pending', content: revised })
  })

  it('恢复前审修并合并过：恢复后复核能做完并记进审修循环', async () => {
    const original = ownerFor(projectRoot, 'epoch-1')
    seedChapter(original.db)
    const confirmed = await reviewAndConfirm(original.owner, original.db)
    const saved = await reviseFromConfirmation(original.owner, confirmed)
    RevisionRepository.mergeIntoDraft({ revisionId: saved.id, targetDraftId: 1, expectedDraftContent: source,
      mergedContent: revised, wordCount: countDraftUnits(revised) }, original.db)
    const restoredRoot = await exportAndRestore()

    const restored = ownerFor(restoredRoot, 'epoch-restored')
    const cycle = restored.db.prepare('SELECT cycle_id,merged_hash FROM review_cycles').get() as { cycle_id: string; merged_hash: string }
    const recheck = restored.owner.prepareReviewRevision({ operation: 'review-chapter', draftId: 1,
      expectedDraft: { chapterNumber: 1, version: 1, status: 'revised', contentHash: textHash(revised) },
      reviewCycleId: cycle.cycle_id, expectedMergedHash: cycle.merged_hash, authorInputs: [], uiLocale: 'zh-CN' })
    const view = restored.owner.begin(selection(recheck, 'recheck'))
    const finding = restored.db.prepare('SELECT finding_id,target_id FROM review_findings WHERE cycle_id=? AND target_id IS NOT NULL')
      .get(cycle.cycle_id) as { finding_id: string; target_id: string }
    outputs = [JSON.stringify({ summary: '门闩已修复。', items: [{ findingId: finding.finding_id, targetId: finding.target_id,
      resolved: true, evidenceQuote: '门闩上的裂纹已用石蜡封住', reason: '正文出现新证据。' }] })]
    restored.owner.bindMaterialDecision(view.handle, materialDecision('复核门闩'))
    const run = await restored.owner.execute({ handle: view.handle, invocationNonce: 'recheck-run',
      task: { purpose: 'review-chapter', output: 'structured-data', messages: [{ role: 'user', content: '复核门闩' }] } })
    const artifact = run.run.artifacts.at(-1)!
    expect(restored.owner.commitReview({ contextId: recheck.contextId, handle: view.handle,
      artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash } }))
      .toMatchObject({ kind: 'review', reviewCycle: { cycleId: cycle.cycle_id, disposition: 'completed' } })
  })

  it('恢复前留着没保存的审稿和修稿：恢复后的可恢复列表不列旧运行，也不标读坏', async () => {
    outputs = [report, revised, report]
    const original = ownerFor(projectRoot, 'epoch-1')
    seedChapter(original.db)
    const confirmed = await reviewAndConfirm(original.owner, original.db)
    const unsavedRevision = await startRevision(original.owner, confirmed)
    const prepared = original.owner.prepareReviewRevision({ operation: 'review-chapter', draftId: 1,
      expectedDraft: { chapterNumber: 1, version: 1, status: 'draft', contentHash: textHash(source) }, authorInputs: [], uiLocale: 'zh-CN' })
    const unsavedReview = original.owner.begin(selection(prepared, 'second-review'))
    original.owner.bindMaterialDecision(unsavedReview.handle, materialDecision('再审一次'))
    await original.owner.execute({ handle: unsavedReview.handle, invocationNonce: 'second-review-run',
      task: { purpose: 'review-chapter', output: 'structured-data', messages: [{ role: 'user', content: '再审一次' }] } })
    expect(original.owner.listRecovery()).toMatchObject({ partial: false })
    expect(original.owner.listRecovery().reviews.map(item => item.view.handle.runId).sort())
      .toEqual([unsavedRevision.handle.runId, unsavedReview.handle.runId].sort())
    const restoredRoot = await exportAndRestore()

    expect(ownerFor(restoredRoot, 'epoch-restored').owner.listRecovery()).toMatchObject({ reviews: [], drafts: [], partial: false })
  })
})

vi.setConfig({ testTimeout: 60_000 })
