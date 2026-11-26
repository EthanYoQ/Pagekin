import { BUILTIN_PRESETS } from './provider-presets'

export interface RerankEndpoint {
  baseUrl: string
  apiKey: string
  modelName: string
}

export type RerankUnavailableReason =
  | 'not-configured'
  | 'embedding-not-siliconflow'
  | 'auto-reuse-not-enabled'
  | 'profile-missing'
  | 'profile-not-rerank'

export type RerankConfig =
  | { kind: 'none'; reason: RerankUnavailableReason }
  | { kind: 'explicit'; profileId: string; endpoint: RerankEndpoint }
  | { kind: 'reuse-embedding'; endpoint: RerankEndpoint }

interface StoredProfile {
  id: string
  purposes?: readonly string[]
  modelName?: string
  baseUrl?: string
  apiKey?: string
}

interface EmbeddingEndpoint {
  provider: string
  baseUrl: string
  apiKey: string
}

export interface RerankConfigInput {
  defaultRerankModelId: unknown
  models: readonly StoredProfile[]
  embedding: EmbeddingEndpoint | null
  autoReuseEmbedding?: boolean
}

const AUTO_REUSE_EMBEDDING = false

const SILICONFLOW = BUILTIN_PRESETS.find(preset => preset.provider === 'siliconflow')!
const SILICONFLOW_HOSTS = new Set([SILICONFLOW.baseUrl, ...(SILICONFLOW.budgetCapabilityBaseUrls ?? [])].map(url => new URL(url).hostname))

function parseUrl(url: string): URL | null {
  try {
    return new URL(url.trim())
  } catch {
    return null
  }
}

function isSiliconflowEndpoint(embedding: EmbeddingEndpoint): boolean {
  const url = parseUrl(embedding.baseUrl)
  return embedding.provider === SILICONFLOW.provider
    && url?.protocol === 'https:'
    && url.port === ''
    && SILICONFLOW_HOSTS.has(url.hostname)
}

export function resolveRerankConfig({ defaultRerankModelId, models, embedding, autoReuseEmbedding = AUTO_REUSE_EMBEDDING }: RerankConfigInput): RerankConfig {
  if (typeof defaultRerankModelId === 'string' && defaultRerankModelId) {
    const profile = models.find(model => model.id === defaultRerankModelId)
    if (!profile) return { kind: 'none', reason: 'profile-missing' }
    if (!profile.purposes?.includes('rerank')) return { kind: 'none', reason: 'profile-not-rerank' }
    return {
      kind: 'explicit',
      profileId: profile.id,
      endpoint: { baseUrl: profile.baseUrl ?? '', apiKey: profile.apiKey ?? '', modelName: profile.modelName ?? '' },
    }
  }
  if (!embedding) return { kind: 'none', reason: 'not-configured' }
  if (!isSiliconflowEndpoint(embedding)) return { kind: 'none', reason: 'embedding-not-siliconflow' }
  if (!autoReuseEmbedding) return { kind: 'none', reason: 'auto-reuse-not-enabled' }
  return {
    kind: 'reuse-embedding',
    endpoint: { baseUrl: embedding.baseUrl, apiKey: embedding.apiKey, modelName: SILICONFLOW.rerankModels![0]! },
  }
}
