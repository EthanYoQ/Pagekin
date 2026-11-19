import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

export const GENERATION_LEDGER_UNREADABLE = 'GENERATION_LEDGER_UNREADABLE'
export const isLedgerUnreadable = (error: unknown) => error instanceof Error && error.message === GENERATION_LEDGER_UNREADABLE

const sealings = new WeakMap<Database.Database, number>()
/** 这个句柄上进门封存过几次。作品开着时导出前的全量进门也会封存，缓存了封存集合的一方据此重读。 */
export const sealingsOf = (db: Database.Database) => sealings.get(db) ?? 0

type LedgerTable = 'generation_roots' | 'generation_runs' | 'generation_attempts' | 'generation_artifacts'
type Db = Database.Database

// 四张表的主键都是可为 NULL 的 TEXT PRIMARY KEY，定位行一律用 rowid。
const OWNERS: Record<LedgerTable, { idColumn: string; rootRow: string; runRow: string }> = {
  generation_roots: { idColumn: 'root_action_id', rootRow: 'rowid',
    runRow: '(SELECT r.rowid FROM generation_runs r WHERE r.root_action_id=generation_roots.root_action_id ORDER BY r.rowid LIMIT 1)' },
  generation_runs: { idColumn: 'run_id', runRow: 'rowid',
    rootRow: '(SELECT o.rowid FROM generation_roots o WHERE o.root_action_id=generation_runs.root_action_id)' },
  generation_attempts: { idColumn: 'attempt_id',
    rootRow: '(SELECT o.rowid FROM generation_roots o WHERE o.root_action_id=generation_attempts.root_action_id)',
    runRow: '(SELECT r.rowid FROM generation_runs r WHERE r.run_id=generation_attempts.run_id)' },
  generation_artifacts: { idColumn: 'artifact_id',
    rootRow: '(SELECT o.rowid FROM generation_roots o JOIN generation_attempts t ON t.root_action_id=o.root_action_id WHERE t.attempt_id=generation_artifacts.attempt_id)',
    runRow: '(SELECT r.rowid FROM generation_runs r WHERE r.run_id=generation_artifacts.run_id)' },
}

export interface AdmittedLedgerCell {
  table: LedgerTable
  column: string
  nullable: boolean
  /** 契约类型的合法取值，并且不会被任何跨记录查询的条件选中。 */
  neutral(db: Db, rowid: bigint): string
}

const encode = (value: unknown) => JSON.stringify(value)

export const ADMITTED_LEDGER_CELLS: readonly AdmittedLedgerCell[] = [
  { table: 'generation_roots', column: 'action_json', nullable: false, neutral: (db, rowid) => encode({ projectId: '', epoch: '', operation: 'ledger-unreadable',
    uiActionNonce: '', frozenInputHash: '', rootActionId: db.prepare('SELECT root_action_id FROM generation_roots WHERE rowid=?').pluck().get(rowid), status: 'paused' }) },
  { table: 'generation_roots', column: 'budget_json', nullable: false, neutral: () => encode({ maxPhysicalRequests: 1, maxTokenLiability: 1, maxOutputPerRequest: 1, maxActiveElapsedMs: 1 }) },
  { table: 'generation_attempts', column: 'attempt_json', nullable: false, neutral: (db, rowid) => {
    const row = db.prepare('SELECT attempt_id,reservation_id,root_action_id FROM generation_attempts WHERE rowid=?').get(rowid) as { attempt_id: string; reservation_id: string; root_action_id: string }
    return encode({ attemptId: row.attempt_id, reservationId: row.reservation_id, rootActionId: row.root_action_id, status: 'unknown', reservedTokens: 1, requestedOutputTokens: 1 })
  } },
  { table: 'generation_attempts', column: 'usage_receipt_json', nullable: true, neutral: () => '{}' },
  { table: 'generation_artifacts', column: 'artifact_json', nullable: false, neutral: (db, rowid) => {
    const row = db.prepare('SELECT a.artifact_id,a.attempt_id,a.revision,t.root_action_id FROM generation_artifacts a LEFT JOIN generation_attempts t ON t.attempt_id=a.attempt_id WHERE a.rowid=?')
      .get(rowid) as { artifact_id: string; attempt_id: string; revision: number; root_action_id: string | null }
    return encode({ artifactId: row.artifact_id, attemptId: row.attempt_id, rootActionId: row.root_action_id, projectId: '', epoch: '', fingerprint: {},
      revision: row.revision, text: '', textHash: createHash('sha256').update('', 'utf8').digest('hex') })
  } },
]

/** 绑定只按树检查：打开时查没静止的树，导出与备份前查全部（ADR-0030 决定 1）。 */
const BINDING: AdmittedLedgerCell = { table: 'generation_runs', column: 'binding_json', nullable: false,
  neutral: () => encode({ projectId: '', epoch: '', fingerprint: {}, contextSnapshotId: '', sourceManifest: {}, sourceRefs: [] }) }
const CELLS = [...ADMITTED_LEDGER_CELLS.slice(0, 2), BINDING, ...ADMITTED_LEDGER_CELLS.slice(2)]

/** 没静止、没封存的根：启动恢复要落到暂停与终态的，也是打开作品时要查绑定的树。两处共用这一条。 */
export const UNSETTLED_ROOTS = `SELECT root_action_id FROM generation_roots WHERE blocked_code IS NOT '${GENERATION_LEDGER_UNREADABLE}'
  AND (json_extract(action_json,'$.status')='active' OR root_action_id IN (SELECT root_action_id FROM generation_attempts
    WHERE json_extract(attempt_json,'$.status') IN ('reserved','dispatch-marked')))`

// rowid 是 64 位整数，超过 2^53 时按 number 读会落到相邻行，扫描和定位一律按 bigint 读。
// BLOB 里的合法 JSON 过不了导出投影，`null` 过得了 json_valid；合法对象后跟 NUL 时 json_valid 只看到 NUL 之前，JSON.parse 看全部。
// NUL 按字符查：UTF-16 库里转成 BLOB 的健康文本也带零字节。
export const readableLedgerJson = (column: string) => `CASE WHEN typeof(${column})='text' AND instr(${column},char(0))=0 AND json_valid(${column}) THEN json_type(${column})='object' ELSE 0 END`
/** readableLedgerJson 的 JS 写法，按主键读出整格时用，免得再让 SQLite 解析一遍。 */
export function parseLedgerObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.includes('\u0000')) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
}
const scanOf = (cell: AdmittedLedgerCell, scope = '1') => {
  const owner = OWNERS[cell.table]
  return `SELECT ${CELLS.indexOf(cell)} AS cell, rowid AS row, ${owner.idColumn} AS id, ${owner.rootRow} AS rootRow, ${owner.runRow} AS runRow,
    hex(CAST(${cell.column} AS BLOB)) AS hex FROM ${cell.table}
    WHERE (${scope}) AND ${cell.nullable ? `${cell.column} IS NOT NULL AND ` : ''}NOT ${readableLedgerJson(cell.column)}`
}
const SCAN = ADMITTED_LEDGER_CELLS.map(cell => scanOf(cell)).join(' UNION ALL ') + ' ORDER BY cell'
// 封存要往它们的绑定里记原始字节，所以这两类运行的绑定另外查。
const sealing = `root_action_id IN (SELECT root_action_id FROM generation_roots WHERE rowid IN (SELECT value FROM json_each(?)))
  OR rowid IN (SELECT value FROM json_each(?))`
const BINDING_SCAN = { open: scanOf(BINDING, `root_action_id IN (${UNSETTLED_ROOTS}) OR ${sealing}`), whole: scanOf(BINDING, `1 OR ${sealing}`) }

export interface LedgerAdmission {
  /** 这次打开新封存的根数，主键为 NULL 的根也算。 */
  sealedRootCount: number
}

/** 只读，可在任意连接上跑。 */
export function ledgerNeedsAdmission(db: Db, scope: 'open' | 'whole' = 'open'): boolean {
  // 选没静止的树要读 action_json、attempt_json，它们读得出才能查绑定。
  return db.prepare(SCAN).safeIntegers().get() !== undefined || db.prepare(BINDING_SCAN[scope]).safeIntegers().get('[]', '[]') !== undefined
}

/**
 * 读不出的格子就地换成中性值，所属的根改写 blocked_code 并停表，原始字节和根上原来的阻断码记进所属运行绑定的 `$ledgerUnreadable`。
 * 打开作品、拿到可写句柄之后按 `open` 调一次，绑定只查没静止的树；导出与备份前按 `whole` 调，绑定查全部。
 */
export function admitGenerationLedger(db: Db, scope: 'open' | 'whole' = 'open'): LedgerAdmission {
  if (!ledgerNeedsAdmission(db, scope)) return { sealedRootCount: 0 }
  const scan = db.prepare(SCAN).safeIntegers(), bindings = db.prepare(BINDING_SCAN[scope]).safeIntegers()
  type Bad = { cell: bigint; row: bigint; id: string | null; rootRow: bigint | null; runRow: bigint | null; hex: string }
  const rows = (values: (bigint | null)[]) => `[${[...new Set(values.filter(value => value !== null))].join(',')}]`
  const neutralize = (bad: Bad[]) => {
    for (const item of bad) {
      const cell = CELLS[Number(item.cell)]!
      db.prepare(`UPDATE ${cell.table} SET ${cell.column}=? WHERE rowid=?`).run(cell.neutral(db, item.row), item.row)
    }
    return bad
  }
  const sealed = db.transaction(() => {
    const now = Date.now()
    // 拿到写锁后重扫：扫描到加锁之间别的连接可能已经修好了某一格。
    const bad = neutralize(scan.all() as Bad[])
    bad.push(...neutralize(bindings.all(rows(bad.map(item => item.rootRow)), rows(bad.map(item => item.runRow))) as Bad[]))
    bad.sort((a, b) => Number(a.cell - b.cell))
    // 中性值全部写完再记账：记账那条运行自己的绑定可能也在这批坏格子里。
    // 原值按文本存：包成对象再放进数组会加深两层，可能超过 SQLite 的嵌套上限。
    const kept = `(binding_json->'$."$ledgerUnreadable"')`
    const keep = db.prepare(`UPDATE generation_runs SET binding_json=json_set(binding_json,'$."$ledgerUnreadable"',
      json_insert(CASE WHEN ${kept} IS NULL THEN '[]' WHEN json_type(${kept})='array' THEN ${kept} ELSE json_array(json_object('previous',''||${kept})) END,
      '$[#]',json(?))) WHERE rowid=?`)
    for (const item of bad) {
      const cell = CELLS[Number(item.cell)]!
      // 没有运行的根无处记账，原始字节不保留。
      if (item.runRow !== null) keep.run(encode({ table: cell.table, recordId: item.id, column: cell.column, hex: item.hex }), item.runRow)
    }
    const previous = db.prepare(`SELECT root_action_id AS id, blocked_code AS code, ${OWNERS.generation_roots.runRow} AS runRow FROM generation_roots WHERE rowid=?`).safeIntegers()
    const block = db.prepare(`UPDATE generation_roots SET blocked_code=?,
      active_elapsed_ms=active_elapsed_ms+COALESCE(MAX(0,?-active_since_ms),0), active_since_ms=NULL WHERE rowid=?`)
    // 封存的根不会再推进，进行中的尝试按「没发出」或「不知道发没发出」落到终态。
    const settle = db.prepare(`UPDATE generation_attempts SET attempt_json=json_set(attempt_json,'$.status',
      CASE json_extract(attempt_json,'$.status') WHEN 'reserved' THEN 'cancelled-before-dispatch' ELSE 'unknown' END)
      WHERE root_action_id=? AND json_extract(attempt_json,'$.status') IN ('reserved','dispatch-marked')`)
    // 找不到所属根的坏格子（孤儿行）只换中性值，没有根可封存。
    const rootRows = [...new Set(bad.map(item => item.rootRow).filter((row): row is bigint => row !== null))]
    return rootRows.map(rootRow => {
      const prior = previous.get(rootRow) as { id: string | null; code: string | null; runRow: bigint | null }
      if (prior.code && prior.code !== GENERATION_LEDGER_UNREADABLE && prior.runRow !== null)
        keep.run(encode({ table: 'generation_roots', recordId: prior.id, column: 'blocked_code', previous: prior.code }), prior.runRow)
      block.run(GENERATION_LEDGER_UNREADABLE, now, rootRow)
      if (prior.id !== null) settle.run(prior.id)
      return prior.id
    })
  }).immediate()
  if (sealed.length) {
    sealings.set(db, (sealings.get(db) ?? 0) + 1)
    console.warn(`[generation] ${GENERATION_LEDGER_UNREADABLE} sealed`, { rootActionIds: sealed })
  }
  return { sealedRootCount: sealed.length }
}
