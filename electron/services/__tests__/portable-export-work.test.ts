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

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

let base = ''
let projectRoot = ''

beforeEach(() => {
  base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'export-work-'))
  projectRoot = path.join(base, 'book')
  fs.mkdirSync(projectRoot)
  openCanonicalProjectFixture(projectRoot)
  seedReviewedBook(getProjectDb()!, 2)
  getProjectDb()!.prepare('UPDATE generation_roots SET budget_json=?').run(JSON.stringify({ maxPhysicalRequests: 1,
    maxTokenLiability: 100, maxOutputPerRequest: 100, maxActiveElapsedMs: 1000 }))
})

afterEach(() => {
  vi.restoreAllMocks()
  closeProjectDatabase()
  fs.rmSync(base, { recursive: true, force: true })
})

/** 导出期间全书读一遍内容（算内容哈希）和全书扫一遍审修循环的次数。 */
async function exportWork() {
  const statements: string[] = []
  const prepare = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: InstanceType<typeof Database>, source: string) {
    statements.push(source)
    return prepare.call(this, source)
  })
  const projectId = JSON.parse(fs.readFileSync(path.join(projectRoot, CANONICAL_PROJECT_DIRECTORY, 'project.json'), 'utf8')).projectId
  const receipt = await exportPortableProject({
    sourceProjectRoot: projectRoot,
    projectSession: { projectId, projectPath: projectRoot, leaseId: 'lease' },
    targetArchivePath: path.join(base, `${randomUUID()}.ainovel`),
    attemptParentPath: base,
    assertCurrentContext: () => undefined,
    assets: { snapshot: () => ({ files: [], semanticCounts: { 'provided-assets': 0 }, omittedItems: [],
      transferReceiptIds: [], historyProjectionIds: [], verifyUnchanged: () => undefined }) },
  })
  expect(receipt.omittedReviewCycles).toBeUndefined()
  return {
    contentReads: statements.filter(sql => /^SELECT "[^]*" FROM "contents"$/.test(sql)).length,
    reviewCycleScans: statements.filter(sql => sql === 'SELECT * FROM review_cycles ORDER BY cycle_id').length,
  }
}

it('导出的三次快照各只算比对用得上的内容哈希', async () => {
  // 每次快照：快照前 1 遍、复制后核对 1 遍、交给导出比对的 domain 与 preIdentityDomain、preAssetDomain 3 遍。
  expect((await exportWork()).contentReads).toBeLessThanOrEqual(3 * 5)
})
