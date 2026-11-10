import type { RerankUnavailableReason } from './rerank-config'

/** 产品判断第 9 条：召回 40 段，写稿取 5 段，固定不做配置项。 */
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

/** 配了重排、这次请求没成。没配、取的条数超过候选数这些情况不算，界面不提示。 */
export function isRerankFailure(reason: KnowledgeRankingFallback): reason is RerankFailure {
  return (RERANK_FAILURES as readonly string[]).includes(reason)
}

/** 一次检索的排序方式。不记端点和 Key。 */
export type KnowledgeRanking =
  | { method: 'rerank'; candidateCount: number }
  | { method: 'original'; candidateCount: number; reason: KnowledgeRankingFallback }

export interface KnowledgeSearchHit {
  text: string
  score: number
  fileName: string
  /** 只在这次重排请求失败时出现，结果是原顺序。 */
  rerankFallback?: RerankFailure
}
