import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'

import { versionedProofFieldsOk } from '../migrations/m03-review-cycle'
import { parseLedgerObject, readableLedgerJson } from '../repositories/generation-ledger-admission'
import { readReviewProof, reviewProofFields, sealReviewContext } from '../../src/shared/review-proof'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** 已保存的审修运行及收据里的上下文哈希。此时账本还没进门，读不出的收据直接跳过。 */
const SAVED_REVIEW_RUNS = `SELECT DISTINCT run_id AS runId, json_extract(usage_receipt_json,'$.reviewRevisionEffect.contextHash') AS receiptHash
  FROM generation_attempts WHERE CASE WHEN ${readableLedgerJson('usage_receipt_json')}
    THEN json_type(usage_receipt_json,'$.reviewRevisionEffect')='object' END`

/**
 * 能封存的行和封存后的绑定，只读。已保存、验过、收据对得上的 v1，封存前后 M03 的版本相关核对都过、其余字段不变：
 * 循环原来验不过的，封了也不能变成验得过。64 KB 以下的不动：留着也是合法的 v1，导出时照样封存。
 */
function* sealableProofs(db: BetterSqlite3.Database): Generator<{ runId: string; binding: string }> {
  const large = db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=? AND octet_length(binding_json) > 65536').pluck()
  for (const { runId, receiptHash } of db.prepare(SAVED_REVIEW_RUNS).all() as Array<{ runId: string; receiptHash: unknown }>) {
    const binding = parseLedgerObject(large.get(runId))
    if (!binding) continue
    const proof = readReviewProof(binding.sourceManifest, sha256)
    if (proof.kind !== 'recomputable' || proof.context.version !== 1 || proof.contextHash !== receiptHash) continue
    if (!versionedProofFieldsOk(proof.context as unknown as Record<string, unknown>)) continue
    const sealed = sealReviewContext(proof.context, proof.contextHash)
    if (!versionedProofFieldsOk(sealed as unknown as Record<string, unknown>)) continue
    // 封存丢掉假值的 confirmation、recheck；M03 判显式的假值为坏、缺省为好，丢了会改结论。
    if (['confirmation', 'recheck'].some(key => key in proof.context && !(key in sealed))) continue
    yield { runId, binding: JSON.stringify({ ...binding, sourceManifest: { ...binding.sourceManifest as object, ...reviewProofFields(sealed, sha256) } }) }
  }
}

/** 就地封存，只换证明三项。按 run_id 写回：rowid 可能超出 JS 的安全整数。单事务提交，中途出错整批不落。 */
export function sealSavedReviewProofs(db: BetterSqlite3.Database): number {
  const write = db.prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=?')
  return db.transaction(() => {
    let sealed = 0
    for (const { runId, binding } of [...sealableProofs(db)]) sealed += write.run(binding, runId).changes
    return sealed
  }).immediate()
}

const mostlyFree = (db: BetterSqlite3.Database) =>
  (db.pragma('freelist_count', { simple: true }) as number) * 2 > (db.pragma('page_count', { simple: true }) as number)

const warn = (error: unknown) =>
  console.warn('[review-proof] 整理源库没做完，照常打开', { code: (error as { code?: unknown }).code, message: (error as Error).message })

/**
 * 打开作品时在 worker 里整理源库：封存旧证明，空闲页过半就 VACUUM（只看空闲页，封存后被打断，下次打开照样缩）。
 * 先用只读连接看有没有要做的：可写连接关闭时会把遗留的 WAL 并回主文件，改掉内容身份。
 * 失败只记警告，不挡打开。返回是否开过可写连接，开过则调用方要重算内容身份。
 */
export function tidyReviewProofs(databasePath: string): boolean {
  let reader: BetterSqlite3.Database | undefined
  try {
    reader = new Database(databasePath, { readonly: true, fileMustExist: true })
    if (sealableProofs(reader).next().done && !mostlyFree(reader)) return false
  } catch (error) {
    warn(error)
    return false
  } finally { reader?.close() }
  let db: BetterSqlite3.Database | undefined
  try {
    db = new Database(databasePath, { fileMustExist: true })
    sealSavedReviewProofs(db)
    if (mostlyFree(db)) {
      db.exec('VACUUM')
      db.pragma('wal_checkpoint(TRUNCATE)')
    }
  } catch (error) { warn(error) } finally { db?.close() }
  return true
}
