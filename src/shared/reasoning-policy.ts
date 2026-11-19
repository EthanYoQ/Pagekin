import type { ModelProfile } from './ipc-channels'
import { resolveModelProfileReasoningMapping } from './provider-presets'
import type {
  CreativeStrategy,
  EffectiveReasoningEffort,
  GenerationReasoningStage,
  ProviderReasoningDirective,
  ReasoningEffort,
  ReasoningPolicyResolution,
  VerifiedReasoningMapping,
} from './reasoning-types'
import { CREATIVE_STRATEGIES, isGeminiThinkingLevel, REASONING_EFFORTS } from './reasoning-types'

// extraction 是定稿后从正文整理要点和角色状态。思考 token 占这两步九成以上的耗时，作者要等它们完成才能写下一章。
const STAGE_REQUESTS: Readonly<Record<CreativeStrategy, Readonly<Record<GenerationReasoningStage, ReasoningEffort>>>> = {
  auto: { drafting: 'low', planning: 'medium', review: 'high', general: 'low', extraction: 'off' },
  'fluent-drafting': { drafting: 'off', planning: 'low', review: 'low', general: 'low', extraction: 'off' },
  'consistency-first': { drafting: 'low', planning: 'high', review: 'high', general: 'medium', extraction: 'off' },
  'deep-planning': { drafting: 'low', planning: 'max', review: 'high', general: 'medium', extraction: 'off' },
}

const EFFORT_RANK: Readonly<Record<ReasoningEffort, number>> = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
}

function providerDirective(
  mapping: VerifiedReasoningMapping,
  effective: EffectiveReasoningEffort,
): ProviderReasoningDirective | undefined {
  const value = mapping.providerValues[effective]
  if (mapping.adapter === 'siliconflow-v4-thinking') {
    return (effective === 'high' || effective === 'max') && value === effective
      ? { adapter: mapping.adapter, reasoningEffort: effective }
      : undefined
  }
  if (mapping.adapter === 'openai-reasoning-effort') {
    return typeof value === 'string' && value.trim().length > 0
      ? { adapter: mapping.adapter, reasoningEffort: value }
      : undefined
  }
  if (mapping.adapter === 'deepseek-v4-thinking') {
    if (effective === 'off' && value === 'disabled') {
      return { adapter: mapping.adapter, thinking: 'disabled' }
    }
    if (effective !== 'off' && value === 'enabled') return { adapter: mapping.adapter, thinking: 'enabled' }
    return effective !== 'off' && (value === 'low' || value === 'high' || value === 'max')
      ? {
          adapter: mapping.adapter,
          thinking: 'enabled',
          reasoningEffort: value,
        }
      : undefined
  }
  if (mapping.adapter === 'gemini-thinking-level') {
    return isGeminiThinkingLevel(value) ? { adapter: mapping.adapter, thinkingLevel: value } : undefined
  }
  return typeof value === 'number'
    ? { adapter: mapping.adapter, thinkingBudget: value }
    : undefined
}

function closestEffectiveEffort(
  requested: ReasoningEffort,
  mapping: VerifiedReasoningMapping,
): { effective: EffectiveReasoningEffort; status: 'mapped' | 'capped' | 'forced' } | null {
  const documentedAlias = mapping.requestAliases?.[requested]
  if (documentedAlias && mapping.supportedEfforts.includes(documentedAlias)) {
    return { effective: documentedAlias, status: 'mapped' }
  }
  if (mapping.supportedEfforts.includes(requested)) {
    return { effective: requested, status: 'mapped' }
  }
  const supported = [...mapping.supportedEfforts]
    .sort((left, right) => EFFORT_RANK[left] - EFFORT_RANK[right])
  if (supported.length === 0) return null
  // Gemini 3 关不掉思考，也有型号拒收 minimal；不发参数会落到服务商的默认档（常是 medium 或 high），所以取最低档。
  if (requested === 'off') return mapping.adapter === 'gemini-thinking-level' ? { effective: supported[0], status: 'forced' } : null

  const lowerOrEqual = supported.filter(effort => EFFORT_RANK[effort] <= EFFORT_RANK[requested])
  return {
    effective: lowerOrEqual.at(-1) ?? supported[0],
    status: 'capped',
  }
}

/**
 * The single reasoning-policy seam. Callers provide product intent; this
 * module owns profile precedence, verified capability lookup,
 * provider-level capping and the user-visible resolution receipt.
 */
export function resolveReasoningPolicy(input: {
  model: ModelProfile
  creativeStrategy?: CreativeStrategy
  stage?: GenerationReasoningStage
}): ReasoningPolicyResolution {
  const resolution = resolveStageReasoning(input)
  // 关不掉思考的服务商，提取照旧按审稿的档位发。
  return input.stage === 'extraction' && resolution.status === 'unsupported'
    ? resolveStageReasoning({ ...input, stage: 'review' })
    : resolution
}

function resolveStageReasoning(input: Parameters<typeof resolveReasoningPolicy>[0]): ReasoningPolicyResolution {
  const strategy = CREATIVE_STRATEGIES.includes(input.creativeStrategy as CreativeStrategy)
    ? input.creativeStrategy as CreativeStrategy
    : 'auto'
  const persistedOverride = input.model.reasoningOverride
  const override = persistedOverride === 'auto'
    || REASONING_EFFORTS.includes(persistedOverride as ReasoningEffort)
    ? persistedOverride ?? 'auto'
    : 'auto'
  const source = override === 'auto' ? 'project-strategy' : 'model-override'
  const requested = override === 'auto'
    ? STAGE_REQUESTS[strategy][input.stage ?? 'general']
    : override
  const mapping = resolveModelProfileReasoningMapping(input.model)
  if (!mapping) return { requested, effective: null, status: 'unsupported', source }
  // Only explicitly selected application budgets are defined for this Qwen integration.
  if (!input.model.reasoningMapping && input.model.modelName === 'Qwen/Qwen3.8-27B'
    && (source !== 'model-override' || requested !== 'medium' && requested !== 'off')) {
    return { requested, effective: null, status: 'unsupported', source }
  }
  // Only explicit, documented SiliconFlow choices are supported. Preserve
  // automatic requests and never force off/low/medium up to high.
  if (!input.model.reasoningMapping && mapping.adapter === 'siliconflow-v4-thinking') {
    // 自动档只有提取会关思考（enable_thinking:false 实测可用）；其余阶段仍交给服务商默认。
    if (source === 'project-strategy' && input.stage === 'extraction') {
      return { requested, effective: 'off', status: 'mapped', source, providerDirective: { adapter: mapping.adapter, reasoningEffort: 'off' } }
    }
    if (source !== 'model-override' || requested !== 'high' && requested !== 'max') {
      return { requested, effective: null, status: 'unsupported', source }
    }
  }

  const resolved = closestEffectiveEffort(requested, mapping)
  if (!resolved) return { requested, effective: null, status: 'unsupported', source }
  const directive = providerDirective(mapping, resolved.effective)
  if (!directive) return { requested, effective: null, status: 'unsupported', source }
  return {
    requested,
    effective: resolved.effective,
    status: resolved.status,
    source,
    providerDirective: directive,
  }
}
