import type { RerankUnavailableReason } from './rerank-config'

export const RERANK_CANDIDATE_COUNT = 40
export const WRITING_KNOWLEDGE_COUNT = 5

const RERANK_FAILURES = ['timeout', 'request-failed', 'http-error', 'invalid-response'] as const
export type RerankFailure = (typeof RERANK_FAILURES)[number]

export type KnowledgeRankingFallback =
  | RerankUnavailableReason
  | RerankFailure
  | 'no-candidates'
  | 'top-k-exceeds-candidates'
  | 'source-changed'

export function isRerankFailure(reason: KnowledgeRankingFallback): reason is RerankFailure {
  return (RERANK_FAILURES as readonly string[]).includes(reason)
}

export type KnowledgeRanking =
  | { method: 'rerank'; candidateCount: number }
  | { method: 'original'; candidateCount: number; reason: KnowledgeRankingFallback }

export interface KnowledgeSearchHit {
  text: string
  score: number
  fileName: string
  rerankFallback?: RerankFailure
}
