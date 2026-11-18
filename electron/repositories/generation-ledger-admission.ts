import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

export const GENERATION_LEDGER_UNREADABLE = 'GENERATION_LEDGER_UNREADABLE'

type LedgerTable = 'generation_roots' | 'generation_runs' | 'generation_attempts' | 'generation_artifacts'
type Db = Database.Database

const OWNERS: Record<LedgerTable, { idColumn: string; root: string; run: string }> = {
  generation_roots: { idColumn: 'root_action_id', root: 'root_action_id',
    run: '(SELECT r.run_id FROM generation_runs r WHERE r.root_action_id=generation_roots.root_action_id ORDER BY r.rowid LIMIT 1)' },
  generation_runs: { idColumn: 'run_id', root: 'root_action_id', run: 'run_id' },
  generation_attempts: { idColumn: 'attempt_id', root: 'root_action_id', run: 'run_id' },
  generation_artifacts: { idColumn: 'artifact_id', run: 'run_id',
    root: '(SELECT t.root_action_id FROM generation_attempts t WHERE t.attempt_id=generation_artifacts.attempt_id)' },
}

export interface AdmittedLedgerCell {
  table: LedgerTable
  column: string
  nullable: boolean
  /** 契约类型的合法取值，并且不会被任何跨记录查询的条件选中。 */
  neutral(db: Db, recordId: string): string
}

const encode = (value: unknown) => JSON.stringify(value)

/** 进门检查覆盖的列，守卫测试也读它。 */
export const ADMITTED_LEDGER_CELLS: readonly AdmittedLedgerCell[] = [
  { table: 'generation_roots', column: 'action_json', nullable: false, neutral: (_db, id) => encode({ projectId: '', epoch: '', operation: 'ledger-unreadable',
    uiActionNonce: '', frozenInputHash: '', rootActionId: id, status: 'paused' }) },
  { table: 'generation_roots', column: 'budget_json', nullable: false, neutral: () => encode({ maxPhysicalRequests: 1, maxTokenLiability: 1, maxOutputPerRequest: 1, maxActiveElapsedMs: 1 }) },
  { table: 'generation_runs', column: 'binding_json', nullable: false, neutral: () => encode({ projectId: '', epoch: '', fingerprint: {}, contextSnapshotId: '', sourceManifest: {}, sourceRefs: [] }) },
  { table: 'generation_attempts', column: 'attempt_json', nullable: false, neutral: (db, id) => {
    const row = db.prepare('SELECT reservation_id,root_action_id FROM generation_attempts WHERE attempt_id=?').get(id) as { reservation_id: string; root_action_id: string }
    return encode({ attemptId: id, reservationId: row.reservation_id, rootActionId: row.root_action_id, status: 'unknown', reservedTokens: 1, requestedOutputTokens: 1 })
  } },
  { table: 'generation_attempts', column: 'usage_receipt_json', nullable: true, neutral: () => '{}' },
  { table: 'generation_artifacts', column: 'artifact_json', nullable: false, neutral: (db, id) => {
    const row = db.prepare('SELECT a.attempt_id,a.revision,t.root_action_id FROM generation_artifacts a JOIN generation_attempts t ON t.attempt_id=a.attempt_id WHERE a.artifact_id=?')
      .get(id) as { attempt_id: string; revision: number; root_action_id: string }
    return encode({ artifactId: id, attemptId: row.attempt_id, rootActionId: row.root_action_id, projectId: '', epoch: '', fingerprint: {},
      revision: row.revision, text: '', textHash: createHash('sha256').update('', 'utf8').digest('hex') })
  } },
]

// BLOB 里的合法 JSON 过不了导出投影，`null` 过得了 json_valid；合法对象后跟 NUL 时 json_valid 只看到 NUL 之前，JSON.parse 看全部。
const readable = (column: string) => `CASE WHEN typeof(${column})='text' AND instr(CAST(${column} AS BLOB),x'00')=0 AND json_valid(${column}) THEN json_type(${column})='object' ELSE 0 END`
const SCAN = ADMITTED_LEDGER_CELLS.map((cell, index) => {
  const owner = OWNERS[cell.table]
  return `SELECT ${index} AS cell, ${owner.idColumn} AS id, ${owner.root} AS root, ${owner.run} AS run, hex(CAST(${cell.column} AS BLOB)) AS hex FROM ${cell.table}
    WHERE ${cell.nullable ? `${cell.column} IS NOT NULL AND ` : ''}NOT ${readable(cell.column)}`
}).join(' UNION ALL ') + ' ORDER BY cell'

export interface LedgerAdmission {
  /** 这次打开新封存的根。作品没有读不出的格子时为空，且没有任何写入。 */
  sealedRootActionIds: readonly string[]
}

/**
 * 打开作品、拿到可写句柄之后调用一次。读不出的格子就地换成中性值，所属的根写 blocked_code，
 * 原始字节记进所属运行绑定的 `$ledgerUnreadable`。之后这个句柄上的跨记录查询和 JSON.parse 不会碰到读不出的格子。
 */
export function admitGenerationLedger(db: Db): LedgerAdmission {
  const bad = db.prepare(SCAN).all() as { cell: number; id: string; root: string; run: string | null; hex: string }[]
  if (!bad.length) return { sealedRootActionIds: [] }
  const roots = [...new Set(bad.map(item => item.root))]
  db.transaction(() => {
    for (const item of bad) {
      const cell = ADMITTED_LEDGER_CELLS[item.cell]!
      db.prepare(`UPDATE ${cell.table} SET ${cell.column}=? WHERE ${OWNERS[cell.table].idColumn}=?`).run(cell.neutral(db, item.id), item.id)
    }
    // 中性值全部写完再记账：记账那条运行自己的绑定可能也在这批坏格子里。
    // 记账区原来不是数组时，原值包成第一条，不丢也不让追加失败。
    const kept = `binding_json->'$."$ledgerUnreadable"'`
    const keep = db.prepare(`UPDATE generation_runs SET binding_json=json_set(binding_json,'$."$ledgerUnreadable"',
      json_insert(CASE WHEN ${kept} IS NULL THEN '[]' WHEN json_type(${kept})='array' THEN ${kept} ELSE json_array(json_object('previous',json(${kept}))) END,
      '$[#]',json(?))) WHERE run_id=?`)
    for (const item of bad) {
      const cell = ADMITTED_LEDGER_CELLS[item.cell]!
      // 没有运行的根无处记账，原始字节不保留。
      if (item.run) keep.run(encode({ table: cell.table, recordId: item.id, column: cell.column, hex: item.hex }), item.run)
    }
    const block = db.prepare('UPDATE generation_roots SET blocked_code=COALESCE(blocked_code,?) WHERE root_action_id=?')
    for (const root of roots) block.run(GENERATION_LEDGER_UNREADABLE, root)
  }).immediate()
  console.warn(`[generation] ${GENERATION_LEDGER_UNREADABLE} sealed`, { rootActionIds: roots })
  return { sealedRootActionIds: roots }
}
