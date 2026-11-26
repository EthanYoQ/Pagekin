import type { VerifiedReasoningMapping } from './reasoning-types'
import { isReasoningMapping, reasoningAdapterFitsProtocol } from './reasoning-types'

export interface ModelPreset {
  name: string
  capabilities?: ModelCapabilities
  structuredOutput?: boolean
  budgetCapabilities?: ModelBudgetCapabilities
  reasoningMapping?: VerifiedReasoningMapping
  maxTokens: number
}

export interface ModelBudgetCapabilities {
  contextWindowTokens: number
  maxOutputTokens: number
  evidence: {
    sourceUrl: string
    calibration: 'conservative-provider-documentation'
  }
}

export interface ResolvedModelBudgetCapabilities {
  contextWindowTokens: number
  maxOutputTokens: number
  evidence?: ModelBudgetCapabilities['evidence']
}

export interface ModelCapabilities {
  contextWindowTokens: number | null
  maxOutputTokens: number
  reasoning: boolean
  structuredOutput: boolean
  usage: boolean
}

export interface ModelCapabilityProfile {
  provider?: unknown
  protocol?: unknown
  baseUrl?: unknown
  modelName?: unknown
  maxTokens?: unknown
  capabilities?: ModelCapabilities | null
  reasoningMapping?: VerifiedReasoningMapping
}

export interface ProviderPreset {
  provider: string
  displayName?: string
  baseUrl: string
  budgetCapabilityBaseUrls?: string[]
  budgetProviderAliases?: string[]
  protocol: string
  models: ModelPreset[]
  retiredModels?: ModelPreset[]
  embeddingModels: string[]
  embeddingModelCapabilities?: Record<string, ModelCapabilities>
  rerankModels?: string[]
}

function geminiThinkingLevelPreset(name: string, supportsMinimal: boolean): ModelPreset {
  return {
    name,
    maxTokens: 65_536,
    capabilities: {
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 65_536,
      reasoning: true,
      structuredOutput: true,
      usage: true,
    },
    reasoningMapping: {
      adapter: 'gemini-thinking-level',
      supportedEfforts: supportsMinimal ? ['off', 'low', 'medium', 'high'] : ['low', 'medium', 'high'],
      providerValues: { ...(supportsMinimal ? { off: 'minimal' } : {}), low: 'low', medium: 'medium', high: 'high' },
    },
  }
}

export function createProviderCatalog(): ProviderPreset[] {
  return [
  {
    provider: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    budgetCapabilityBaseUrls: ['https://api.openai.com/v1'],
    protocol: 'openai',
    models: [
      {
        name: 'gpt-4.1',
        maxTokens: 16_384,
        budgetCapabilities: {
          contextWindowTokens: 1_047_576,
          maxOutputTokens: 32_768,
          evidence: {
            sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-4.1',
            calibration: 'conservative-provider-documentation',
          },
        },
      },
      {
        name: 'gpt-4.1-2025-04-14',
        maxTokens: 16_384,
        budgetCapabilities: {
          contextWindowTokens: 1_047_576,
          maxOutputTokens: 32_768,
          evidence: {
            sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-4.1',
            calibration: 'conservative-provider-documentation',
          },
        },
      },
      {
        name: 'o3',
        maxTokens: 16_384,
        budgetCapabilities: {
          contextWindowTokens: 200_000,
          maxOutputTokens: 100_000,
          evidence: {
            sourceUrl: 'https://developers.openai.com/api/docs/models/o3',
            calibration: 'conservative-provider-documentation',
          },
        },
      },
      {
        name: 'gpt-4o',
        maxTokens: 16384,
        budgetCapabilities: {
          contextWindowTokens: 128_000,
          maxOutputTokens: 16_384,
          evidence: {
            sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-4o',
            calibration: 'conservative-provider-documentation',
          },
        },
      },
      {
        name: 'gpt-4o-mini',
        maxTokens: 16384,
        budgetCapabilities: {
          contextWindowTokens: 128_000,
          maxOutputTokens: 16_384,
          evidence: {
            sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-4o-mini',
            calibration: 'conservative-provider-documentation',
          },
        },
      },
      {
        name: 'gpt-4-turbo',
        maxTokens: 4096,
        budgetCapabilities: {
          contextWindowTokens: 128_000,
          maxOutputTokens: 4_096,
          evidence: {
            sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-4-turbo',
            calibration: 'conservative-provider-documentation',
          },
        },
      },
      {
        name: 'gpt-3.5-turbo',
        maxTokens: 4096,
        budgetCapabilities: {
          contextWindowTokens: 16_385,
          maxOutputTokens: 4_096,
          evidence: {
            sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-3.5-turbo',
            calibration: 'conservative-provider-documentation',
          },
        },
      }
    ],
    embeddingModels: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'],
  },
  {
    provider: 'xai',
    displayName: 'xAI(Grok)',
    baseUrl: 'https://api.x.ai/v1',
    protocol: 'openai',
    models: [
      {
        name: 'grok-4.5',
        maxTokens: 8192,
        capabilities: {
          contextWindowTokens: 500_000,
          maxOutputTokens: 8192,
          reasoning: true,
          structuredOutput: true,
          usage: true,
        },
        reasoningMapping: {
          adapter: 'openai-reasoning-effort',
          supportedEfforts: ['low', 'medium', 'high'],
          providerValues: { low: 'low', medium: 'medium', high: 'high' },
        },
      },
    ],
    embeddingModels: [],
  },
  {
    provider: 'siliconflow',
    displayName: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    budgetCapabilityBaseUrls: ['https://api.siliconflow.com/v1'],
    budgetProviderAliases: ['openai'],
    protocol: 'openai',
    models: [
      {
        name: 'deepseek-ai/DeepSeek-V4-Flash',
        structuredOutput: true,
        reasoningMapping: {
          adapter: 'siliconflow-v4-thinking',
          supportedEfforts: ['high', 'max'],
          providerValues: { high: 'high', max: 'max' },
        },
        maxTokens: 16_384,
        budgetCapabilities: {
          contextWindowTokens: 1_000_000,
          maxOutputTokens: 393_000,
          evidence: {
            sourceUrl: 'https://www.siliconflow.com/models/deepseek-v4-flash',
            calibration: 'conservative-provider-documentation',
          },
        },
      },
      {
        name: 'deepseek-ai/DeepSeek-V4.1-Flash',
        reasoningMapping: {
          adapter: 'siliconflow-v4-thinking',
          supportedEfforts: ['high', 'max'],
          providerValues: { high: 'high', max: 'max' },
        },
        maxTokens: 16_384,
      },
      {
        name: 'deepseek-ai/DeepSeek-V4-Pro',
        structuredOutput: true,
        reasoningMapping: {
          adapter: 'siliconflow-v4-thinking',
          supportedEfforts: ['high', 'max'],
          providerValues: { high: 'high', max: 'max' },
        },
        maxTokens: 16_384,
        budgetCapabilities: {
          contextWindowTokens: 1_000_000,
          maxOutputTokens: 393_000,
          evidence: {
            sourceUrl: 'https://www.siliconflow.com/models/deepseek-v4-pro',
            calibration: 'conservative-provider-documentation',
          },
        },
      },
      {
        name: 'Qwen/Qwen3.8-27B',
        structuredOutput: true,
        reasoningMapping: {
          adapter: 'openai-thinking-budget',
          supportedEfforts: ['off', 'medium'],
          providerValues: { off: 0, medium: 16_384 },
        },
        maxTokens: 16_384,
        budgetCapabilities: {
          contextWindowTokens: 262_144,
          maxOutputTokens: 16_384,
          evidence: {
            sourceUrl: 'https://www.siliconflow.cn/models',
            calibration: 'conservative-provider-documentation',
          },
        },
      },
    ],
    embeddingModels: ['BAAI/bge-m3'],
    rerankModels: ['BAAI/bge-reranker-v2-m3'],
    embeddingModelCapabilities: {
      'BAAI/bge-m3': {
        contextWindowTokens: 8192,
        maxOutputTokens: 0,
        reasoning: false,
        structuredOutput: false,
        usage: true,
      },
    },
  },
  {
    provider: 'novelai',
    displayName: 'NovelAI',
    baseUrl: 'https://text.novelai.net/oa',
    protocol: 'openai',
    models: [],
    embeddingModels: [],
  },
  {
    provider: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai',
    models: [
      {
        name: 'deepseek-v4-flash',
        maxTokens: 384_000,
        capabilities: {
          contextWindowTokens: 1_000_000,
          maxOutputTokens: 384_000,
          reasoning: true,
          structuredOutput: true,
          usage: true,
        },
        reasoningMapping: {
          adapter: 'deepseek-v4-thinking',
          supportedEfforts: ['off', 'low', 'high', 'max'],
          providerValues: { off: 'disabled', low: 'low', high: 'high', max: 'max' },
          requestAliases: { medium: 'high' },
        },
      },
      {
        name: 'deepseek-v4-pro',
        maxTokens: 384_000,
        capabilities: {
          contextWindowTokens: 1_000_000,
          maxOutputTokens: 384_000,
          reasoning: true,
          structuredOutput: true,
          usage: true,
        },
        reasoningMapping: {
          adapter: 'deepseek-v4-thinking',
          supportedEfforts: ['off', 'low', 'high', 'max'],
          providerValues: { off: 'disabled', low: 'low', high: 'high', max: 'max' },
          requestAliases: { medium: 'high' },
        },
      },
    ],
    embeddingModels: [],
  },
  {
    provider: 'bigmodel',
    displayName: 'BigModel（智谱）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai',
    models: [
      { name: 'glm-4.5', maxTokens: 65536 },
      { name: 'glm-4.5-air', maxTokens: 65536 },
      { name: 'glm-4.6', maxTokens: 65536 },
      { name: 'glm-4.7', maxTokens: 65536 },
      { name: 'glm-4.7-flashx', maxTokens: 65536 },
      { name: 'glm-5-turbo', maxTokens: 65536 },
      { name: 'glm-5', maxTokens: 65536 },
      {
        name: 'glm-5.3', maxTokens: 65_536, structuredOutput: true,
        budgetCapabilities: {
          contextWindowTokens: 1_000_000, maxOutputTokens: 131_072,
          evidence: {
            sourceUrl: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3',
            calibration: 'conservative-provider-documentation',
          },
        },
        reasoningMapping: {
          adapter: 'openai-reasoning-effort',
          supportedEfforts: ['low', 'high', 'max'],
          providerValues: { low: 'low', high: 'high', max: 'max' },
        },
      },
    ],
    embeddingModels: ['embedding-3'],
    rerankModels: ['rerank'],
  },
  {
    provider: 'bigmodel-anthropic',
    displayName: 'BigModel（智谱 Anthropic）',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    protocol: 'anthropic',
    models: [
      { name: 'glm-4.5', maxTokens: 65536 },
      { name: 'glm-4.5-air', maxTokens: 65536 },
      { name: 'glm-4.6', maxTokens: 65536 },
      { name: 'glm-4.7', maxTokens: 65536 },
      { name: 'glm-4.7-flashx', maxTokens: 65536 },
      { name: 'glm-5-turbo', maxTokens: 65536 },
      { name: 'glm-5', maxTokens: 65536 },
      {
        name: 'glm-5.3', maxTokens: 65_536,
        budgetCapabilities: {
          contextWindowTokens: 1_000_000, maxOutputTokens: 131_072,
          evidence: {
            sourceUrl: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3',
            calibration: 'conservative-provider-documentation',
          },
        },
      },
    ],
    embeddingModels: [],
  },
  {
    provider: 'gemini',
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    protocol: 'gemini',
    models: [
      geminiThinkingLevelPreset('gemini-3.8-flash', false),
      geminiThinkingLevelPreset('gemini-3.5-flash-lite', true),
      geminiThinkingLevelPreset('gemini-3.1-pro-preview', false),
      geminiThinkingLevelPreset('gemini-3-flash-preview', true),
    ],
    retiredModels: [
      {
        name: 'gemini-2.5-flash-lite',
        maxTokens: 65536,
        capabilities: {
          contextWindowTokens: 1_048_576,
          maxOutputTokens: 65_536,
          reasoning: true,
          structuredOutput: true,
          usage: true,
        },
        reasoningMapping: {
          adapter: 'gemini-thinking-budget',
          supportedEfforts: ['off', 'low', 'medium', 'high'],
          providerValues: { off: 0, low: 1_024, medium: 8_192, high: 24_576 },
        },
      },
    ],
    embeddingModels: ['gemini-embedding-001'],
  },
  {
    provider: 'ollama',
    displayName: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    protocol: 'openai',
    models: [
      { name: 'qwen3-14b-abliterated-novel-q4', maxTokens: 8192 },
      { name: 'llama3.3', maxTokens: 4096 },
      { name: 'llama3.2', maxTokens: 4096 },
      { name: 'qwen2.5', maxTokens: 8192 },
      { name: 'qwen2.5-coder', maxTokens: 8192 },
      { name: 'mistral', maxTokens: 4096 },
      { name: 'phi4', maxTokens: 4096 },
      { name: 'gemma3', maxTokens: 8192 },
    ],
    embeddingModels: ['nomic-embed-text', 'mxbai-embed-large', 'bge-m3'],
  },
  {
    provider: 'custom',
    displayName: '自定义',
    baseUrl: '',
    protocol: 'openai',
    models: [],
    embeddingModels: [],
  },
  ]
}

export const BUILTIN_PRESETS: ProviderPreset[] = createProviderCatalog()

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

export function parseHttpEndpoint(baseUrl: string): URL | null {
  const trimmed = baseUrl.trim()
  if (!URL.canParse(trimmed)) return null
  const endpoint = new URL(trimmed)
  return endpoint.protocol === 'http:' || endpoint.protocol === 'https:' ? endpoint : null
}

export function isLocalModelEndpoint({ provider, baseUrl }: { provider: string, baseUrl: string }): boolean {
  return provider === 'ollama' || LOCAL_HOSTNAMES.has(parseHttpEndpoint(baseUrl)?.hostname ?? '')
}

export function hasRequiredApiKey(model: { provider: string, baseUrl: string, apiKey: string }): boolean {
  return Boolean(model.apiKey.trim()) || isLocalModelEndpoint(model)
}

function normalizedOfficialBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const endpoint = new URL(value.trim())
    if (
      (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:')
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash
    ) return null
    endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '') || '/'
    if (endpoint.origin === 'https://api.deepseek.com' && endpoint.pathname === '/v1') endpoint.pathname = '/'
    return endpoint.toString().replace(/\/$/u, '')
  } catch {
    return null
  }
}

function validatedCapabilities(value: unknown): ModelCapabilities | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<ModelCapabilities>
  const validContext = candidate.contextWindowTokens === null
    || (Number.isSafeInteger(candidate.contextWindowTokens) && Number(candidate.contextWindowTokens) > 0)
  if (
    !validContext
    || !Number.isSafeInteger(candidate.maxOutputTokens)
    || Number(candidate.maxOutputTokens) <= 0
    || typeof candidate.reasoning !== 'boolean'
    || typeof candidate.structuredOutput !== 'boolean'
    || typeof candidate.usage !== 'boolean'
  ) return undefined
  return {
    contextWindowTokens: candidate.contextWindowTokens as number | null,
    maxOutputTokens: candidate.maxOutputTokens as number,
    reasoning: candidate.reasoning,
    structuredOutput: candidate.structuredOutput,
    usage: candidate.usage,
  }
}

function validatedBudgetCapabilities(value: unknown): ModelBudgetCapabilities | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<ModelBudgetCapabilities>
  const evidence = candidate.evidence as Partial<ModelBudgetCapabilities['evidence']> | undefined
  if (
    !Number.isSafeInteger(candidate.contextWindowTokens)
    || Number(candidate.contextWindowTokens) <= 0
    || !Number.isSafeInteger(candidate.maxOutputTokens)
    || Number(candidate.maxOutputTokens) <= 0
    || typeof evidence?.sourceUrl !== 'string'
    || evidence.sourceUrl.length === 0
    || evidence.calibration !== 'conservative-provider-documentation'
  ) return undefined
  return {
    contextWindowTokens: candidate.contextWindowTokens as number,
    maxOutputTokens: candidate.maxOutputTokens as number,
    evidence: {
      sourceUrl: evidence.sourceUrl,
      calibration: evidence.calibration,
    },
  }
}

function catalogModel(preset: ProviderPreset, modelName: string): ModelPreset | undefined {
  return preset.models.find(candidate => candidate.name === modelName)
    ?? preset.retiredModels?.find(candidate => candidate.name === modelName)
}

function matchesBudgetCapabilityEndpoint(preset: ProviderPreset, baseUrl: unknown): boolean {
  const endpoint = normalizedOfficialBaseUrl(baseUrl)
  if (!endpoint) return false
  return [preset.baseUrl, ...(preset.budgetCapabilityBaseUrls ?? [])]
    .some(candidate => endpoint === normalizedOfficialBaseUrl(candidate))
}

export function resolveModelProfileBudgetCapabilities(
  profile: ModelCapabilityProfile,
): ResolvedModelBudgetCapabilities | undefined {
  if (
    typeof profile.protocol !== 'string'
    || typeof profile.modelName !== 'string'
  ) return undefined

  const protocol = profile.protocol
  const modelName = profile.modelName.trim()
  const preset = BUILTIN_PRESETS.find(candidate => candidate.protocol === protocol && matchesBudgetCapabilityEndpoint(candidate, profile.baseUrl))
  if (
    !preset
  ) return undefined

  const model = catalogModel(preset, modelName)
  if (modelName === 'Qwen/Qwen3.8-27B'
    && normalizedOfficialBaseUrl(profile.baseUrl) !== 'https://api.siliconflow.cn/v1') return undefined
  const dedicated = validatedBudgetCapabilities(model?.budgetCapabilities)
  if (dedicated) return dedicated

  const capabilities = validatedCapabilities(model?.capabilities)
  if (!capabilities || capabilities.contextWindowTokens === null) return undefined
  return {
    contextWindowTokens: capabilities.contextWindowTokens,
    maxOutputTokens: capabilities.maxOutputTokens,
  }
}

export function resolveModelProfileCapabilities(
  profile: ModelCapabilityProfile,
): ModelCapabilities | undefined {
  if (
    typeof profile.protocol !== 'string'
    || typeof profile.modelName !== 'string'
  ) return undefined

  const protocol = profile.protocol
  const modelName = profile.modelName.trim()
  const preset = BUILTIN_PRESETS.find(candidate => candidate.protocol === protocol
    && normalizedOfficialBaseUrl(profile.baseUrl) === normalizedOfficialBaseUrl(candidate.baseUrl))
  if (
    !preset
    || preset.protocol !== protocol
    || normalizedOfficialBaseUrl(profile.baseUrl) !== normalizedOfficialBaseUrl(preset.baseUrl)
  ) {
    return undefined
  }

  const model = catalogModel(preset, modelName)
  return validatedCapabilities(model?.capabilities)
}

export function resolveModelProfileStructuredOutput(profile: ModelCapabilityProfile): boolean | undefined {
  if (typeof profile.protocol !== 'string' || typeof profile.modelName !== 'string') return undefined
  const modelName = profile.modelName.trim()
  const preset = BUILTIN_PRESETS.find(candidate => candidate.protocol === profile.protocol
    && normalizedOfficialBaseUrl(profile.baseUrl) === normalizedOfficialBaseUrl(candidate.baseUrl))
  return preset ? catalogModel(preset, modelName)?.structuredOutput : undefined
}

export function resolveModelProfileReasoningMapping(
  profile: ModelCapabilityProfile,
): VerifiedReasoningMapping | undefined {
  if (profile.reasoningMapping !== undefined) {
    const mapping = profile.reasoningMapping
    return isReasoningMapping(mapping)
      && reasoningAdapterFitsProtocol(profile.protocol, mapping.adapter)
      ? mapping : undefined
  }
  if (
    typeof profile.protocol !== 'string'
    || typeof profile.modelName !== 'string'
  ) return undefined

  const protocol = profile.protocol
  const modelName = profile.modelName.trim()
  const preset = BUILTIN_PRESETS.find(candidate => candidate.protocol === protocol
    && normalizedOfficialBaseUrl(profile.baseUrl) === normalizedOfficialBaseUrl(candidate.baseUrl))
  if (!preset) return undefined

  const mapping = catalogModel(preset, modelName)
    ?.reasoningMapping
  if (!mapping) return undefined
  return {
    adapter: mapping.adapter,
    supportedEfforts: [...mapping.supportedEfforts],
    providerValues: { ...mapping.providerValues },
    ...(mapping.requestAliases ? { requestAliases: { ...mapping.requestAliases } } : {}),
  }
}
