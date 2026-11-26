import { reviewRevisionContextV2, type ReviewRevisionContext, type ReviewRevisionContextV1, type ReviewRevisionContextV2 } from './review-revision-generation'

export type SealedReviewRevisionContext = ReviewRevisionContextV2 & { rewrittenFrom: 1 }

export function sealReviewContext(context: ReviewRevisionContextV1, contextHash: string): SealedReviewRevisionContext {
  return { ...reviewRevisionContextV2(context, contextHash), rewrittenFrom: 1 }
}

export function reviewProofFields(context: object, sha256: (text: string) => string) {
  const contextJson = JSON.stringify(context)
  return { reviewRevisionContext: context, reviewRevisionContextHash: sha256(contextJson),
    authorInputs: [{ id: 'review-revision-context', text: contextJson }] }
}

export type ReviewProofRead =
  | { kind: 'absent' }
  | { kind: 'unproven' }
  | { kind: 'recomputable'; context: ReviewRevisionContext; contextJson: string; contextHash: string }
  | { kind: 'sealed'; context: SealedReviewRevisionContext; contextJson: string; contextHash: string }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

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
