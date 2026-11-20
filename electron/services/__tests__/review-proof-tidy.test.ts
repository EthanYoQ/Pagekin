import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { verifyCanonicalProjectData } from '../project-data-locator'
import type { ProjectSqliteWorkerOptions } from '../project-sqlite-host'
import { sealSavedReviewProofs } from '../review-proof-tidy'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { projectSqliteWorkerForTest } from '../../../test/helpers/portable-export-worker'
import { seedReviewedBook } from '../../../test/helpers/review-cycle-fixture'
import { CANONICAL_PROJECT_DATABASE, CANONICAL_PROJECT_DIRECTORY } from '../../../src/shared/project-format'
import type { ReviewFinalizedMaterial } from '../../../src/shared/review-revision-generation'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

let worker: ProjectSqliteWorkerOptions
beforeAll(async () => { worker = await projectSqliteWorkerForTest() }, 60_000)

let base = ''
let book = ''
let twin = ''
const databaseFile = (root: string) => path.join(root, CANONICAL_PROJECT_DIRECTORY, CANONICAL_PROJECT_DATABASE)
const prose = (chapter: number) => `第${chapter}章。` + '林岚走进北塔，灯火照亮了石阶。'.repeat(40)
const priorChapters = (chapter: number): ReviewFinalizedMaterial[] => Array.from({ length: chapter - 1 }, (_, index) => ({
  draftId: 10_000 + index, chapterNumber: index + 1, chapterTitle: `第${index + 1}章`, content: prose(index + 1) }))

/** 同一本老书的两份副本：一份被打断后再打开，一份一次做完。 */
beforeEach(() => {
  base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'proof-tidy-resume-'))
  book = path.join(base, 'book')
  fs.mkdirSync(book)
  openCanonicalProjectFixture(book)
  seedReviewedBook(getProjectDb()!, 4, { firstChapter: 60, history: priorChapters })
  closeProjectDatabase()
  twin = path.join(base, 'twin')
  fs.cpSync(book, twin, { recursive: true })
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(base, { recursive: true, force: true })
})

/** 打开并整理一次再关闭，返回全部绑定与关库后的文件字节数。 */
async function openOnce(root: string) {
  initProjectDatabase(root, await verifyCanonicalProjectData(root, worker))
  const bindings = getProjectDb()!.prepare('SELECT run_id,binding_json FROM generation_runs ORDER BY run_id').all()
  closeProjectDatabase()
  return { bindings, bytes: fs.statSync(databaseFile(root)).size }
}

it('逐行改写到一半出错：再打开一次，结果与一次做完的副本逐字相同、文件一样大', { timeout: 120_000 }, async () => {
  const interrupted = new Database(databaseFile(book))
  try {
    interrupted.exec(`CREATE TEMP TRIGGER interrupt BEFORE UPDATE OF binding_json ON generation_runs
      WHEN NEW.run_id='run-review-ch62' BEGIN SELECT RAISE(ABORT,'整理到一半被打断'); END`)
    expect(() => sealSavedReviewProofs(interrupted)).toThrow('整理到一半被打断')
  } finally { interrupted.close() }

  const resumed = await openOnce(book)
  expect(resumed).toEqual(await openOnce(twin))
})

it('还没进门的坏记录（读不出的绑定、读不出的收据）原样跳过，不挡其余行', { timeout: 120_000 }, () => {
  const db = new Database(databaseFile(book))
  try {
    db.prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=?').run(`{${'坏'.repeat(30_000)}`, 'run-review-ch60')
    db.prepare(`UPDATE generation_attempts SET usage_receipt_json='{坏' WHERE run_id='run-review-ch61'`).run()
    const broken = db.prepare(`SELECT run_id,binding_json FROM generation_runs WHERE run_id IN ('run-review-ch60','run-review-ch61') ORDER BY run_id`).all()
    expect(sealSavedReviewProofs(db)).toBe(6)
    expect(db.prepare(`SELECT run_id,binding_json FROM generation_runs WHERE run_id IN ('run-review-ch60','run-review-ch61') ORDER BY run_id`).all()).toEqual(broken)
  } finally { db.close() }
})

it('rowid 超过 2^53：封存写回本行，不落到相邻的行', () => {
  const db = new Database(databaseFile(book))
  try {
    db.exec(`UPDATE generation_runs SET rowid=9007199254740993 WHERE run_id='run-review-ch60'`)
    db.exec(`INSERT INTO generation_runs(rowid,run_id,root_action_id,binding_json,status,created_at_ms,open_key)
      SELECT 9007199254740992,'run-unsaved-ch60',root_action_id,binding_json,status,3,'open-unsaved-ch60' FROM generation_runs WHERE run_id='run-review-ch60'`)
    const binding = (runId: string) => db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(runId) as string
    const unsaved = binding('run-unsaved-ch60')
    expect(sealSavedReviewProofs(db)).toBe(8)
    expect(binding('run-unsaved-ch60')).toBe(unsaved)
    expect(binding('run-review-ch60')).not.toBe(unsaved)
  } finally { db.close() }
})

it('上次没正常关、WAL 里留着已提交的帧：已整理过的书照常打开', { timeout: 120_000 }, async () => {
  await openOnce(book)
  const file = databaseFile(book), before = fs.readFileSync(file)
  const writer = new Database(file)
  let wal: Buffer
  try {
    writer.pragma('wal_autocheckpoint=0')
    writer.prepare(`UPDATE generation_runs SET created_at_ms=created_at_ms+1 WHERE run_id='run-review-ch60'`).run()
    wal = fs.readFileSync(`${file}-wal`)
  } finally { writer.close() }
  // 主文件停在写之前，WAL 里留着已提交的帧，和进程被杀后一样。
  fs.writeFileSync(file, before)
  fs.writeFileSync(`${file}-wal`, wal)
  fs.rmSync(`${file}-shm`, { force: true })
  expect(wal.length).toBeGreaterThan(0)

  expect((await openOnce(book)).bindings).toHaveLength(8)
})

it('封存已提交、还没缩文件就被打断：下次打开缩到和一次做完一样大', { timeout: 120_000 }, async () => {
  const interrupted = new Database(databaseFile(book))
  try { expect(sealSavedReviewProofs(interrupted)).toBe(8) } finally { interrupted.close() }
  const once = await openOnce(twin)
  expect(fs.statSync(databaseFile(book)).size).toBeGreaterThan(once.bytes * 2)

  expect(await openOnce(book)).toEqual(once)
})
