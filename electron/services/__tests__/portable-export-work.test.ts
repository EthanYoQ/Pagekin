import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { seedReviewedBook } from '../../../test/helpers/review-cycle-fixture'
import { CANONICAL_PROJECT_DIRECTORY } from '../../../src/shared/project-format'
import { exportPortableProject } from '../project-archive-service'
import { backupProjectSqlite } from '../sqlite-project-migration'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

let base = ''
let projectRoot = ''
let statements: string[] = []
let backups = 0

beforeEach(() => {
  base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'export-work-'))
  projectRoot = path.join(base, 'book')
  fs.mkdirSync(projectRoot)
  openCanonicalProjectFixture(projectRoot)
  seedReviewedBook(getProjectDb()!, 2)
  getProjectDb()!.prepare('UPDATE generation_roots SET budget_json=?').run(JSON.stringify({ maxPhysicalRequests: 1,
    maxTokenLiability: 100, maxOutputPerRequest: 100, maxActiveElapsedMs: 1000 }))
  statements = []
  backups = 0
  const prepare = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: InstanceType<typeof Database>, source: string) {
    statements.push(source)
    return prepare.call(this, source)
  })
  const backup = Database.prototype.backup
  vi.spyOn(Database.prototype, 'backup').mockImplementation(function (this: InstanceType<typeof Database>, ...args: Parameters<typeof backup>) {
    backups++
    return backup.apply(this, args)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  closeProjectDatabase()
  fs.rmSync(base, { recursive: true, force: true })
})

const databasePath = () => path.join(projectRoot, CANONICAL_PROJECT_DIRECTORY, 'project.db')
const contentReads = () => statements.filter(sql => /^SELECT "[^]*" FROM "contents"$/.test(sql)).length
const reviewCycleScans = () => statements.filter(sql => sql === 'SELECT * FROM review_cycles ORDER BY cycle_id').length

async function exportBook() {
  const projectId = JSON.parse(fs.readFileSync(path.join(projectRoot, CANONICAL_PROJECT_DIRECTORY, 'project.json'), 'utf8')).projectId
  const receipt = await exportPortableProject({
    sourceProjectRoot: projectRoot,
    projectSession: { projectId, projectPath: projectRoot, leaseId: 'lease' },
    targetArchivePath: path.join(base, `${randomUUID()}.ainovel`),
    attemptParentPath: base,
    assertCurrentContext: () => undefined,
    assets: { snapshot: () => ({ files: [], semanticCounts: { 'provided-assets': 0 }, omittedItems: [],
      transferReceiptIds: [], historyProjectionIds: [] }) },
  })
  expect(receipt.omittedReviewCycles).toBeUndefined()
}

it('导出只取一次源库快照，不算内容哈希', async () => {
  await exportBook()
  expect(backups).toBe(1)
  expect(contentReads()).toBe(0)
  // 同一计数器看得见内容哈希：备份通道要读全书内容。
  await backupProjectSqlite({ sourceDatabasePath: databasePath(), targetDatabasePath: path.join(base, 'backup.db') })
  expect(contentReads()).toBeGreaterThan(0)
})

it('健康的书全书审修循环只扫两遍：源快照一遍，导出产物一遍', async () => {
  await exportBook()
  expect(reviewCycleScans()).toBe(2)
})
