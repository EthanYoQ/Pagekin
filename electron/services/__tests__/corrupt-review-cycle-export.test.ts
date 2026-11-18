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

// #702：导出、备份仍跑全书审修循环校验。失败时错误码不变，带出第一条坏循环所在的章，以及作者删掉哪一稿能让导出通过。

let base = ''
let projectRoot = ''
let projectId = ''

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const db = () => getProjectDb()!

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'corrupt-cycle-'))
  projectRoot = path.join(base, 'book')
  fs.mkdirSync(projectRoot)
  openCanonicalProjectFixture(projectRoot)
  projectId = JSON.parse(fs.readFileSync(path.join(projectRoot, CANONICAL_PROJECT_DIRECTORY, 'project.json'), 'utf8')).projectId
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(base, { recursive: true, force: true })
})

/** 第 1、2 章各有一条已合并的审修循环；finalized 时两章都已定稿。 */
function reviewedBook({ finalized }: { finalized: boolean }) {
  const items = seedReviewedBook(db(), 2)
  db().prepare('UPDATE generation_roots SET budget_json=?').run(JSON.stringify({ maxPhysicalRequests: 1,
    maxTokenLiability: 100, maxOutputPerRequest: 100, maxActiveElapsedMs: 1000 }))
  db().prepare("INSERT INTO blueprints(chapter_number,title) VALUES(1,'雾钟'),(2,'沉船')").run()
  if (finalized) for (const item of items) {
    const content = db().prepare('SELECT c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?')
      .pluck().get(item.seeded.draftId) as string
    const record = FinalizationRepository.commit({ finalizationId: randomUUID(), draftId: item.seeded.draftId,
      chapterNumber: item.seeded.chapterNumber, chapterTitle: '', content, contentHash: sha256(content),
      contentRevision: 1, targetFileName: `第${item.seeded.chapterNumber}章.txt` })
    FinalizationRepository.linkKnowledgeDocument(item.seeded.draftId, `kb-${item.seeded.chapterNumber}`)
    const runId = PostProcessRepository.createRun({ triggerSourceType: 'chapter_finalize',
      triggerSourceId: String(item.seeded.chapterNumber), sourceLabel: '定稿',
      steps: [{ key: 'kb_import', label: '导入知识库', critical: true }],
      finalizedSource: { draftId: item.seeded.draftId, chapterNumber: item.seeded.chapterNumber,
        finalizationId: record.finalizationId, contentHash: sha256(content) } })
    PostProcessRepository.markStepOk(runId, 'kb_import')
  }
  return items
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

function trashService() {
  return new ChapterDeletionService({ createOperationId: randomUUID,
    cleaner: { async removeManuscript() {}, async removeKnowledgeDocument() {} },
    finalizations: { retry: async () => { throw new Error('UNUSED') } } })
}

describe('有一条坏审修循环的书导出失败时指明是哪一章（#702）', () => {
  it('对照：两章都完好时照常导出', async () => {
    reviewedBook({ finalized: true })
    await expect(exportBook()).resolves.toBe('exported')
  })

  it('定稿章的循环坏了：带出章号、标题，删除正文并彻底删除后能导出，只移到回收站不够', async () => {
    const items = reviewedBook({ finalized: true })
    breakReviewProof(db(), items[1]!)

    const failure = await exportBook()
    expect(failure).toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED',
      damagedReviewCycle: { chapterNumber: 2, chapterTitle: '沉船', remedy: 'delete-manuscript' } })

    const trash = trashService()
    await expect(trash.delete(projectRoot, { draftId: items[1]!.seeded.draftId, chapterNumber: 2 }))
      .resolves.toMatchObject({ success: true })
    await expect(exportBook()).resolves.toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED',
      damagedReviewCycle: { chapterNumber: 2, remedy: 'delete-manuscript' } })
    await expect(trash.purge(projectRoot, { all: true })).resolves.toMatchObject({ success: true })
    await expect(exportBook()).resolves.toBe('exported')
  })

  it('未定稿章的循环坏了：删除这一稿后能导出', async () => {
    const items = reviewedBook({ finalized: false })
    breakReviewProof(db(), items[1]!)

    await expect(exportBook()).resolves.toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED',
      damagedReviewCycle: { chapterNumber: 2, chapterTitle: '沉船', remedy: 'delete-draft' } })

    DraftRepository.delete(items[1]!.seeded.draftId)
    await expect(exportBook()).resolves.toBe('exported')
  })

  it('循环引用的生成记录读不出：带出章号，但不给删章的办法，删了章也导不出', async () => {
    const items = reviewedBook({ finalized: true })
    db().prepare('UPDATE generation_roots SET action_json=? WHERE root_action_id=?').run('{broken', items[1]!.seeded.call.rootActionId)

    await expect(exportBook()).resolves.toMatchObject({ code: 'MIGRATION_VERIFICATION_FAILED',
      damagedReviewCycle: { chapterNumber: 2, chapterTitle: '沉船', remedy: null } })

    const trash = trashService()
    await trash.delete(projectRoot, { draftId: items[1]!.seeded.draftId, chapterNumber: 2 })
    await trash.purge(projectRoot, { all: true })
    await expect(exportBook()).resolves.toMatchObject({ code: 'PORTABLE_UNSAFE_PROJECTION' })
  })
})
