import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { inspectM03ReviewCycles } from '../../migrations/m03-review-cycle'
import { verifyCanonicalProjectData } from '../project-data-locator'
import type { ProjectSqliteWorkerOptions } from '../project-sqlite-host'
import { exportPortableProject } from '../project-archive-service'
import { restorePortableProject } from '../project-restore-service'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { projectSqliteWorkerForTest } from '../../../test/helpers/portable-export-worker'
import { seedReviewedBook } from '../../../test/helpers/review-cycle-fixture'
import { readReviewProof } from '../../../src/shared/review-proof'
import { CANONICAL_PROJECT_DATABASE, CANONICAL_PROJECT_DIRECTORY } from '../../../src/shared/project-format'
import type { ReviewFinalizedMaterial } from '../../../src/shared/review-revision-generation'

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

let worker: ProjectSqliteWorkerOptions
beforeAll(async () => { worker = await projectSqliteWorkerForTest() }, 60_000)

let base = ''
let projectRoot = ''
let projectId = ''
const databaseFile = () => path.join(projectRoot, CANONICAL_PROJECT_DIRECTORY, CANONICAL_PROJECT_DATABASE)

beforeEach(() => {
  base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'proof-tidy-'))
  projectRoot = path.join(base, 'book')
  fs.mkdirSync(projectRoot)
  openCanonicalProjectFixture(projectRoot)
  projectId = JSON.parse(fs.readFileSync(path.join(projectRoot, CANONICAL_PROJECT_DIRECTORY, 'project.json'), 'utf8')).projectId
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(base, { recursive: true, force: true })
})

const prose = (chapter: number) => `第${chapter}章。` + '林岚走进北塔，灯火照亮了石阶。'.repeat(40)
/** v1 证明：前文全部定稿原文冻结在每条证明里。 */
const priorChapters = (chapter: number): ReviewFinalizedMaterial[] => Array.from({ length: chapter - 1 }, (_, index) => ({
  draftId: 10_000 + index, chapterNumber: index + 1, chapterTitle: `第${index + 1}章`, content: prose(index + 1) }))

/** 关闭后再打开：校验与整理在 worker 里完成。 */
async function reopen() {
  closeProjectDatabase()
  initProjectDatabase(projectRoot, await verifyCanonicalProjectData(projectRoot, worker))
  return getProjectDb()!
}

/** 关库后的文件字节数（WAL 已并回主文件）。 */
function closedBytes() {
  closeProjectDatabase()
  return fs.statSync(databaseFile()).size
}

/** 验收口径：已保存、前文全文还在、超过 64 KB 的行。 */
function stillFull(db: import('better-sqlite3').Database): string[] {
  return db.prepare(`SELECT r.run_id FROM generation_runs r WHERE EXISTS (SELECT 1 FROM generation_attempts t
    WHERE t.run_id=r.run_id AND json_type(t.usage_receipt_json,'$.reviewRevisionEffect')='object')
    AND octet_length(r.binding_json) > 65536 AND json_type(r.binding_json,'$.sourceManifest.reviewRevisionContext.history')='array'
    ORDER BY r.run_id`).pluck().all() as string[]
}

/** 改证明里的上下文，再把清单哈希、作者输入副本和收据哈希一起改到自洽。 */
function rewriteProof(db: import('better-sqlite3').Database, runId: string, change: (context: Record<string, unknown>) => void) {
  const binding = JSON.parse(bindingOf(db, runId))
  const context = binding.sourceManifest.reviewRevisionContext
  change(context)
  const contextJson = JSON.stringify(context)
  binding.sourceManifest.reviewRevisionContextHash = sha256(contextJson)
  binding.sourceManifest.authorInputs = [{ id: 'review-revision-context', text: contextJson }]
  db.prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=?').run(JSON.stringify(binding), runId)
  db.prepare(`UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.reviewRevisionEffect.contextHash',?)
    WHERE run_id=?`).run(sha256(contextJson), runId)
}

interface SavedProof { runId: string; proofKind: string; proofHash?: string; receiptHash: string; bytes: number }
function savedProofs(db: import('better-sqlite3').Database): SavedProof[] {
  const rows = db.prepare(`SELECT r.run_id,r.binding_json,json_extract(t.usage_receipt_json,'$.reviewRevisionEffect.contextHash') AS receipt_hash
    FROM generation_runs r JOIN generation_attempts t ON t.run_id=r.run_id
    WHERE json_type(t.usage_receipt_json,'$.reviewRevisionEffect')='object' ORDER BY r.run_id`).all() as Array<{
      run_id: string; binding_json: string; receipt_hash: string }>
  return rows.map(row => {
    const proof = readReviewProof(JSON.parse(row.binding_json).sourceManifest, sha256)
    return { runId: row.run_id, proofKind: proof.kind === 'recomputable' ? `v${proof.context.version}` : proof.kind,
      receiptHash: row.receipt_hash, bytes: Buffer.byteLength(row.binding_json),
      ...(proof.kind === 'recomputable' || proof.kind === 'sealed' ? { proofHash: proof.contextHash } : {}) }
  })
}

const bindingOf = (db: import('better-sqlite3').Database, runId: string) =>
  db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(runId) as string

async function exportAndRestore() {
  closeProjectDatabase()
  initProjectDatabase(projectRoot)
  const archivePath = path.join(base, `${randomUUID()}.ainovel`)
  const receipt = await exportPortableProject({ sourceProjectRoot: projectRoot,
    projectSession: { projectId, projectPath: projectRoot, leaseId: 'lease' },
    targetArchivePath: archivePath, attemptParentPath: base, assertCurrentContext: () => undefined,
    assets: { snapshot: () => ({ files: [], semanticCounts: { 'provided-assets': 0 }, omittedItems: [],
      transferReceiptIds: [], historyProjectionIds: [] }) } })
  closeProjectDatabase()
  const target = path.join(base, `restored-${randomUUID()}`)
  await restorePortableProject({ archivePath, targetProjectRoot: target })
  initProjectDatabase(target)
  return { receipt, restored: getProjectDb()! }
}

describe('打开老书时整理源库里的旧审修证明（#702 PR 4）', () => {
  it('112 章老书：打开后源库缩到原来的四分之一以下，已保存的全文证明封存、收据哈希不变；再筛只剩没保存的那条；导出恢复从严通过',
    { timeout: 600_000 }, async () => {
      const db = getProjectDb()!
      seedReviewedBook(db, 112, { history: priorChapters })
      db.prepare('UPDATE generation_roots SET budget_json=?').run(JSON.stringify({ maxPhysicalRequests: 1,
        maxTokenLiability: 100, maxOutputPerRequest: 100, maxActiveElapsedMs: 1000 }))
      db.prepare(`INSERT INTO generation_runs(run_id,root_action_id,binding_json,status,created_at_ms,open_key)
        SELECT 'run-unsaved-ch112',root_action_id,binding_json,status,3,'open-unsaved-ch112' FROM generation_runs WHERE run_id='run-review-ch112'`).run()
      const unsaved = bindingOf(db, 'run-unsaved-ch112')
      const before = savedProofs(db)
      expect(before).toHaveLength(224)
      expect(before.every(item => item.proofKind === 'v1' && item.proofHash === item.receiptHash)).toBe(true)
      const bytesBefore = closedBytes()

      const opened = await reopen()
      expect(inspectM03ReviewCycles(opened)).toEqual({ structureOk: true, unprovable: [] })
      expect(stillFull(opened)).toEqual([])
      expect(bindingOf(opened, 'run-unsaved-ch112')).toBe(unsaved)
      const after = savedProofs(opened)
      expect(after.map(item => [item.runId, item.receiptHash])).toEqual(before.map(item => [item.runId, item.receiptHash]))
      const large = new Set(before.filter(item => item.bytes > 65536).map(item => item.runId))
      expect(large.size).toBeGreaterThan(180)
      expect(after.filter(item => large.has(item.runId)).every(item => item.proofKind === 'sealed' && item.proofHash === item.receiptHash)).toBe(true)
      expect(closedBytes()).toBeLessThan(bytesBefore / 4)

      const { receipt, restored } = await exportAndRestore()
      expect(receipt.omittedReviewCycles ?? []).toEqual([])
      expect(inspectM03ReviewCycles(restored)).toEqual({ structureOk: true, unprovable: [] })
      expect(savedProofs(restored).map(item => [item.runId, item.receiptHash])).toEqual(before.map(item => [item.runId, item.receiptHash]))
    })

  it('没保存的、证明验不过的、收据对不上的行逐字不变；封存的行只改证明三项，模型收据、来源、记账照旧', { timeout: 120_000 }, async () => {
    const db = getProjectDb()!
    seedReviewedBook(db, 3, { firstChapter: 60, history: priorChapters })
    db.prepare(`INSERT INTO generation_runs(run_id,root_action_id,binding_json,status,created_at_ms,open_key)
      SELECT 'run-unsaved-ch60',root_action_id,binding_json,status,3,'open-unsaved-ch60' FROM generation_runs WHERE run_id='run-review-ch60'`).run()
    db.prepare(`UPDATE generation_runs SET binding_json=json_set(binding_json,'$.sourceManifest.reviewRevisionContextHash',?)
      WHERE run_id='run-review-ch61'`).run(sha256('另一份上下文'))
    db.prepare(`UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.reviewRevisionEffect.contextHash',?)
      WHERE run_id='run-review-ch62'`).run(sha256('另一份上下文'))
    db.prepare(`UPDATE generation_runs SET binding_json=json_set(binding_json,'$.sourceManifest.modelReceipt',json(?),
      '$."$runEffects"',json(?)) WHERE run_id='run-review-ch60'`).run(JSON.stringify({ modelId: 'old-model' }), JSON.stringify([{ kind: 'kept' }]))
    const kept = ['run-unsaved-ch60', 'run-review-ch61', 'run-review-ch62'].map(runId => [runId, bindingOf(db, runId)])
    const before = JSON.parse(bindingOf(db, 'run-review-ch60'))
    expect(Buffer.byteLength(bindingOf(db, 'run-review-ch60'))).toBeGreaterThan(65536)

    const opened = await reopen()
    expect(kept.map(([runId]) => [runId, bindingOf(opened, runId)])).toEqual(kept)
    expect(stillFull(opened)).toEqual(['run-review-ch61', 'run-review-ch62'])
    const after = JSON.parse(bindingOf(opened, 'run-review-ch60'))
    expect(readReviewProof(after.sourceManifest, sha256)).toMatchObject({ kind: 'sealed', contextHash: before.sourceManifest.reviewRevisionContextHash })
    const withoutProof = (binding: { sourceManifest: Record<string, unknown> }) => ({ ...binding, sourceManifest: Object.fromEntries(
      Object.entries(binding.sourceManifest).filter(([key]) => !['reviewRevisionContext', 'reviewRevisionContextHash', 'authorInputs'].includes(key))) })
    expect(withoutProof(after)).toEqual(withoutProof(before))
    expect(Object.keys(after)).toEqual(Object.keys(before))
    expect(savedProofs(opened).filter(item => !['run-review-ch61', 'run-review-ch62'].includes(item.runId))
      .every(item => item.proofKind === 'sealed')).toBe(true)
  })

  it('自洽、收据也对得上，但封存形缺字段的老证明不封：验不过的循环不因整理改变', { timeout: 120_000 }, async () => {
    const db = getProjectDb()!
    seedReviewedBook(db, 3, { firstChapter: 60, history: priorChapters })
    rewriteProof(db, 'run-review-ch60', context => { (context.config as Record<string, unknown>).wordsPerChapter = '三千' })
    rewriteProof(db, 'run-review-ch61', context => { delete context.config })
    const damaged = ['run-review-ch60', 'run-review-ch61']
    const kept = damaged.map(runId => [runId, bindingOf(db, runId)])
    const unprovable = inspectM03ReviewCycles(db).unprovable

    const opened = await reopen()
    expect(kept.map(([runId]) => [runId, bindingOf(opened, runId)])).toEqual(kept)
    expect(inspectM03ReviewCycles(opened).unprovable).toEqual(unprovable)
    expect(savedProofs(opened).filter(item => !damaged.includes(item.runId)).every(item => item.proofKind === 'sealed')).toBe(true)
  })

  it('自洽、收据也对得上，但 v1 才有的字段坏了的老证明不封：整理前后导出排除同一个循环', { timeout: 120_000 }, async () => {
    const db = getProjectDb()!
    seedReviewedBook(db, 3, { firstChapter: 60, history: priorChapters })
    db.prepare('UPDATE generation_roots SET budget_json=?').run(JSON.stringify({ maxPhysicalRequests: 1,
      maxTokenLiability: 100, maxOutputPerRequest: 100, maxActiveElapsedMs: 1000 }))
    // 封存会丢掉 history：整理前这个循环验不过、导出时排除，封了就成了验得过的。
    rewriteProof(db, 'run-review-ch61', context => { context.history = '前文' })
    const kept = bindingOf(db, 'run-review-ch61')
    const unprovable = inspectM03ReviewCycles(db).unprovable
    const omitted = (await exportAndRestore()).receipt.omittedReviewCycles
    expect(omitted?.length).toBe(1)

    const opened = await reopen()
    expect(bindingOf(opened, 'run-review-ch61')).toBe(kept)
    expect(inspectM03ReviewCycles(opened).unprovable).toEqual(unprovable)
    expect((await exportAndRestore()).receipt.omittedReviewCycles).toEqual(omitted)
  })

  it('库文件只读、整理写不进去：照常打开，书不变；能写之后下次打开再整理', { timeout: 120_000 }, async () => {
    const db = getProjectDb()!
    seedReviewedBook(db, 2, { firstChapter: 60, history: priorChapters })
    const bindings = db.prepare('SELECT binding_json FROM generation_runs ORDER BY run_id').pluck().all()
    closeProjectDatabase()
    fs.chmodSync(databaseFile(), 0o444)
    let verified: Awaited<ReturnType<typeof verifyCanonicalProjectData>>
    try { verified = await verifyCanonicalProjectData(projectRoot, worker) } finally { fs.chmodSync(databaseFile(), 0o644) }
    initProjectDatabase(projectRoot, verified)
    expect(getProjectDb()!.prepare('SELECT binding_json FROM generation_runs ORDER BY run_id').pluck().all()).toEqual(bindings)

    const opened = await reopen()
    expect(savedProofs(opened).map(item => item.proofKind)).toEqual(['sealed', 'sealed', 'sealed', 'sealed'])
  })
})
