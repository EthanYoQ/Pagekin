import type Database from 'better-sqlite3'
import { GENERATION_LEDGER_UNREADABLE } from './generation-ledger-admission'

/** 一次点击的身份：根的 idempotency_key 去掉冻结输入哈希。 */
export interface GenerationClick { projectId: string; operation: string; uiActionNonce: string }

export function clickOfRootKey(key: unknown): GenerationClick | undefined {
    if (typeof key !== 'string') return undefined
    try {
        const parts: unknown = JSON.parse(key)
        return Array.isArray(parts) && parts.length >= 3 && parts.slice(0, 3).every(part => typeof part === 'string')
            ? { projectId: parts[0], operation: parts[1], uiActionNonce: parts[2] } : undefined
    } catch {
        return undefined
    }
}

export function clickOfOpenKey(openKey: unknown): GenerationClick | undefined {
    if (typeof openKey !== 'string') return undefined
    try {
        const outer: unknown = JSON.parse(openKey)
        return Array.isArray(outer) ? clickOfRootKey(outer[0]) : undefined
    } catch {
        return undefined
    }
}

export function uiActionNonceOfOpenKey(openKey: string): string | undefined {
    return clickOfOpenKey(openKey)?.uiActionNonce
}

/** 一条运行的身份，只取插入后不变的列，不读任何绑定。 */
export interface RunIndexEntry {
    readonly runId: string
    /** rowid，表示创建先后。可能超过 2^53，所以是 bigint。 */
    readonly order: bigint
    readonly click: GenerationClick | undefined
    /** 所在的根被进门封存。 */
    readonly sealed: boolean
}

export interface RunLookup {
    /** 身份对上的运行，旧的在前，封存的也在里面。 */
    readonly hits: readonly RunIndexEntry[]
    /** 身份读不出、不知道对不对得上的运行。不含封存的树，那归 sealedClaims 管。 */
    readonly unidentified: readonly RunIndexEntry[]
}

export interface GenerationRunIndex {
    lookup(matches: (click: GenerationClick) => boolean): RunLookup
}

/** 点击号正好是 nonce，或以 nonce 加冒号开头：Agent 会话的各轮。 */
export const inNonceChain = (nonce: string) => (click: GenerationClick) => click.uiActionNonce === nonce || click.uiActionNonce.startsWith(`${nonce}:`)

/**
 * 给 `run_id IN (SELECT value FROM json_each(?))` 绑定的参数：命中的和身份读不出的都算候选。
 * 候选只按身份键取（ADR-0030「跨记录认运行」），查询再按绑定筛；写入时断言绑定与点击的操作一致。
 */
export function candidateRunIds(lookup: RunLookup, skip?: ReadonlySet<string>): string {
    return JSON.stringify([...lookup.hits, ...lookup.unidentified].map(entry => entry.runId).filter(runId => !skip?.has(runId)))
}

interface Snapshot { entries: RunIndexEntry[]; top: bigint; count: bigint; sealed: ReadonlySet<string> }

const snapshots = new WeakMap<Database.Database, Snapshot>()

function entryOf(row: { row: bigint; run_id: string; root_action_id: string; open_key: unknown }, sealed: ReadonlySet<string>): RunIndexEntry {
    return { runId: row.run_id, order: row.row, click: clickOfOpenKey(row.open_key), sealed: sealed.has(row.root_action_id) }
}

function fullScan(db: Database.Database, sealed: ReadonlySet<string>): RunIndexEntry[] {
    // open_key 排在绑定后面，按表读要走绑定的溢出页；按 open_key 排序让查询只扫唯一索引。
    const keys = new Map((db.prepare('SELECT rowid AS row, open_key FROM generation_runs ORDER BY open_key').safeIntegers().all() as { row: bigint; open_key: unknown }[])
        .map(row => [row.row, row.open_key]))
    return (db.prepare('SELECT rowid AS row, run_id, root_action_id FROM generation_runs ORDER BY rowid').safeIntegers().all() as { row: bigint; run_id: string; root_action_id: string }[])
        .map(row => entryOf({ ...row, open_key: keys.get(row.row) }, sealed))
}

/**
 * 运行只增不删，身份列插入后不变，封存只发生在打开作品时的进门。所以按句柄缓存已提交的条目，
 * 行数或最大 rowid 变了就补读。事务里读到的行可能随回滚消失、rowid 被重用，只用不存。
 */
function entries(db: Database.Database): readonly RunIndexEntry[] {
    const { count, top } = db.prepare('SELECT count(*) AS count, coalesce(max(rowid), 0) AS top FROM generation_runs').safeIntegers().get() as { count: bigint; top: bigint }
    const prior = snapshots.get(db)
    if (prior && prior.count === count && prior.top === top) return prior.entries
    const sealed = prior?.sealed ?? new Set(db.prepare('SELECT root_action_id FROM generation_roots WHERE blocked_code=?').pluck().all(GENERATION_LEDGER_UNREADABLE) as string[])
    let next: RunIndexEntry[] | undefined
    if (prior) {
        const added = (db.prepare('SELECT rowid AS row, run_id, root_action_id, open_key FROM generation_runs WHERE rowid>? ORDER BY rowid').safeIntegers().all(prior.top) as { row: bigint; run_id: string; root_action_id: string; open_key: unknown }[])
            .map(row => entryOf(row, sealed))
        // rowid 到顶以后 SQLite 会挑更小的空号，补读看不到，这时整表重读。
        if (BigInt(prior.entries.length + added.length) === count) next = [...prior.entries, ...added]
    }
    next ??= fullScan(db, sealed)
    if (!db.inTransaction) snapshots.set(db, { entries: next, top, count, sealed })
    return next
}

export function runIndexOf(db: Database.Database): GenerationRunIndex {
    return {
        lookup: matches => {
            const all = entries(db)
            return { hits: all.filter(entry => entry.click !== undefined && matches(entry.click)), unidentified: all.filter(entry => entry.click === undefined && !entry.sealed) }
        },
    }
}
