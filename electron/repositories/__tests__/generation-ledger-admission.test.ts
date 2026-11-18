import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { reviewCycleDatabase, seedReviewedBook } from '../../../test/helpers/review-cycle-fixture'
import { verifyM03ReviewCycleById } from '../../migrations/m03-review-cycle'
import { getProjectDatabasePath } from '../../services/project-data-locator'
import { GenerationRunRepository, textHash, type OpenGenerationRunRequest } from '../generation-run-repository'
import { ADMITTED_LEDGER_CELLS, admitGenerationLedger, GENERATION_LEDGER_UNREADABLE } from '../generation-ledger-admission'
import { uiActionNonceOfOpenKey } from '../generation-run-repository'

type Db = import('better-sqlite3').Database
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

let projectRoot = '', databasePath = ''
beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-ledger-'))
  openCanonicalProjectFixture(projectRoot)
  databasePath = getProjectDatabasePath(projectRoot)
})
afterEach(() => {
  closeProjectDatabase()
  vi.restoreAllMocks()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

const h = textHash('frozen')
const openRequest = (uiActionNonce: string, parentRootActionId?: string): OpenGenerationRunRequest => ({
  projectId: 'project', epoch: 'epoch', operation: 'chapter-draft', uiActionNonce, frozenInputHash: h, parentRootActionId,
  fingerprint: { chapterBriefHash: h, authorGuidanceHash: h, dependencyHash: h, contextSnapshotHash: h, templateHash: h,
    skillSnapshotHash: h, modelLeaseRevision: h, policyHash: h, outputContractHash: h },
  contextSnapshotId: 'context', sourceManifest: { kind: 'synthetic-frozen-sources' }, sourceRefs: [],
  budget: { maxPhysicalRequests: 4, maxTokenLiability: 1000, maxOutputPerRequest: 100, maxActiveElapsedMs: 100000 },
})

function seedLedger() {
  const repository = new GenerationRunRepository(getProjectDb)
  const healthy = repository.open(openRequest('healthy'))
  const healthyAttempt = repository.reserve(healthy.runId, 'healthy', textHash('healthy'), 200, 100)
  repository.snapshot(healthyAttempt.attempt.attemptId, 0, '健康根的正文')
  const victim = repository.open(openRequest('victim'))
  const sibling = repository.open(openRequest('victim-child', victim.rootActionId))
  const stuck = repository.reserve(victim.runId, 'stuck', textHash('stuck'), 200, 100)
  repository.markDispatched(stuck.attempt.attemptId)
  repository.snapshot(stuck.attempt.attemptId, 0, '坏根的正文')
  return { healthy, victim: { root: victim.rootActionId, run: victim.runId, sibling: sibling.runId, attempt: stuck.attempt.attemptId } }
}
type Victim = ReturnType<typeof seedLedger>['victim']

const cellOf = (table: string, column: string, key: string, pick: keyof Victim) => ({ table, column, key, pick })
type Cell = ReturnType<typeof cellOf>
const ACTION = cellOf('generation_roots', 'action_json', 'root_action_id', 'root')
const BUDGET = cellOf('generation_roots', 'budget_json', 'root_action_id', 'root')
const BINDING = cellOf('generation_runs', 'binding_json', 'run_id', 'run')
const ATTEMPT = cellOf('generation_attempts', 'attempt_json', 'attempt_id', 'attempt')
const USAGE = cellOf('generation_attempts', 'usage_receipt_json', 'attempt_id', 'attempt')
const ARTIFACT = cellOf('generation_artifacts', 'artifact_json', 'attempt_id', 'attempt')

const DAMAGES: [string, [Cell, string | Buffer][]][] = [
  ['action_json 语法坏', [[ACTION, '{坏']]],
  ['budget_json 语法坏', [[BUDGET, '{坏']]],
  ['action_json 写成 null', [[ACTION, 'null']]],
  ['binding_json 语法坏', [[BINDING, '{坏']]],
  ['binding_json 写成 []', [[BINDING, '[]']]],
  ['binding_json 存成 BLOB', [[BINDING, Buffer.from('{"projectId":"project"}')]]],
  ['attempt_json 语法坏', [[ATTEMPT, '{坏']]],
  ['attempt_json 写成 null', [[ATTEMPT, 'null']]],
  ['usage_receipt_json 语法坏', [[USAGE, '{坏']]],
  ['usage_receipt_json 写成字符串', [[USAGE, '"x"']]],
  ['一棵树里三格同时坏', [[ACTION, '{坏'], [BINDING, '{坏'], [USAGE, '{坏']]],
  ['artifact_json 语法坏', [[ARTIFACT, '{坏']]],
  ['action_json 合法对象后跟 NUL 与尾随字节', [[ACTION, '{"projectId":"project"}\u0000尾巴']]],
]

const LEDGER_TABLES = ['generation_roots', 'generation_runs', 'generation_attempts', 'generation_artifacts']
function ledgerDump(db: Db): string {
  return JSON.stringify(LEDGER_TABLES.map(table => (db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).raw().all() as unknown[][])
    .map(row => row.map(value => Buffer.isBuffer(value) ? `blob:${value.toString('hex')}` : value))))
}

function withProjectClosed<T>(fn: (db: Db) => T): T {
  closeProjectDatabase()
  const db = new Database(databasePath)
  try { return fn(db) } finally { db.close() }
}
function damage(db: Db, victim: Victim, cells: [Cell, string | Buffer][]) {
  for (const [cell, value] of cells) db.prepare(`UPDATE ${cell.table} SET ${cell.column}=? WHERE ${cell.key}=?`).run(value, victim[cell.pick])
}
function keptBytes(db: Db, victim: Victim): { table: string; column: string; bytes: Buffer }[] {
  const kept = db.prepare(`SELECT json_extract(binding_json,'$."$ledgerUnreadable"') FROM generation_runs WHERE root_action_id=? AND json_type(binding_json,'$."$ledgerUnreadable"') IS NOT NULL`)
    .pluck().all(victim.root) as string[]
  return kept.flatMap(json => (JSON.parse(json) as { table: string; column: string; hex: string }[])
    .map(item => ({ table: item.table, column: item.column, bytes: Buffer.from(item.hex, 'hex') })))
}
function everyCellReadable(db: Db): boolean {
  return ADMITTED_LEDGER_CELLS.every(cell => (db.prepare(`SELECT typeof(${cell.column}) AS kind, ${cell.column} AS value FROM ${cell.table}`).all() as { kind: string; value: unknown }[])
    .every(({ kind, value }) => (cell.nullable && kind === 'null') || (kind === 'text' && (() => {
      const parsed: unknown = JSON.parse(value as string)
      return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    })())))
}

describe('打开作品时封存读不出的生成记录', () => {
  it.each(DAMAGES)('%s：经 initProjectDatabase 打开后坏格子换成中性值、根被封存、原始字节可取回', (_name, cells) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { healthy, victim } = seedLedger()
    const db0 = getProjectDb()!
    const healthyRoot = JSON.stringify(db0.prepare('SELECT * FROM generation_roots WHERE root_action_id=?').get(healthy.rootActionId))
    const healthyRun = db0.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(healthy.runId)
    const siblingBinding = db0.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(victim.sibling)
    withProjectClosed(db => damage(db, victim, cells))

    initProjectDatabase(projectRoot)

    const db = getProjectDb()!
    expect(everyCellReadable(db)).toBe(true)
    expect(db.prepare('SELECT blocked_code FROM generation_roots WHERE root_action_id=?').pluck().get(victim.root)).toBe(GENERATION_LEDGER_UNREADABLE)
    expect(JSON.stringify(db.prepare('SELECT * FROM generation_roots WHERE root_action_id=?').get(healthy.rootActionId))).toBe(healthyRoot)
    expect(db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(healthy.runId)).toBe(healthyRun)
    expect(db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(victim.sibling)).toBe(siblingBinding)
    const kept = keptBytes(db, victim)
    expect(kept.map(item => [item.table, item.column])).toEqual(cells.map(([cell]) => [cell.table, cell.column]))
    cells.forEach(([, value], index) => expect(kept[index]!.bytes.equals(Buffer.from(value))).toBe(true))
    expect(() => new GenerationRunRepository(getProjectDb).reserve(victim.run, 'again', textHash('again'), 200, 100)).toThrow(GENERATION_LEDGER_UNREADABLE)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(GENERATION_LEDGER_UNREADABLE), { rootActionIds: [victim.root] })
  })

  it('同一棵树里读得出的格子只有进行中的尝试落到终态；记账那条运行的冻结绑定不变，只多一条原始字节', () => {
    const { victim } = seedLedger()
    const db0 = getProjectDb()!
    const budgetBefore = db0.prepare('SELECT budget_json FROM generation_roots WHERE root_action_id=?').pluck().get(victim.root)
    const attemptBefore = db0.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts WHERE attempt_id=?').get(victim.attempt) as { attempt_json: string; usage_receipt_json: string }
    expect(JSON.parse(attemptBefore.attempt_json).status).toBe('dispatch-marked')
    const artifactBefore = db0.prepare('SELECT artifact_json FROM generation_artifacts WHERE attempt_id=?').pluck().get(victim.attempt)
    const bindingBefore = JSON.parse(db0.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(victim.run) as string) as Record<string, unknown>
    withProjectClosed(db => damage(db, victim, [[ACTION, '{坏']]))

    initProjectDatabase(projectRoot)

    const db = getProjectDb()!
    expect(db.prepare('SELECT budget_json FROM generation_roots WHERE root_action_id=?').pluck().get(victim.root)).toBe(budgetBefore)
    expect(db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts WHERE attempt_id=?').get(victim.attempt)).toEqual({ ...attemptBefore,
      attempt_json: JSON.stringify({ ...JSON.parse(attemptBefore.attempt_json), status: 'unknown' }) })
    expect(db.prepare('SELECT artifact_json FROM generation_artifacts WHERE attempt_id=?').pluck().get(victim.attempt)).toBe(artifactBefore)
    const { $ledgerUnreadable, ...frozen } = JSON.parse(db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(victim.run) as string) as Record<string, unknown>
    expect(frozen).toEqual(bindingBefore)
    expect($ledgerUnreadable).toHaveLength(1)
  })

  it('再打开一次，账本四张表逐字节不变', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { victim } = seedLedger()
    withProjectClosed(db => damage(db, victim, [[ACTION, '{坏'], [BINDING, '{坏'], [USAGE, '{坏']]))
    initProjectDatabase(projectRoot)
    const first = withProjectClosed(ledgerDump)

    initProjectDatabase(projectRoot)

    expect(withProjectClosed(ledgerDump)).toBe(first)
  })

  it('initProjectDatabase 报出这次新封存的根：两个根坏三格报 2，再打开报 0', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { healthy, victim } = seedLedger()
    withProjectClosed(db => {
      damage(db, victim, [[ACTION, '{坏'], [USAGE, '{坏']])
      db.prepare('UPDATE generation_roots SET budget_json=? WHERE root_action_id=?').run('{坏', healthy.rootActionId)
    })

    expect([...initProjectDatabase(projectRoot).sealedRootActionIds].sort()).toEqual([victim.root, healthy.rootActionId].sort())
    expect(initProjectDatabase(projectRoot).sealedRootActionIds).toEqual([])
  })

  it('健康的书打开：initProjectDatabase 不报封存', () => {
    seedLedger()
    expect(initProjectDatabase(projectRoot).sealedRootActionIds).toEqual([])
  })

  it('封存过的库再进门：不封存、不提交任何写入', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { victim } = seedLedger()
    withProjectClosed(db => damage(db, victim, [[BUDGET, '{坏']]))
    initProjectDatabase(projectRoot)
    closeProjectDatabase()
    const db = new Database(databasePath), observer = new Database(databasePath)
    try {
      const version = observer.pragma('data_version', { simple: true })
      expect(admitGenerationLedger(db).sealedRootActionIds).toEqual([])
      expect(observer.pragma('data_version', { simple: true })).toBe(version)
    } finally { db.close(); observer.close() }
  })

  it('没有坏格子的库：扫描不开写事务、不写库', () => {
    seedLedger()
    closeProjectDatabase()
    const db = new Database(databasePath, { timeout: 0 }), writer = new Database(databasePath)
    try {
      const version = writer.pragma('data_version', { simple: true })
      writer.exec('BEGIN IMMEDIATE')
      expect(admitGenerationLedger(db).sealedRootActionIds).toEqual([])
      writer.exec('ROLLBACK')
      expect(writer.pragma('data_version', { simple: true })).toBe(version)
    } finally { db.close(); writer.close() }
  })

  it('有坏格子时一个事务做完：中途写入失败，已改的格子回滚', () => {
    const { victim } = seedLedger()
    closeProjectDatabase()
    const db = new Database(databasePath)
    try {
      damage(db, victim, [[ACTION, '{坏'], [USAGE, '{坏']])
      db.exec("CREATE TEMP TRIGGER fail_second_cell BEFORE UPDATE OF usage_receipt_json ON generation_attempts BEGIN SELECT RAISE(ABORT,'INJECTED'); END")
      expect(() => admitGenerationLedger(db)).toThrow('INJECTED')
      expect(db.prepare('SELECT action_json,blocked_code FROM generation_roots WHERE root_action_id=?').get(victim.root)).toEqual({ action_json: '{坏', blocked_code: null })
      expect(keptBytes(db, victim)).toEqual([])
    } finally { db.close() }
  })

  it('只有根、没有运行的坏根：照常封存，作品照常打开', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    withProjectClosed(db => db.prepare("INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES('orphan','orphan-key','{坏','{}')").run())

    initProjectDatabase(projectRoot)

    const db = getProjectDb()!
    expect(everyCellReadable(db)).toBe(true)
    expect(db.prepare("SELECT blocked_code FROM generation_roots WHERE root_action_id='orphan'").pluck().get()).toBe(GENERATION_LEDGER_UNREADABLE)
  })

  it('便携导入冻结的记录坏了：照常封存，跨记录的恢复照常，它自己读不出', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { healthy, victim } = seedLedger()
    withProjectClosed(db => damage(db, victim, [[ACTION, '{坏']]))
    initProjectDatabase(projectRoot)
    const frozen = new Set([victim.root, victim.run, victim.attempt])
    const repository = new GenerationRunRepository(getProjectDb, Date.now, (_table, id) => frozen.has(id))

    expect(() => repository.recoverInterrupted()).not.toThrow()
    expect(repository.budget(healthy.rootActionId).root.status).toBe('paused')
    expect(() => repository.readRunView(victim.run)).toThrow(GENERATION_LEDGER_UNREADABLE)
  })

  it('记账区原来不是数组：照常打开，原值另存，新记录照常追加', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { victim } = seedLedger()
    withProjectClosed(db => {
      db.prepare("UPDATE generation_runs SET binding_json=json_set(binding_json,'$.\"$ledgerUnreadable\"','damaged') WHERE run_id=?").run(victim.run)
      damage(db, victim, [[ACTION, '{坏']])
    })

    initProjectDatabase(projectRoot)

    const db = getProjectDb()!
    expect(everyCellReadable(db)).toBe(true)
    const stored = JSON.parse(db.prepare("SELECT json_extract(binding_json,'$.\"$ledgerUnreadable\"') FROM generation_runs WHERE run_id=?").pluck().get(victim.run) as string) as unknown[]
    expect(stored).toEqual([{ previous: '"damaged"' }, expect.objectContaining({ table: 'generation_roots', column: 'action_json' })])
  })

  it('记账区原来是嵌套到上限的对象：照常打开，原值按文本另存', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { victim } = seedLedger()
    const deep = '{"a":'.repeat(998) + '1' + '}'.repeat(998)
    withProjectClosed(db => {
      db.prepare("UPDATE generation_runs SET binding_json=json_set(binding_json,'$.\"$ledgerUnreadable\"',json(?)) WHERE run_id=?").run(deep, victim.run)
      damage(db, victim, [[ACTION, '{坏']])
    })

    initProjectDatabase(projectRoot)

    const db = getProjectDb()!
    expect(everyCellReadable(db)).toBe(true)
    const stored = JSON.parse(db.prepare("SELECT json_extract(binding_json,'$.\"$ledgerUnreadable\"') FROM generation_runs WHERE run_id=?").pluck().get(victim.run) as string) as { previous?: string }[]
    expect(stored).toEqual([{ previous: deep }, expect.objectContaining({ table: 'generation_roots', column: 'action_json', recordId: victim.root, hex: Buffer.from('{坏').toString('hex').toUpperCase() })])
  })

  it('扫描之后、写锁之前另一连接修好了这一格：不覆盖修好的值', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { victim } = seedLedger()
    const good = getProjectDb()!.prepare('SELECT action_json FROM generation_roots WHERE root_action_id=?').pluck().get(victim.root) as string
    closeProjectDatabase()
    const db = new Database(databasePath), other = new Database(databasePath)
    try {
      db.prepare("UPDATE generation_roots SET action_json='{坏' WHERE root_action_id=?").run(victim.root)
      const transaction = db.transaction.bind(db)
      vi.spyOn(db, 'transaction').mockImplementation((fn => {
        other.prepare('UPDATE generation_roots SET action_json=? WHERE root_action_id=?').run(good, victim.root)
        return transaction(fn)
      }) as typeof db.transaction)

      expect(admitGenerationLedger(db).sealedRootActionIds).toEqual([])

      expect(db.prepare('SELECT action_json,blocked_code FROM generation_roots WHERE root_action_id=?').get(victim.root)).toEqual({ action_json: good, blocked_code: null })
      expect(keptBytes(db, victim)).toEqual([])
    } finally { other.close(); db.close() }
  })

  it('UTF-16 编码的库：健康账本不被当成坏格子，再进门也不写', () => {
    const { victim } = seedLedger()
    const source = getProjectDb()!
    const tables = ['generation_roots', 'generation_runs', 'generation_attempts', 'generation_artifacts']
    const ddl = tables.map(table => source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").pluck().get(table) as string)
    const rows = tables.map(table => source.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[])
    const db = new Database(':memory:')
    try {
      db.pragma("encoding='UTF-16le'")
      db.pragma('foreign_keys = OFF')
      for (const sql of ddl) db.exec(sql)
      tables.forEach((table, index) => {
        for (const row of rows[index]!) {
          const keys = Object.keys(row)
          db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]))
        }
      })
      expect(db.pragma('encoding', { simple: true })).toBe('UTF-16le')
      const before = ledgerDump(db)

      expect(admitGenerationLedger(db).sealedRootActionIds).toEqual([])
      expect(admitGenerationLedger(db).sealedRootActionIds).toEqual([])

      expect(ledgerDump(db)).toBe(before)
      expect(db.prepare('SELECT blocked_code FROM generation_roots WHERE root_action_id=?').pluck().get(victim.root)).toBeNull()
    } finally { db.close() }
  })

  it('open_key 的两层都必须是数组，凑出下标 2 的对象不算读得出', () => {
    const inner = JSON.stringify(['project', 'chapter-draft', 'nonce', 'hash'])
    expect(uiActionNonceOfOpenKey(JSON.stringify([inner, null]))).toBe('nonce')
    expect(uiActionNonceOfOpenKey(JSON.stringify({ 0: JSON.stringify({ 2: 'forged' }) }))).toBeUndefined()
    expect(uiActionNonceOfOpenKey(JSON.stringify([JSON.stringify({ 2: 'forged' }), null]))).toBeUndefined()
    expect(uiActionNonceOfOpenKey('{坏')).toBeUndefined()
  })
})

describe('被审修循环引用的根被封存', () => {
  it('只有这一条循环验不过，其余循环照常，外键无违规', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = reviewCycleDatabase()
    try {
      seedReviewedBook(db, 2)
      const cycles = db.prepare('SELECT cycle_id,root_action_id FROM review_cycles ORDER BY cycle_id').all() as { cycle_id: string; root_action_id: string }[]
      db.prepare("UPDATE generation_roots SET action_json='{坏' WHERE root_action_id=?").run(cycles[0]!.root_action_id)

      expect(admitGenerationLedger(db).sealedRootActionIds).toEqual([cycles[0]!.root_action_id])

      expect(verifyM03ReviewCycleById(db, cycles[0]!.cycle_id)).toBe(false)
      expect(verifyM03ReviewCycleById(db, cycles[1]!.cycle_id)).toBe(true)
      expect(db.pragma('foreign_key_check')).toEqual([])
    } finally { db.close() }
  })
})
