import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createRequire } from 'node:module'
import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { inspectM03ReviewCycles, unprovableReviewCycleIds } from '../../migrations/m03-review-cycle'
import { createMigrationRegistry, type SchemaWriter } from '../../migrations/registry'
import { verifySchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { extractPortableProjectArchive } from '../portable-project-archive'
import { ProjectPeekService } from '../project-peek'
import { restorePortableProject } from '../project-restore-service'
import { readSqliteContentIdentity, upgradeProjectSqlite } from '../sqlite-project-migration'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { breakReviewProof, seedReviewedBook } from '../../../test/helpers/review-cycle-fixture'
import { CANONICAL_PROJECT_DATABASE, CANONICAL_PROJECT_DIRECTORY } from '../../../src/shared/project-format'
import { DraftRepository } from '../../repositories/draft-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { PostProcessRepository } from '../../repositories/post-process-repository'
import { ChapterDeletionService } from '../chapter-deletion-service'
import { exportPortableProject, type ExportPortableProjectInput } from '../project-archive-service'


const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

let base = ''
let projectRoot = ''
let projectId = ''

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const db = () => getProjectDb()!

beforeEach(() => {
  base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'corrupt-cycle-'))
  projectRoot = path.join(base, 'book')
  fs.mkdirSync(projectRoot)
  openCanonicalProjectFixture(projectRoot)
  projectId = JSON.parse(fs.readFileSync(path.join(projectRoot, CANONICAL_PROJECT_DIRECTORY, 'project.json'), 'utf8')).projectId
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(base, { recursive: true, force: true })
})

const TITLES = ['雾钟', '沉船']

function reviewedBook({ finalized }: { finalized: boolean }) {
  const items = seedReviewedBook(db(), 2)
  db().prepare('UPDATE generation_roots SET budget_json=?').run(JSON.stringify({ maxPhysicalRequests: 1,
    maxTokenLiability: 100, maxOutputPerRequest: 100, maxActiveElapsedMs: 1000 }))
  db().prepare("INSERT INTO blueprints(chapter_number,title) VALUES(1,'雾钟'),(2,'沉船')").run()
  if (finalized) for (const item of items) finalize(item.seeded.draftId, item.seeded.chapterNumber)
  return items
}

function finalize(draftId: number, chapterNumber: number, chapterTitle = TITLES[chapterNumber - 1]!) {
  const content = db().prepare('SELECT c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?')
    .pluck().get(draftId) as string
  const record = FinalizationRepository.commit({ finalizationId: randomUUID(), draftId,
    chapterNumber, chapterTitle, content, contentHash: sha256(content),
    contentRevision: 1, targetFileName: `第${chapterNumber}章.txt` })
  FinalizationRepository.linkKnowledgeDocument(draftId, `kb-${chapterNumber}-${draftId}`)
  const runId = PostProcessRepository.createRun({ triggerSourceType: 'chapter_finalize',
    triggerSourceId: String(chapterNumber), sourceLabel: '定稿',
    steps: [{ key: 'kb_import', label: '导入知识库', critical: true }],
    finalizedSource: { draftId, chapterNumber, finalizationId: record.finalizationId, contentHash: sha256(content) } })
  PostProcessRepository.markStepOk(runId, 'kb_import')
}

function exportInput(): ExportPortableProjectInput {
  return {
    sourceProjectRoot: projectRoot,
    projectSession: { projectId, projectPath: projectRoot, leaseId: 'lease' },
    targetArchivePath: path.join(base, `${randomUUID()}.ainovel`),
    attemptParentPath: base,
    assertCurrentContext: () => undefined,
    assets: { snapshot: () => ({ files: [], semanticCounts: { 'provided-assets': 0 }, omittedItems: [],
      transferReceiptIds: [], historyProjectionIds: [], verifyUnchanged: () => undefined }) },
  }
}

function exportBook(): Promise<unknown> {
  return exportPortableProject(exportInput()).then(() => 'exported', (error: unknown) => error)
}

async function omittedOnExport() {
  return (await exportPortableProject(exportInput())).omittedReviewCycles
}

const UNLOCATED = { chapterNumber: null, chapterTitle: '', inTrash: false }
const databasePath = () => path.join(projectRoot, CANONICAL_PROJECT_DIRECTORY, CANONICAL_PROJECT_DATABASE)
const cycleOf = (item: { seeded: { reviewId: number } }) =>
  db().prepare('SELECT cycle_id FROM review_cycles WHERE review_id=?').pluck().get(item.seeded.reviewId) as string

/** 存档里 project.db 的全部表，逐行。 */
async function archiveRows(archivePath: string): Promise<Record<string, Array<Record<string, unknown>>>> {
  const { stagingPath } = await extractPortableProjectArchive({ archivePath, stagingParentPath: fs.mkdtempSync(path.join(base, 'unpack-')) })
  const archived = new Database(path.join(stagingPath, CANONICAL_PROJECT_DATABASE), { readonly: true })
  try {
    const tables = archived.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all() as string[]
    return Object.fromEntries(tables.map(table => [table, archived.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Array<Record<string, unknown>>]))
  } finally { archived.close() }
}

/** 导出到新路径，返回存档路径和结果。 */
async function exportTo(): Promise<{ archivePath: string; receipt: Awaited<ReturnType<typeof exportPortableProject>> }> {
  const input = exportInput()
  return { archivePath: input.targetArchivePath, receipt: await exportPortableProject(input) }
}

function trashService() {
  return new ChapterDeletionService({ createOperationId: randomUUID,
    cleaner: { async removeManuscript() {}, async removeKnowledgeDocument() {} },
    finalizations: { retry: async () => { throw new Error('UNUSED') } } })
}

function reopen() {
  closeProjectDatabase()
  initProjectDatabase(projectRoot)
}

const verifyWholeBook = () => verifySchema(new SqliteSchemaAdapter(db()), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)

describe('M03 只把提供证据的尝试被换成占位算作坏循环（ADR-0030，#702）', () => {
  it('同一根下没提供证据的尝试读不出：封存后这条循环照常验得过，导出不受影响', async () => {
    reviewedBook({ finalized: true })
    db().prepare(`INSERT INTO generation_attempts(attempt_id,reservation_id,run_id,root_action_id,attempt_json,usage_receipt_json,invocation_nonce)
      SELECT 'attempt-extra','reservation-extra',run_id,root_action_id,
        json_set(attempt_json,'$.attemptId','attempt-extra','$.reservationId','reservation-extra'),'[]','invocation-extra'
      FROM generation_attempts WHERE attempt_id='attempt-review-ch2'`).run()
    reopen()
    expect(db().prepare("SELECT blocked_code FROM generation_roots WHERE root_action_id='root-review-ch2'").pluck().get())
      .toBe('GENERATION_LEDGER_UNREADABLE')

    expect(verifyWholeBook).not.toThrow()
    const receipt = await exportPortableProject(exportInput())
    expect(receipt).not.toHaveProperty('omittedReviewCycles')
  })

  it.each([
    ['审稿尝试', 'attempt-review-ch2'],
    ['修稿尝试', 'attempt-revision-ch2'],
  ])('%s的 attempt_json 读不出：封存成占位后不能当证据', (_label, attemptId) => {
    reviewedBook({ finalized: true })
    verifyWholeBook()
    db().prepare("UPDATE generation_attempts SET attempt_json='{坏' WHERE attempt_id=?").run(attemptId)
    reopen()

    expect(verifyWholeBook).toThrow('MIGRATION_VERIFICATION_FAILED')
  })
})

describe('有坏审修循环的书照常导出，坏循环留在存档外并指明章节（ADR-0029，#702）', () => {
  it('对照：两章都完好时照常导出，结果里没有省略清单', async () => {
    reviewedBook({ finalized: true })
    expect(await exportPortableProject(exportInput())).not.toHaveProperty('omittedReviewCycles')
  })

  it('定稿章的循环坏了：导出成功、源库不变，存档里只少这条循环的证据行，其余逐行与先删掉这条循环的同一本书一致', async () => {
    const items = reviewedBook({ finalized: true })
    breakReviewProof(db(), items[1]!)
    const cycleId = cycleOf(items[1]!)
    const before = readSqliteContentIdentity(databasePath())

    const damaged = await exportTo()
    expect(readSqliteContentIdentity(databasePath())).toEqual(before)
    expect(damaged.receipt.omittedReviewCycles).toEqual([{ chapterNumber: 2, chapterTitle: '沉船', inTrash: false }])
    const archived = await archiveRows(damaged.archivePath)
    expect(archived.review_cycles!.map(row => row.cycle_id)).toEqual([cycleOf(items[0]!)])
    expect(archived.review_findings!.filter(row => row.cycle_id === cycleId)).toEqual([])
    expect(archived.review_cycle_merges!.filter(row => row.cycle_id === cycleId)).toEqual([])
    expect(db().prepare('SELECT COUNT(*) FROM review_cycle_merges WHERE cycle_id=?').pluck().get(cycleId)).toBe(1)

    db().prepare('DELETE FROM review_cycles WHERE cycle_id=?').run(cycleId)
    const twin = await exportTo()
    expect(twin.receipt).not.toHaveProperty('omittedReviewCycles')
    expect(archived).toEqual(await archiveRows(twin.archivePath))
  })

  it('往返：这份存档恢复成新书，新书里没有坏循环，另一章的循环照常', async () => {
    const items = reviewedBook({ finalized: true })
    breakReviewProof(db(), items[1]!)
    const { archivePath } = await exportTo()
    const restoredRoot = path.join(base, 'restored')

    await restorePortableProject({ archivePath, targetProjectRoot: restoredRoot })
    const restored = new Database(path.join(restoredRoot, CANONICAL_PROJECT_DIRECTORY, CANONICAL_PROJECT_DATABASE), { readonly: true })
    try {
      restored.pragma('foreign_keys = ON')
      expect(inspectM03ReviewCycles(restored)).toEqual({ structureOk: true, unprovable: [] })
      expect(restored.prepare('SELECT COUNT(*) FROM review_cycles').pluck().get()).toBe(1)
    } finally { restored.close() }
  })

  it('去掉坏循环仍过不了投影：照旧失败，带出 #739 的章节提示，源库不变', async () => {
    const items = reviewedBook({ finalized: true })
    breakReviewProof(db(), items[1]!)
    db().prepare("UPDATE generation_roots SET budget_json='{}' WHERE root_action_id=?").run(items[1]!.seeded.call.rootActionId)
    const before = readSqliteContentIdentity(databasePath())

    expect(await exportBook()).toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED',
      damagedReviewCycle: { chapterNumber: 2, chapterTitle: '沉船', inTrash: false } })
    expect(readSqliteContentIdentity(databasePath())).toEqual(before)
  })

  it('两章各有一条坏循环：两条都留在存档外，清单两章都列', async () => {
    const items = reviewedBook({ finalized: true })
    for (const item of items) breakReviewProof(db(), item)

    const { archivePath, receipt } = await exportTo()
    expect(receipt.omittedReviewCycles).toHaveLength(2)
    expect(receipt.omittedReviewCycles).toEqual(expect.arrayContaining([
      { chapterNumber: 1, chapterTitle: '雾钟', inTrash: false },
      { chapterNumber: 2, chapterTitle: '沉船', inTrash: false },
    ]))
    expect((await archiveRows(archivePath)).review_cycles).toEqual([])
  })

  it('坏章已在回收站、同章号又写了新章：标明在回收站，用它自己定稿时的章名', async () => {
    const items = reviewedBook({ finalized: true })
    breakReviewProof(db(), items[1]!)
    await expect(trashService().delete(projectRoot, { draftId: items[1]!.seeded.draftId, chapterNumber: 2 }))
      .resolves.toMatchObject({ success: true })
    db().prepare("UPDATE blueprints SET title='新航' WHERE chapter_number=2").run()
    DraftRepository.create({ chapterNumber: 2, source: 'write', content: '新写的第二章。', wordCount: 7 })

    expect(await omittedOnExport()).toEqual([{ chapterNumber: 2, chapterTitle: '沉船', inTrash: true }])
  })

  it('回收站删除组里混进了别章的定稿：只看这一稿自己，不借别章的章名（D5）', async () => {
    const items = reviewedBook({ finalized: true })
    breakReviewProof(db(), items[1]!)
    const trash = trashService()
    for (const item of items) await expect(trash.delete(projectRoot, { draftId: item.seeded.draftId, chapterNumber: item.seeded.chapterNumber }))
      .resolves.toMatchObject({ success: true })
    db().prepare('UPDATE drafts_all SET deletion_id=(SELECT deletion_id FROM drafts_all WHERE id=?) WHERE id=?')
      .run(items[0]!.seeded.draftId, items[1]!.seeded.draftId)

    expect(await omittedOnExport()).toEqual([{ chapterNumber: 2, chapterTitle: '沉船', inTrash: true }])
  })

  it('未定稿章的循环坏了：报章号和蓝图章名，不报稿的版本', async () => {
    const items = reviewedBook({ finalized: false })
    breakReviewProof(db(), items[1]!)

    expect(await omittedOnExport()).toEqual([{ chapterNumber: 2, chapterTitle: '沉船', inTrash: false }])
  })

  it('删掉了蓝图但定稿还在：用定稿记下的章名', async () => {
    const items = reviewedBook({ finalized: true })
    breakReviewProof(db(), items[1]!)
    db().prepare('DELETE FROM blueprints WHERE chapter_number=2').run()

    expect(await omittedOnExport()).toEqual([{ chapterNumber: 2, chapterTitle: '沉船', inTrash: false }])
  })

  it('坏审稿挂到了别章的稿上：对不上审稿记下的章号，不报章节', async () => {
    const items = reviewedBook({ finalized: false })
    db().prepare('UPDATE reviews SET base_draft_id=?, review_index=99 WHERE id=?').run(items[0]!.seeded.draftId, items[1]!.seeded.reviewId)

    expect(await omittedOnExport()).toEqual([UNLOCATED])
  })

  it('循环的 review_id 改指别章的审稿：证据指向的不是这次审稿，不报章节（D1）', async () => {
    const items = reviewedBook({ finalized: true })
    const other = db().prepare('SELECT id FROM reviews WHERE base_draft_id=? AND id NOT IN (SELECT review_id FROM review_cycles) ORDER BY id LIMIT 1')
      .pluck().get(items[0]!.seeded.draftId) as number
    expect(other).toEqual(expect.any(Number))
    db().prepare('UPDATE review_cycles SET review_id=? WHERE review_id=?').run(other, items[1]!.seeded.reviewId)

    expect(await omittedOnExport()).toEqual([UNLOCATED])
  })

  it('审稿记下的稿版本与冻结的来源对不上：不报章节（D4）', async () => {
    const items = reviewedBook({ finalized: false })
    db().prepare('UPDATE reviews SET source_draft_version=source_draft_version+1 WHERE id=?').run(items[1]!.seeded.reviewId)

    expect(await omittedOnExport()).toEqual([UNLOCATED])
  })

  it('循环引用的根读不出：打开作品时封存，导出时这条循环留在存档外，照样带出章号和标题', async () => {
    const items = reviewedBook({ finalized: true })
    db().prepare("UPDATE generation_roots SET action_json='{broken' WHERE root_action_id=?").run(items[1]!.seeded.call.rootActionId)
    reopen()

    expect(await omittedOnExport()).toEqual([{ chapterNumber: 2, chapterTitle: '沉船', inTrash: false }])
  })

  it('循环引用的根缺字段：去掉循环仍过不了投影，照旧失败并带出章号和标题', async () => {
    const items = reviewedBook({ finalized: true })
    db().prepare("UPDATE generation_roots SET action_json='{}' WHERE root_action_id=?").run(items[1]!.seeded.call.rootActionId)

    expect(await exportBook()).toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED',
      damagedReviewCycle: { chapterNumber: 2, chapterTitle: '沉船', inTrash: false } })
  })
})

describe('升级通道放行已有的坏循环，不放行新弄坏的（ADR-0029，#702）', () => {
  /** 拆掉 M09 建的表，让这本书回到 v9，再走真实的 v9→v10 升级。 */
  function downgradeToV9() {
    closeProjectDatabase()
    const raw = new Database(databasePath())
    try {
      raw.exec('DROP INDEX idx_annotation_history_draft; DROP TABLE annotation_history')
      raw.pragma('user_version = 9')
    } finally { raw.close() }
  }

  it('有坏循环的 v9 书打开时升级成功，验不过的循环集合不变', () => {
    const items = reviewedBook({ finalized: true })
    breakReviewProof(db(), items[1]!)
    const before = [...unprovableReviewCycleIds(db())]
    expect(before).toEqual([cycleOf(items[1]!)])
    downgradeToV9()

    initProjectDatabase(projectRoot)
    expect(db().pragma('user_version', { simple: true })).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
    expect([...unprovableReviewCycleIds(db())]).toEqual(before)
  })

  it('迁移弄坏了原本好的循环：升级被拒绝，带出新弄坏的那一章，书停在原版本', () => {
    const items = reviewedBook({ finalized: true })
    breakReviewProof(db(), items[1]!)
    downgradeToV9()
    const desktop = getDesktopMigrationRegistry()
    const registry = createMigrationRegistry(desktop.implementations.map(step => step.id !== 'M09' ? step : {
      ...step,
      migrate(reader: SchemaWriter) {
        step.migrate(reader)
        breakReviewProof((reader as SqliteSchemaAdapter).database, items[0]!)
      },
    }), desktop.recognizedSchemas)

    expect(() => upgradeProjectSqlite({ databasePath: databasePath(), registry, evidence: 'no-new-failures' }))
      .toThrow(expect.objectContaining({ code: 'MIGRATION_VERIFICATION_FAILED',
        damagedReviewCycle: { chapterNumber: 1, chapterTitle: '雾钟', inTrash: false } }))
    const raw = new Database(databasePath(), { readonly: true })
    try { expect(raw.pragma('user_version', { simple: true })).toBe(9) } finally { raw.close() }
  })

  it.each([
    ['当前版本', false],
    ['v9', true],
  ])('书库卡片读有坏循环的%s书：照常显示', (_label, older) => {
    const items = reviewedBook({ finalized: true })
    breakReviewProof(db(), items[1]!)
    db().prepare("INSERT INTO project_core(id,project_name) VALUES('main','雾港')").run()
    if (older) downgradeToV9()
    else closeProjectDatabase()
    const service = new ProjectPeekService({ scratchRoot: path.join(base, 'peek') })
    const capability = service.issueCapability(projectRoot)!

    expect(service.peek(capability.capabilityId)).toMatchObject({ state: 'ready', finalizedChapters: 2 })
  })
})
