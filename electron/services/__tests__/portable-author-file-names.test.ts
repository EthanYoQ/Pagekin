import fs from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, initProjectDatabase } from '../../database'
import { importText } from '../../knowledge-base'
import { closeConnection, listDocuments } from '../../vector-store'
import { FinalizationService } from '../finalization-service'
import { resolveManuscriptTarget } from '../manuscript-publisher'
import { createProjectArchiveRoundtripFixture, type ProjectArchiveRoundtripFixture } from '../../../test/desktop/project-archive.fixture'

const Sqlite = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

let fixture: ProjectArchiveRoundtripFixture | undefined
afterEach(() => {
  if (fixture) closeConnection(fixture.targetRoot)
  fixture?.dispose()
  fixture = undefined
})

function sourceDb<T>(f: ProjectArchiveRoundtripFixture, write: (db: InstanceType<typeof Sqlite>) => T): T {
  const db = new Sqlite(f.sourceDatabasePath)
  try { return write(db) } finally { db.close() }
}

/** 定稿时稿件名由 resolveManuscriptTarget 按标题生成，知识库文档名按定稿后处理的写法拼。 */
async function finalizeChapter20As(f: ProjectArchiveRoundtripFixture, title: string): Promise<{ manuscript: string; knowledge: string }> {
  const manuscript = resolveManuscriptTarget({ projectRoot: f.sourceRoot, chapterNumber: 20, chapterTitle: title,
    finalizationId: f.chapter20FinalizationId, reserved: new Set() }).fileName
  sourceDb(f, db => db.prepare('UPDATE finalization_outbox_all SET chapter_title=?, target_file_name=? WHERE finalization_id=?')
    .run(title, manuscript, f.chapter20FinalizationId))
  const knowledge = `第20章 ${title}.txt`
  initProjectDatabase(f.sourceRoot)
  try {
    const imported = await importText(f.chapter20Body, knowledge, f.sourceRoot, 'openai',
      { provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', modelName: 'none' }, { mode: 'fts-only' })
    expect(imported.success).toBe(true)
  } finally { closeProjectDatabase(); closeConnection(f.sourceRoot) }
  return { manuscript, knowledge }
}

async function refinalizeChapter20InRestoredBook(f: ProjectArchiveRoundtripFixture, title: string) {
  f.reopenRestoredProject()
  const replacement = f.prepareChapter20Replacement(f.restoredDatabase())
  return new FinalizationService().finalize({ projectRoot: f.targetRoot, draftId: replacement.draftId, chapterNumber: 20,
    chapterTitle: title, content: replacement.body, contentRevision: 1 })
}

describe('作者标题里的标点不挡存档（#723）', () => {
  for (const title of ['为什么？', '真相：开始', '全角＼＊＜＞｜＂', '半角?问号']) {
    it(`标题「${title}」：能导出、能恢复，恢复后的书能重新发布这一章`, async () => {
      fixture = await createProjectArchiveRoundtripFixture()
      const { manuscript, knowledge } = await finalizeChapter20As(fixture, title)

      await fixture.exportAndRestore()

      const restored = new Sqlite(fixture.targetDatabasePath, { readonly: true })
      try {
        expect(restored.prepare('SELECT target_file_name FROM finalization_outbox WHERE finalization_id=?').pluck()
          .get(fixture.chapter20FinalizationId)).toBe(manuscript)
      } finally { restored.close() }
      const published = await refinalizeChapter20InRestoredBook(fixture, title)
      expect(published).toMatchObject({ success: true, publicationStatus: 'published' })
      expect(fs.readdirSync(fixture.targetRoot)).toContain(manuscript)
      expect((await listDocuments(fixture.targetRoot)).map(document => document.fileName)).toContain(knowledge)
    })
  }

  it('删除收据没有稿件名（被取代的旧稿）：能导出、能恢复', async () => {
    fixture = await createProjectArchiveRoundtripFixture()
    sourceDb(fixture, db => db.prepare(`INSERT INTO chapter_deletion_operations(operation_id,draft_id,chapter_number,chapter_title,
      finalization_id,target_file_name,knowledge_document_id,post_process_run_ids,manuscript_status,knowledge_status,status,completed_at)
      VALUES('superseded-old',120,20,'','','','','[]','not_required','not_required','completed',datetime('now'))`).run())

    await fixture.exportAndRestore()

    const restored = new Sqlite(fixture.targetDatabasePath, { readonly: true })
    try {
      expect(restored.prepare("SELECT target_file_name FROM chapter_deletion_operations WHERE operation_id='superseded-old'").pluck().get()).toBe('')
    } finally { restored.close() }
    expect(await refinalizeChapter20InRestoredBook(fixture, '新的第二十章')).toMatchObject({ success: true, publicationStatus: 'published' })
  })

  for (const unsafe of ['../outside.txt', '子目录/第1章.txt', '子目录\\第1章.txt', 'C:outside.txt', '..', '.', '第1章\u0001.txt', 'CON.txt', 'nul']) {
    it(`库里的稿件名 ${JSON.stringify(unsafe)} 不是项目根下的一个文件：照旧拒绝导出`, async () => {
      fixture = await createProjectArchiveRoundtripFixture()
      sourceDb(fixture, db => db.prepare('UPDATE finalization_outbox_all SET target_file_name=? WHERE finalization_id=?')
        .run(unsafe, fixture!.chapter20FinalizationId))

      await expect(fixture.exportArchive()).rejects.toThrow('PORTABLE_PATH_UNSAFE')
      expect(fs.existsSync(fixture.archivePath)).toBe(false)
    })
  }
})
