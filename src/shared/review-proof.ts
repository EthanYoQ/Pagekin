import type { ReviewRevisionContext } from './review-revision-generation'

/** 落盘的审修证明。现在只有 v1 全文形：上下文原样冻结，哈希可由它重算。 */
export type ReviewProofRead =
  | { kind: 'absent' }
  | { kind: 'unproven' }
  | { kind: 'recomputable'; context: ReviewRevisionContext; contextJson: string; contextHash: string }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** 审修证明的唯一解析点。字段是否齐全、来源是否当前由调用方按各自的规则判。 */
export function readReviewProof(manifest: unknown, sha256: (text: string) => string): ReviewProofRead {
  const stored = record(manifest)
  if (stored?.reviewRevisionContext === undefined) return { kind: 'absent' }
  const context = record(stored.reviewRevisionContext), source = record(context?.source)
  if (!context || context.version !== 1 || typeof source?.content !== 'string') return { kind: 'unproven' }
  const contextJson = JSON.stringify(context), contextHash = sha256(contextJson)
  return stored.reviewRevisionContextHash === contextHash && context.sourceHash === sha256(source.content)
    && JSON.stringify(stored.authorInputs) === JSON.stringify([{ id: 'review-revision-context', text: contextJson }])
    ? { kind: 'recomputable', context: context as unknown as ReviewRevisionContext, contextJson, contextHash }
    : { kind: 'unproven' }
}

/** 冻结的来源稿身份，不验证明，只用来给验不过的循环指章节。 */
export function frozenReviewSource(manifest: unknown): Record<string, unknown> | undefined {
  return record(record(record(manifest)?.reviewRevisionContext)?.source)
}
