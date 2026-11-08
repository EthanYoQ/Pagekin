import { DEFAULT_EMBEDDING_OPTIONS } from './embedding-options'
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from './generation-owner-contract'
import type { ModelProfile } from './ipc-channels'
import { createProviderCatalog, isLocalModelEndpoint, resolveModelProfileBudgetCapabilities, resolveModelProfileCapabilities, resolveModelProfileReasoningMapping } from './provider-presets'

export const DEFAULT_GENERATION_OUTPUT_TOKENS = 65_536

export function modelCapabilitySource(model: ModelProfile, key: keyof NonNullable<ModelProfile['capabilities']>) {
  const source = model.capabilitySources?.[key]
  if (source) return source
  const value = model.capabilities?.[key]
  return typeof value === 'boolean' || typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? 'manual' : 'unknown'
}

export type ContextWindowSource = 'manual' | 'endpoint' | 'preset' | 'default'
export interface ResolvedContextWindow { tokens: number, source: ContextWindowSource }

export const MODEL_VALUE_SOURCE_LABELS: Record<ContextWindowSource, readonly [string, string]> = {
  manual: ['你填的', 'Set by you'],
  endpoint: ['来自服务商', 'From provider'],
  preset: ['内置资料', 'Built-in data'],
  default: ['默认值', 'Default'],
}

const LOCAL_DEFAULT_CONTEXT_WINDOW_TOKENS = 4_096

export function resolveContextWindow(model: ModelProfile): ResolvedContextWindow {
  const value = model.capabilities?.contextWindowTokens
  const stored = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
  const preset = resolveModelProfileBudgetCapabilities(model)?.contextWindowTokens ?? null
  const recorded = model.capabilitySources?.contextWindowTokens
  if (stored !== null) {
    if (recorded === 'endpoint' || recorded === 'preset') return { tokens: stored, source: recorded }
    return { tokens: stored, source: !recorded && stored === preset ? 'preset' : 'manual' }
  }
  if (preset !== null) return { tokens: preset, source: 'preset' }
  return { tokens: isLocalModelEndpoint(model) ? LOCAL_DEFAULT_CONTEXT_WINDOW_TOKENS : DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'default' }
}

export function clearContextWindowOverride(model: ModelProfile, discoveredTokens?: number): ModelProfile {
  const capabilitySources: NonNullable<ModelProfile['capabilitySources']> = {}
  for (const key of ['maxOutputTokens', 'reasoning', 'structuredOutput', 'usage'] as const) capabilitySources[key] = modelCapabilitySource(model, key)
  capabilitySources.contextWindowTokens = 'unknown'
  const cleared = applyModelProfileSelection({ ...model, capabilitySources }, {},
    discoveredTokens === undefined ? {} : { contextWindowTokens: discoveredTokens })
  return { ...cleared, maxTokens: model.maxTokens }
}

/** One explicit model selection seam; refreshing a list never calls it. */
export function applyModelProfileSelection(model: ModelProfile,
  selection: Partial<Pick<ModelProfile, 'provider' | 'protocol' | 'baseUrl' | 'modelName'>>,
  declared?: Partial<NonNullable<ModelProfile['capabilities']>>): ModelProfile {
  const next = { ...model, ...selection }
  const sameIdentity = next.modelName === model.modelName && next.baseUrl === model.baseUrl && next.protocol === model.protocol
  if (!declared && sameIdentity) return next
  const capacity = resolveModelProfileBudgetCapabilities(next)
  const features = resolveModelProfileCapabilities(next)
  const previousCap = model.capabilities?.maxOutputTokens
  const maxTokens = typeof previousCap === 'number' && Number.isSafeInteger(previousCap) && previousCap > 0
    ? Math.min(model.maxTokens, previousCap) : model.maxTokens
  // Persist operational limits separately from the catalog's provider maxima.
  // In particular, a new model cannot overwrite a smaller author output limit.
  const preset = { ...features, ...(capacity ? { contextWindowTokens: capacity.contextWindowTokens,
    maxOutputTokens: capacity.maxOutputTokens } : {}),
    ...(!features && resolveModelProfileReasoningMapping({ ...next, reasoningMapping: undefined }) ? { reasoning: true } : {}) }
  let capabilities = { contextWindowTokens: null, maxOutputTokens: maxTokens,
    reasoning: false, structuredOutput: false, usage: false } as NonNullable<ModelProfile['capabilities']>
  const capabilitySources: NonNullable<ModelProfile['capabilitySources']> = {}
  for (const key of ['contextWindowTokens', 'maxOutputTokens', 'reasoning', 'structuredOutput', 'usage'] as const) {
    const oldSource = modelCapabilitySource(model, key)
    const retainManual = sameIdentity && oldSource === 'manual' && (model.capabilities?.[key] ?? null) !== null
    const retainEndpoint = sameIdentity && oldSource === 'endpoint' && declared?.[key] === undefined
    const value = retainManual || retainEndpoint ? model.capabilities?.[key] : declared?.[key] ?? preset[key]
    capabilitySources[key] = retainManual ? 'manual' : retainEndpoint || declared?.[key] !== undefined ? 'endpoint'
      : preset[key] !== undefined ? 'preset' : 'unknown'
    if (value !== undefined) capabilities = { ...capabilities, [key]: value }
  }
  return { ...next, maxTokens, capabilitySources,
    reasoningOverride: sameIdentity ? model.reasoningOverride : 'auto',
    ...(!sameIdentity && model.reasoningMapping ? { reasoningMapping: undefined } : {}),
    capabilities: Object.values(capabilitySources).some(source => source !== 'unknown') ? capabilities : undefined }
}

/** 创建新模型配置时的输入；不会读取或修改已保存的配置。 */
export interface CreateModelProfileDraftOptions {
  id: string
  purposes: ModelProfile['purposes']
}

/**
 * 为设置界面创建完整的新模型草稿。
 *
 * 生成模型从 OpenAI 端点起步，模型名留空，等作者从端点拉到的列表里选；
 * 向量模型默认使用 SiliconFlow 的免费 BAAI/bge-m3，检索模型页的引导文案按「填上密钥就能用」写。
 */
export function createModelProfileDraft({
  id,
  purposes,
}: CreateModelProfileDraftOptions): ModelProfile {
  const isEmbedding = purposes.includes('embedding')
  const provider = isEmbedding ? 'siliconflow' : 'openai'
  const preset = createProviderCatalog().find((candidate) => candidate.provider === provider)
  if (!preset) throw new Error(`Missing built-in provider preset: ${provider}`)

  const modelName = isEmbedding ? (preset.embeddingModels[0] ?? '') : ''
  const capabilities = isEmbedding ? preset.embeddingModelCapabilities?.[modelName] : undefined

  return {
    id,
    name: isEmbedding ? `${preset.displayName ?? preset.provider} ${modelName}` : '',
    provider,
    protocol: preset.protocol as ModelProfile['protocol'],
    modelName,
    apiKey: '',
    baseUrl: preset.baseUrl,
    temperature: 0.7,
    maxTokens: isEmbedding ? capabilities?.maxOutputTokens ?? 4096 : DEFAULT_GENERATION_OUTPUT_TOKENS,
    capabilities: capabilities ? { ...capabilities } : undefined,
    purposes: [...purposes],
    ...(isEmbedding ? { embeddingOptions: { ...DEFAULT_EMBEDDING_OPTIONS } } : {}),
  }
}
