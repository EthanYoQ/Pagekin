import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { getProjectDatabasePath } from '../../services/project-data-locator'
import { GenerationRunRepository, textHash, type OpenGenerationRunRequest } from '../generation-run-repository'
import { admitGenerationLedger, GENERATION_LEDGER_UNREADABLE } from '../generation-ledger-admission'
import { runIndexOf } from '../generation-run-index'

type Db = import('better-sqlite3').Database
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

let projectRoot = '', databasePath = ''
beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-binding-'))
  openCanonicalProjectFixture(projectRoot)
  databasePath = getProjectDatabasePath(projectRoot)
})
afterEach(() => {
  closeProjectDatabase()
  vi.restoreAllMocks()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

const h = textHash('frozen')
const openRequest = (uiActionNonce: string): OpenGenerationRunRequest => ({
  projectId: 'project', epoch: 'epoch', operation: 'chapter-draft', uiActionNonce, frozenInputHash: h,
  fingerprint: { chapterBriefHash: h, authorGuidanceHash: h, dependencyHash: h, contextSnapshotHash: h, templateHash: h,
    skillSnapshotHash: h, modelLeaseRevision: h, policyHash: h, outputContractHash: h },
  contextSnapshotId: 'context', sourceManifest: { kind: 'synthetic-frozen-sources', operation: 'chapter-draft' }, sourceRefs: [],
  budget: { maxPhysicalRequests: 4, maxTokenLiability: 1000, maxOutputPerRequest: 100, maxActiveElapsedMs: 100000 },
})

/** 一次生成跑完一轮后作品关闭：根暂停、尝试落到终态，这棵树静止。 */
function settledRun(repository: GenerationRunRepository, nonce: string) {
  const run = repository.open(openRequest(nonce))
  const reserved = repository.reserve(run.runId, nonce, textHash(nonce), 200, 100)
  repository.markDispatched(reserved.attempt.attemptId)
  repository.settle(reserved.attempt.attemptId, null, 'stop')
  repository.pause(run.rootActionId)
  return run
}

function withProjectClosed<T>(fn: (db: Db) => T): T {
  closeProjectDatabase()
  const db = new Database(databasePath)
  try { return fn(db) } finally { db.close() }
}
const LEDGER_TABLES = ['generation_roots', 'generation_runs', 'generation_attempts', 'generation_artifacts']
const ledgerDump = (db: Db) => JSON.stringify(LEDGER_TABLES.map(table => (db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).raw().all() as unknown[][])
  .map(row => row.map(value => Buffer.isBuffer(value) ? `blob:${value.toString('hex')}` : value))))
const blockedCode = (db: Db, rootId: string) => db.prepare('SELECT blocked_code FROM generation_roots WHERE root_action_id=?').pluck().get(rootId)
const setBinding = (db: Db, runId: string, value: string | Buffer) => db.prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=?').run(value, runId)

const UNREADABLE_BINDINGS: [string, string | Buffer][] = [
  ['语法坏', '{坏'],
  ['写成 null', 'null'],
  ['写成 []', '[]'],
  ['合法对象后跟 NUL 与尾随字节', '{"projectId":"project"}\u0000尾巴'],
  ['存成 BLOB', Buffer.from('{"projectId":"project"}')],
  ['JSON5（json_extract 认、json_valid 不认）', '{projectId:"project",epoch:"epoch",sourceManifest:{operation:"chapter-draft"}}'],
]

describe('静止树的绑定读不出（#702 S2，ADR-0030 决定 7）', () => {
  it.each(UNREADABLE_BINDINGS)('%s：打开不封存、不写库；读写这一次生成报记录已损坏，别的生成照常；导出前的全量进门封存它', (_name, value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seeding = new GenerationRunRepository(getProjectDb)
    const healthy = settledRun(seeding, 'healthy'), quiet = settledRun(seeding, 'quiet')
    const before = withProjectClosed(db => { setBinding(db, quiet.runId, value); return ledgerDump(db) })

    expect(initProjectDatabase(projectRoot)).toEqual({ sealedRootCount: 0 })
    const db = getProjectDb()!
    expect(ledgerDump(db)).toBe(before)
    expect(blockedCode(db, quiet.rootActionId)).toBeNull()
    expect(warn).not.toHaveBeenCalled()

    const repository = new GenerationRunRepository(getProjectDb)
    const touchingIt: [string, () => unknown][] = [
      ['get', () => repository.get(quiet.runId)],
      ['recoveryAbandonment', () => repository.recoveryAbandonment(quiet.runId)],
      ['readPlanningContinuation', () => repository.readPlanningContinuation(quiet.runId)],
      ['readPlotOutlineAuthorEdit', () => repository.readPlotOutlineAuthorEdit(quiet.runId)],
      ['isPrivatePlanningHistory', () => repository.isPrivatePlanningHistory(quiet.runId)],
      ['assertPlotOutlineWritable', () => repository.assertPlotOutlineWritable(quiet.runId)],
      ['plotOutlineCommitted', () => repository.plotOutlineCommitted(quiet.runId)],
      ['editorInlineAwaitingDelivery', () => repository.editorInlineAwaitingDelivery(quiet.runId)],
    ]
    expect(touchingIt.flatMap(([name, read]) => {
      try { read(); return [`${name}: 没报错`] } catch (error) { return (error as Error).message === GENERATION_LEDGER_UNREADABLE ? [] : [`${name}: ${(error as Error).message}`] }
    })).toEqual([])
    expect(repository.readableRun(quiet.runId)).toBeUndefined()
    expect(repository.runIdentity(quiet.runId)).toBeUndefined()
    expect(repository.runIdentity(healthy.runId)).toMatchObject({ projectId: 'project', operation: 'chapter-draft', batchRoot: false })
    expect(repository.get(healthy.runId).binding.projectId).toBe('project')
    expect(repository.isPrivatePlanningHistory(healthy.runId)).toBe(false)
    expect(runIndexOf(db).lookup(click => click.operation === 'chapter-draft').hits.map(entry => entry.runId)).toEqual([healthy.runId, quiet.runId])
    expect(() => repository.recoverInterrupted()).not.toThrow()

    expect(admitGenerationLedger(db, 'whole')).toEqual({ sealedRootCount: 1 })
    expect(blockedCode(db, quiet.rootActionId)).toBe(GENERATION_LEDGER_UNREADABLE)
    expect(blockedCode(db, healthy.rootActionId)).toBeNull()
    expect(runIndexOf(db).lookup(click => click.operation === 'chapter-draft').hits.map(entry => [entry.runId, entry.sealed]))
      .toEqual([[healthy.runId, false], [quiet.runId, true]])
  })

  it('改坏的库里有运行号为 NULL 的行：跨记录认运行略过它，别的运行照常认出', () => {
    const repository = new GenerationRunRepository(getProjectDb)
    const healthy = settledRun(repository, 'healthy'), orphan = repository.open(openRequest('orphan'))
    getProjectDb()!.prepare('UPDATE generation_runs SET run_id=NULL WHERE run_id=?').run(orphan.runId)
    const fresh = new GenerationRunRepository(getProjectDb)
    expect(fresh.recognizedRuns(click => click.operation === 'chapter-draft', () => true).map(run => run.runId)).toEqual([healthy.runId])
    expect(fresh.runsOfOperation('chapter-draft')).toEqual([healthy.runId])
  })

  it('导出中性化成 {} 的绑定读得出：身份缺作品号，不算读不出', () => {
    const run = settledRun(new GenerationRunRepository(getProjectDb), 'neutral')
    setBinding(getProjectDb()!, run.runId, '{}')
    expect(new GenerationRunRepository(getProjectDb).runIdentity(run.runId)).toMatchObject({ runId: run.runId, projectId: undefined, operation: undefined })
  })

  it('没静止的树（根还是 active）绑定读不出：打开时照常封存', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const active = new GenerationRunRepository(getProjectDb).open(openRequest('active'))
    withProjectClosed(db => setBinding(db, active.runId, '{坏'))
    expect(initProjectDatabase(projectRoot)).toEqual({ sealedRootCount: 1 })
    expect(blockedCode(getProjectDb()!, active.rootActionId)).toBe(GENERATION_LEDGER_UNREADABLE)
  })

  it('一棵树的尝试读不出、另一棵静止树的绑定也读不出：作品照常打开，只封存尝试所在的树', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seeding = new GenerationRunRepository(getProjectDb)
    const broken = settledRun(seeding, 'broken'), quiet = settledRun(seeding, 'quiet')
    withProjectClosed(db => {
      db.prepare("UPDATE generation_attempts SET attempt_json='{坏' WHERE run_id=?").run(broken.runId)
      setBinding(db, quiet.runId, '{坏')
    })
    expect(initProjectDatabase(projectRoot)).toEqual({ sealedRootCount: 1 })
    const db = getProjectDb()!
    expect(blockedCode(db, broken.rootActionId)).toBe(GENERATION_LEDGER_UNREADABLE)
    expect(blockedCode(db, quiet.rootActionId)).toBeNull()
  })
})
