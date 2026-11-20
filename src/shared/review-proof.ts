import { reviewRevisionContextV2, type ReviewRevisionContext, type ReviewRevisionContextV1, type ReviewRevisionContextV2 } from './review-revision-generation'

/** 封存的 v1 证明：只留 v2 字段，inputHash 取原 v1 上下文的哈希，也就是收据里的 contextHash（ADR-0031）。 */
export type SealedReviewRevisionContext = ReviewRevisionContextV2 & { rewrittenFrom: 1 }

/** 已保存、全文验过的 v1 证明才能封存：收据里的原哈希放进 inputHash，前文等材料不再留着。导出投影和源库整理共用。 */
export function sealReviewContext(context: ReviewRevisionContextV1, contextHash: string): SealedReviewRevisionContext {
  return { ...reviewRevisionContextV2(context, contextHash), rewrittenFrom: 1 }
}

/** 清单里的证明三项：上下文、它的哈希、作者输入里的同一份全文。导出投影和源库整理都按这个写。 */
export function reviewProofFields(context: object, sha256: (text: string) => string) {
  const contextJson = JSON.stringify(context)
  return { reviewRevisionContext: context, reviewRevisionContextHash: sha256(contextJson),
    authorInputs: [{ id: 'review-revision-context', text: contextJson }] }
}

/** contextHash 是收据里应记的哈希。sealed 的这个哈希只能和收据比，不能从证明重算。 */
export type ReviewProofRead =
  | { kind: 'absent' }
  | { kind: 'unproven' }
  | { kind: 'recomputable'; context: ReviewRevisionContext; contextJson: string; contextHash: string }
  | { kind: 'sealed'; context: SealedReviewRevisionContext; contextJson: string; contextHash: string }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** 只验证明自洽：全文、哈希、作者输入副本互相印证。字段是否齐全、来源是否当前由调用方判。 */
export function readReviewProof(manifest: unknown, sha256: (text: string) => string): ReviewProofRead {
  const stored = record(manifest)
  if (stored?.reviewRevisionContext === undefined) return { kind: 'absent' }
  const context = record(stored.reviewRevisionContext), source = record(context?.source)
  if (!context || context.version !== 1 && context.version !== 2 || typeof source?.content !== 'string') return { kind: 'unproven' }
  const contextJson = JSON.stringify(context), contextHash = sha256(contextJson)
  if (stored.reviewRevisionContextHash !== contextHash || context.sourceHash !== sha256(source.content)
    || JSON.stringify(stored.authorInputs) !== JSON.stringify([{ id: 'review-revision-context', text: contextJson }])) return { kind: 'unproven' }
  return context.version === 2 && context.rewrittenFrom === 1
    ? { kind: 'sealed', context: context as unknown as SealedReviewRevisionContext, contextJson, contextHash: String(context.inputHash) }
    : { kind: 'recomputable', context: context as unknown as ReviewRevisionContext, contextJson, contextHash }
}

export function unverifiedReviewSource(manifest: unknown): Record<string, unknown> | undefined {
  return record(record(record(manifest)?.reviewRevisionContext)?.source)
}
