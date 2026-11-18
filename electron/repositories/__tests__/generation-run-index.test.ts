import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { GenerationRunRepository, textHash, type OpenGenerationRunRequest } from '../generation-run-repository'
import { GENERATION_LEDGER_UNREADABLE } from '../generation-ledger-admission'
import { clickOfOpenKey, runIndexOf, type RunIndexEntry } from '../generation-run-index'

type Db = import('better-sqlite3').Database

let projectRoot = ''
beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-run-index-'))
  openCanonicalProjectFixture(projectRoot)
})
afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

const h = textHash('frozen')
const request = (operation: string, uiActionNonce: string, parentRootActionId?: string, projectId = 'project'): OpenGenerationRunRequest => ({
  projectId, epoch: 'epoch', operation, uiActionNonce, frozenInputHash: h, parentRootActionId,
  fingerprint: { chapterBriefHash: h, authorGuidanceHash: h, dependencyHash: h, contextSnapshotHash: h, templateHash: h,
    skillSnapshotHash: h, modelLeaseRevision: h, policyHash: h, outputContractHash: h },
  contextSnapshotId: 'context', sourceManifest: { operation }, sourceRefs: [],
  budget: { maxPhysicalRequests: 4, maxTokenLiability: 1000, maxOutputPerRequest: 100, maxActiveElapsedMs: 100000 },
})

/** 从账本现场重算：每条运行的身份，封存看根的阻断码。 */
function recomputed(db: Db): RunIndexEntry[] {
  const rows = db.prepare(`SELECT r.rowid AS row, r.run_id, r.root_action_id, r.open_key, g.blocked_code FROM generation_runs r
    LEFT JOIN generation_roots g ON g.root_action_id=r.root_action_id ORDER BY r.rowid`).safeIntegers().all() as
    { row: bigint; run_id: string; root_action_id: string; open_key: unknown; blocked_code: string | null }[]
  return rows.map(row => ({ runId: row.run_id, rootActionId: row.root_action_id, order: row.row,
    click: clickOfOpenKey(row.open_key), sealed: row.blocked_code === GENERATION_LEDGER_UNREADABLE }))
}

function expectIndexMatchesLedger(db: Db) {
  const all = recomputed(db)
  const lookup = runIndexOf(db).lookup(() => true)
  expect(lookup.hits).toEqual(all.filter(entry => entry.click !== undefined))
  expect(lookup.unidentified).toEqual(all.filter(entry => entry.click === undefined && !entry.sealed))
}

const insertRaw = (db: Db, runId: string, rootId: string, openKey: string, rowid?: bigint) =>
  db.prepare(`INSERT INTO generation_runs(${rowid === undefined ? '' : 'rowid,'}run_id,root_action_id,binding_json,status,created_at_ms,open_key) VALUES(${rowid === undefined ? '' : '?,'}?,?,'{}','running',0,?)`)
    .run(...(rowid === undefined ? [] : [rowid]), runId, rootId, openKey)

describe('generation run index', () => {
  it('equals the identities recomputed from the ledger as runs are opened, rolled back and read back', () => {
    const db = getProjectDb()!
    const runs = new GenerationRunRepository(getProjectDb)
    expectIndexMatchesLedger(db)
    const review = runs.open(request('review-chapter', 'review-1'))
    runs.open(request('refine-from-review', 'refine-1', review.rootActionId))
    expectIndexMatchesLedger(db)
    runs.open(request('chapter-blueprint-directory', 'blueprint-1'))
    expectIndexMatchesLedger(db)

    // 事务里能查到刚插入的行；回滚后同一个 rowid 被另一条运行重用，索引必须看到的是后者。
    let inside: string[] = []
    expect(() => db.transaction(() => {
      const ghost = runs.open(request('agent-round', 'ghost'))
      inside = runIndexOf(db).lookup(click => click.uiActionNonce === 'ghost').hits.map(entry => entry.runId)
      expect(inside).toEqual([ghost.runId])
      throw new Error('rollback')
    }).immediate()).toThrow('rollback')
    const reused = runs.open(request('agent-round', 'after-rollback'))
    expect(runIndexOf(db).lookup(click => click.uiActionNonce === 'ghost').hits).toEqual([])
    expect(runIndexOf(db).lookup(click => click.uiActionNonce === 'after-rollback').hits.map(entry => entry.runId)).toEqual([reused.runId])
    expectIndexMatchesLedger(db)
  })

  it('keeps unreadable identities apart and orders runs past 2^53 by their exact rowid', () => {
    const db = getProjectDb()!
    const runs = new GenerationRunRepository(getProjectDb)
    const first = runs.open(request('chapter-draft', 'first'))
    expectIndexMatchesLedger(db)
    insertRaw(db, 'run-bad-key', first.rootActionId, '{坏')
    const big = 2n ** 53n + 1n
    insertRaw(db, 'run-big', first.rootActionId, JSON.stringify([JSON.stringify(['project', 'chapter-draft', 'big', h]), first.rootActionId]), big)
    insertRaw(db, 'run-bigger', first.rootActionId, JSON.stringify([JSON.stringify(['project', 'chapter-draft', 'bigger', h]), first.rootActionId]))
    expectIndexMatchesLedger(db)
    const lookup = runIndexOf(db).lookup(click => click.operation === 'chapter-draft')
    expect(lookup.hits.map(entry => [entry.runId, entry.order])).toEqual([[first.runId, 1n], ['run-big', big], ['run-bigger', big + 1n]])
    expect(lookup.unidentified.map(entry => entry.runId)).toEqual(['run-bad-key'])
  })

  it('reads a rowid that SQLite picks below the top once the rowid space is exhausted', () => {
    const db = getProjectDb()!
    const runs = new GenerationRunRepository(getProjectDb)
    const first = runs.open(request('chapter-draft', 'first'))
    const key = (nonce: string) => JSON.stringify([JSON.stringify(['project', 'chapter-draft', nonce, h]), first.rootActionId])
    insertRaw(db, 'run-top', first.rootActionId, key('top'), 2n ** 63n - 1n)
    expectIndexMatchesLedger(db)
    insertRaw(db, 'run-below', first.rootActionId, key('below'))
    expect(runIndexOf(db).lookup(click => click.uiActionNonce === 'below').hits.map(entry => entry.runId)).toEqual(['run-below'])
    expectIndexMatchesLedger(db)
  })

  it('marks sealed trees and leaves their unreadable identities to sealedClaims', () => {
    let db = getProjectDb()!
    const runs = new GenerationRunRepository(getProjectDb)
    const healthy = runs.open(request('review-chapter', 'healthy'))
    const victim = runs.open(request('review-chapter', 'victim'))
    db.prepare("UPDATE generation_runs SET open_key='{坏' WHERE run_id=?").run(victim.runId)
    db.prepare("UPDATE generation_roots SET action_json='{坏' WHERE root_action_id=?").run(victim.rootActionId)
    closeProjectDatabase()
    initProjectDatabase(projectRoot)
    db = getProjectDb()!
    expect(db.prepare('SELECT blocked_code FROM generation_roots WHERE root_action_id=?').pluck().get(victim.rootActionId)).toBe(GENERATION_LEDGER_UNREADABLE)
    expectIndexMatchesLedger(db)
    const lookup = runIndexOf(db).lookup(() => true)
    expect(lookup.hits.map(entry => [entry.runId, entry.sealed])).toEqual([[healthy.runId, false]])
    expect(lookup.unidentified).toEqual([])
  })

  it('expands a lookup by root identity to the whole tree, including trees opened by an unreadable identity', () => {
    const db = getProjectDb()!
    const runs = new GenerationRunRepository(getProjectDb)
    const root = runs.open(request('continuity-suggest', 'suggest'))
    const child = runs.open(request('chapter-draft', 'child', root.rootActionId))
    const other = runs.open(request('chapter-draft', 'other'))
    const lost = runs.open(request('continuity-suggest', 'lost'))
    const lostChild = runs.open(request('chapter-draft', 'lost-child', lost.rootActionId))
    db.prepare("UPDATE generation_runs SET open_key='{坏' WHERE run_id=?").run(lost.runId)
    closeProjectDatabase()
    initProjectDatabase(projectRoot)
    const lookup = runIndexOf(getProjectDb()!).lookupTrees(click => click.operation === 'continuity-suggest')
    expect(lookup.hits.map(entry => entry.runId)).toEqual([root.runId, child.runId, lostChild.runId])
    expect(lookup.unidentified.map(entry => entry.runId)).toEqual([lost.runId])
    expect(lookup.hits.map(entry => entry.runId)).not.toContain(other.runId)
  })
})
