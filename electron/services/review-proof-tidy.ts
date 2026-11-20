import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'

import { parseLedgerObject, readableLedgerJson } from '../repositories/generation-ledger-admission'
import { readReviewProof, reviewProofFields, sealReviewContext } from '../../src/shared/review-proof'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** 已保存的审修运行，连同收据里的上下文哈希。这时还没进门，读不出的收据跳过，不让一格坏账挡住整本的整理。 */
const SAVED_REVIEW_RUNS = `SELECT DISTINCT run_id AS runId, json_extract(usage_receipt_json,'$.reviewRevisionEffect.contextHash') AS receiptHash
  FROM generation_attempts WHERE CASE WHEN ${readableLedgerJson('usage_receipt_json')}
    THEN json_type(usage_receipt_json,'$.reviewRevisionEffect')='object' END`

/**
 * 把已保存、全文验过、收据对得上的 v1 证明就地改成封存形，只换证明三项，其余字段与 `$` 记账原样。
 * 64 KB 以下的不动：留着也是合法的 v1，导出时照样封存。验不过的、收据对不上的、读不出的原样留着。
 * 一个事务做完：中途出错整批不落，下次照现状重筛。
 */
export function sealSavedReviewProofs(db: BetterSqlite3.Database): number {
  const large = db.prepare('SELECT rowid AS row, binding_json AS binding FROM generation_runs WHERE run_id=? AND octet_length(binding_json) > 65536')
  const write = db.prepare('UPDATE generation_runs SET binding_json=? WHERE rowid=?')
  return db.transaction(() => {
    let sealed = 0
    for (const { runId, receiptHash } of db.prepare(SAVED_REVIEW_RUNS).all() as Array<{ runId: string; receiptHash: unknown }>) {
      const found = large.get(runId) as { row: number; binding: unknown } | undefined
      const binding = parseLedgerObject(found?.binding)
      if (!found || !binding) continue
      const proof = readReviewProof(binding.sourceManifest, sha256)
      if (proof.kind !== 'recomputable' || proof.context.version !== 1 || proof.contextHash !== receiptHash) continue
      // 封存形的每章字数取自 v1 配置，M03 要它是非负整数；取不到的封了反而验不过，留着全文。
      const words: unknown = (proof.context.config as { wordsPerChapter?: unknown } | undefined)?.wordsPerChapter
      if (!Number.isSafeInteger(words) || (words as number) < 0) continue
      write.run(JSON.stringify({ ...binding, sourceManifest: { ...binding.sourceManifest as object,
        ...reviewProofFields(sealReviewContext(proof.context, proof.contextHash), sha256) } }), found.row)
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
  let db: BetterSqlite3.Database | undefined, changed = false
  try {
    db = new Database(databasePath, { fileMustExist: true })
    changed = sealSavedReviewProofs(db) > 0
    const free = db.pragma('freelist_count', { simple: true }) as number
    if (free * 2 <= (db.pragma('page_count', { simple: true }) as number)) return changed
    changed = true
    db.exec('VACUUM')
    db.pragma('wal_checkpoint(TRUNCATE)')
    return true
  } catch (error) {
    console.warn('[review-proof] 整理源库没做完，照常打开', { code: (error as { code?: unknown }).code, message: (error as Error).message })
    return changed
  } finally { db?.close() }
}
