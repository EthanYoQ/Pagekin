import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { breakReviewProof, seedReviewedBook } from '../../../test/helpers/review-cycle-fixture'
import { CANONICAL_PROJECT_DIRECTORY } from '../../../src/shared/project-format'
import { DraftRepository } from '../../repositories/draft-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { PostProcessRepository } from '../../repositories/post-process-repository'
import { ChapterDeletionService } from '../chapter-deletion-service'
import { exportPortableProject, type ExportPortableProjectInput } from '../project-archive-service'


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
const SQLITE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u

function reviewedBook({ finalized }: { finalized: boolean }) {
  const items = seedReviewedBook(db(), 2)
  db().prepare('UPDATE generation_roots SET budget_json=?').run(JSON.stringify({ maxPhysicalRequests: 1,
    maxTokenLiability: 100, maxOutputPerRequest: 100, maxActiveElapsedMs: 1000 }))
  db().prepare("INSERT INTO blueprints(chapter_number,title) VALUES(1,'雾钟'),(2,'沉船')").run()
  if (finalized) for (const item of items) finalize(item.seeded.draftId, item.seeded.chapterNumber)
  return items
}

function finalize(draftId: number, chapterNumber: number) {
  const content = db().prepare('SELECT c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?')
    .pluck().get(draftId) as string
  const record = FinalizationRepository.commit({ finalizationId: randomUUID(), draftId,
    chapterNumber, chapterTitle: TITLES[chapterNumber - 1]!, content, contentHash: sha256(content),
    contentRevision: 1, targetFileName: `第${chapterNumber}章.txt` })
  FinalizationRepository.linkKnowledgeDocument(draftId, `kb-${chapterNumber}-${draftId}`)
  const runId = PostProcessRepository.createRun({ triggerSourceType: 'chapter_finalize',
    triggerSourceId: String(chapterNumber), sourceLabel: '定稿',
    steps: [{ key: 'kb_import', label: '导入知识库', critical: true }],
    finalizedSource: { draftId, chapterNumber, finalizationId: record.finalizationId, contentHash: sha256(content) } })
  PostProcessRepository.markStepOk(runId, 'kb_import')
}

function replaceFinal(chapterNumber: number) {
  const reopened = FinalizationRepository.reopen({ chapterNumber })
  if (!reopened.success) throw new Error(reopened.error)
  finalize(reopened.draftId, chapterNumber)
  return reopened.draftId
}

function exportBook(): Promise<unknown> {
  const input: ExportPortableProjectInput = {
    sourceProjectRoot: projectRoot,
    projectSession: { projectId, projectPath: projectRoot, leaseId: 'lease' },
    targetArchivePath: path.join(base, `${randomUUID()}.ainovel`),
    attemptParentPath: base,
    assertCurrentContext: () => undefined,
    assets: { snapshot: () => ({ files: [], semanticCounts: { 'provided-assets': 0 }, omittedItems: [],
      transferReceiptIds: [], historyProjectionIds: [], verifyUnchanged: () => undefined }) },
  }
  return exportPortableProject(input).then(() => 'exported', (error: unknown) => error)
}

async function damagedOnExport() {
  const failure = await exportBook()
  expect(failure).toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED' })
  return (failure as { damagedReviewCycle?: unknown }).damagedReviewCycle
}

function trashService() {
  return new ChapterDeletionService({ createOperationId: randomUUID,
    cleaner: { async removeManuscript() {}, async removeKnowledgeDocument() {} },
    finalizations: { retry: async () => { throw new Error('UNUSED') } } })
}

describe('有一条坏审修循环的书导出失败时指明是哪一章，不给删除办法（#702）', () => {
  it('对照：两章都完好时照常导出', async () => {
    reviewedBook({ finalized: true })
    await expect(exportBook()).resolves.toBe('exported')
  })

  it('定稿章的循环坏了：只带出章号和标题', async () => {
    const items = reviewedBook({ finalized: true })
    breakReviewProof(db(), items[1]!)

    expect(await damagedOnExport()).toEqual({ chapterNumber: 2, chapterTitle: '沉船', location: 'manuscript' })
  })

  it('坏章已在回收站、同章号又写了新章：指向回收站那一项，用删除时的章名和删除时间', async () => {
    const items = reviewedBook({ finalized: true })
    breakReviewProof(db(), items[1]!)
    await expect(trashService().delete(projectRoot, { draftId: items[1]!.seeded.draftId, chapterNumber: 2 }))
      .resolves.toMatchObject({ success: true })
    db().prepare("UPDATE blueprints SET title='新航' WHERE chapter_number=2").run()
    DraftRepository.create({ chapterNumber: 2, source: 'write', content: '新写的第二章。', wordCount: 7 })

    expect(await damagedOnExport()).toEqual({ chapterNumber: 2, chapterTitle: '沉船', location: 'trash',
      deletedAt: expect.stringMatching(SQLITE_TIME) })
  })

  it('未定稿章的循环坏了：写明是哪一稿', async () => {
    const items = reviewedBook({ finalized: false })
    breakReviewProof(db(), items[1]!)

    expect(await damagedOnExport()).toEqual({ chapterNumber: 2, chapterTitle: '沉船', location: 'draft', draftVersion: 1 })
  })

  it('坏的是较旧的一稿：写明是较旧那一版', async () => {
    const items = reviewedBook({ finalized: false })
    breakReviewProof(db(), items[1]!)
    const newer = DraftRepository.create({ chapterNumber: 2, source: 'rewrite', content: '较新的一稿。', wordCount: 6 })
    const damagedVersion = DraftRepository.getMeta(items[1]!.seeded.draftId)!.version
    expect(DraftRepository.getMeta(newer)!.version).toBeGreaterThan(damagedVersion)

    expect(await damagedOnExport()).toEqual({ chapterNumber: 2, chapterTitle: '沉船', location: 'draft', draftVersion: damagedVersion })
  })

  it('定稿换成新的一版后旧定稿坏了：写明是旧的那一版', async () => {
    const items = reviewedBook({ finalized: true })
    breakReviewProof(db(), items[1]!)
    replaceFinal(2)

    expect(await damagedOnExport()).toEqual({ chapterNumber: 2, chapterTitle: '沉船', location: 'draft',
      draftVersion: DraftRepository.getMeta(items[1]!.seeded.draftId)!.version })
  })

  it('回收站里旧定稿与定稿两行的删除时间不同：时间和章名都按回收站列出的定稿那一行', async () => {
    const items = reviewedBook({ finalized: true })
    breakReviewProof(db(), items[1]!)
    const newer = replaceFinal(2)
    await expect(trashService().delete(projectRoot, { draftId: newer, chapterNumber: 2 }))
      .resolves.toMatchObject({ success: true })
    db().prepare("UPDATE drafts_all SET deleted_at='2001-01-01 09:05:00' WHERE id=?").run(items[1]!.seeded.draftId)
    const finalDeletedAt = db().prepare('SELECT deleted_at FROM drafts_all WHERE id=?').pluck().get(newer) as string
    expect(finalDeletedAt).toMatch(SQLITE_TIME)
    expect(finalDeletedAt).not.toBe('2001-01-01 09:05:00')

    expect(await damagedOnExport()).toEqual({ chapterNumber: 2, chapterTitle: '沉船', location: 'trash', deletedAt: finalDeletedAt })
  })

  it('删掉了蓝图但定稿还在：用定稿记下的章名', async () => {
    const items = reviewedBook({ finalized: true })
    breakReviewProof(db(), items[1]!)
    db().prepare('DELETE FROM blueprints WHERE chapter_number=2').run()

    expect(await damagedOnExport()).toEqual({ chapterNumber: 2, chapterTitle: '沉船', location: 'manuscript' })
  })

  it.each([
    ['缺字段', '{}'],
    ['读不出', '{broken'],
  ])('循环引用的生成记录%s：照样带出章号和标题', async (_label, actionJson) => {
    const items = reviewedBook({ finalized: true })
    db().prepare('UPDATE generation_roots SET action_json=? WHERE root_action_id=?').run(actionJson, items[1]!.seeded.call.rootActionId)

    expect(await damagedOnExport()).toEqual({ chapterNumber: 2, chapterTitle: '沉船', location: 'manuscript' })
  })
})
