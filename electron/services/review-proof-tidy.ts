import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'

import { readReviewProof, sealReviewContext } from '../../src/shared/review-proof'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * 已保存、前文全文还在的审修证明行，连同收据里的上下文哈希。64 KB 以下的不看：留着也是合法的 v1，导出时照样封存。
 * 坏记录（读不出的 JSON）跳过，不让一行坏账挡住整本的整理。
 */
const FULL_SAVED_PROOFS = `SELECT r.rowid AS row, json_extract(t.usage_receipt_json,'$.reviewRevisionEffect.contextHash') AS receiptHash
  FROM generation_attempts t JOIN generation_runs r ON r.run_id=t.run_id
  WHERE json_valid(t.usage_receipt_json) AND json_type(t.usage_receipt_json,'$.reviewRevisionEffect')='object'
    AND octet_length(r.binding_json) > 65536 AND json_valid(r.binding_json)
    AND json_type(r.binding_json,'$.sourceManifest.reviewRevisionContext.history')='array'`

/**
 * 把全文验过、收据对得上的行就地改成封存形，只换证明三项，其余字段与 `$` 记账原样。验不过的、收据对不上的原样留着。
 * 一个事务做完：中途出错整批不落，下次照现状重筛。
 */
export function sealSavedReviewProofs(db: BetterSqlite3.Database): number {
  const read = db.prepare('SELECT binding_json FROM generation_runs WHERE rowid=?').pluck()
  const write = db.prepare('UPDATE generation_runs SET binding_json=? WHERE rowid=?')
  return db.transaction(() => {
    let sealed = 0
    for (const { row, receiptHash } of db.prepare(FULL_SAVED_PROOFS).all() as Array<{ row: number; receiptHash: unknown }>) {
      const binding = JSON.parse(read.get(row) as string)
      const proof = readReviewProof(binding.sourceManifest, sha256)
      if (proof.kind !== 'recomputable' || proof.context.version !== 1 || proof.contextHash !== receiptHash) continue
      const context = sealReviewContext(proof.context, proof.contextHash), contextJson = JSON.stringify(context)
      write.run(JSON.stringify({ ...binding, sourceManifest: { ...binding.sourceManifest, reviewRevisionContext: context,
        reviewRevisionContextHash: sha256(contextJson), authorInputs: [{ id: 'review-revision-context', text: contextJson }] } }), row)
      sealed++
    }
    return sealed
  }).immediate()
}

/**
 * 打开作品时在 worker 里整理源库：封存旧证明，空闲页过半就 VACUUM。缩不缩看库的现状，封存提交后、缩之前被打断，下次打开照样缩。
 * 整理不是打开的前提，失败只记一条警告。返回是否可能改过库：改过调用方要重算内容身份。
 */
export function tidyReviewProofs(databasePath: string): boolean {
  let db: BetterSqlite3.Database | undefined
  try {
    db = new Database(databasePath, { fileMustExist: true })
    const sealed = sealSavedReviewProofs(db)
    const free = db.pragma('freelist_count', { simple: true }) as number
    if (free * 2 <= (db.pragma('page_count', { simple: true }) as number)) return sealed > 0
    db.exec('VACUUM')
    db.pragma('wal_checkpoint(TRUNCATE)')
    return true
  } catch (error) {
    console.warn('[review-proof] 整理源库没做完，照常打开', { code: (error as { code?: unknown }).code, message: (error as Error).message })
    return true
  } finally { db?.close() }
}
