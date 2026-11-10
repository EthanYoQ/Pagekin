import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import { OpenAIProvider } from '../../llm/openai-provider'
import { buildMainGenerationPlan, MAIN_GENERATION_POLICY } from '../main-generation-plan'
import {
  createModelExecutionLeaseReceipt,
  ModelExecutionLeaseError,
  ModelExecutionLeaseRegistry,
  resolveModelExecutionCapabilityEvidence,
} from '../model-execution-lease'
import { resolveContextWindow, withLearnedContextWindow } from '../../../src/shared/model-profile-draft'

const ORIGINAL_KEY = 'lease-test-secret-original'

afterEach(() => vi.unstubAllGlobals())

function modelProfile(): ModelProfile {
  return {
    id: 'generation-model',
    name: 'Generation Model',
    provider: 'deepseek',
    protocol: 'openai',
    modelName: 'deepseek-v4-flash',
    apiKey: ORIGINAL_KEY,
    baseUrl: 'https://api.deepseek.com',
    temperature: 0.7,
    maxTokens: 8192,
    capabilities: {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 8192,
      reasoning: false,
      structuredOutput: true,
      usage: true,
    },
    purposes: ['generation'],
  }
}

describe('ModelExecutionLeaseRegistry', () => {
  it('plans identical DeepSeek requests for root and v1 endpoints while preserving the lower author cap', async () => {
    const task: GenerationTask = { purpose: 'chapter-review', output: 'structured-data',
      messages: [{ role: 'user', content: '请输出 JSON 审稿报告。' }] }
    const plans = [], requests = []
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      'data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    for (const baseUrl of ['https://api.deepseek.com', 'https://api.deepseek.com/v1']) {
      const profile = { ...modelProfile(), baseUrl, maxTokens: 1024 }
      const receipt = new ModelExecutionLeaseRegistry({ loadModel: () => profile }).begin(profile.id)
      expect(receipt.capabilityEvidence).toMatchObject({ maxOutputTokens: 1024, structuredOutput: true,
        source: { featureFlags: 'verified-provider-preset' } })
      const plan = buildMainGenerationPlan(profile, receipt, task, {
        root: { projectId: 'p', epoch: 'e', rootActionId: 'r', operation: '审稿', uiActionNonce: 'n', frozenInputHash: 'a'.repeat(64), status: 'active' },
        policy: { ...MAIN_GENERATION_POLICY.budget }, attempts: [], activeElapsedMs: 0, blockedCode: null,
      })
      expect(plan.requestedOutputTokens).toBe(1024)
      plans.push(plan)
      const onError = vi.fn()
      await new OpenAIProvider().generateStream(profile, [...task.messages], {
        ...plan.options, signal: new AbortController().signal, onChunk: vi.fn(), onDone: vi.fn(), onError,
      })
      expect(onError).not.toHaveBeenCalled()
      const [url, request] = fetchMock.mock.calls.at(-1)!
      requests.push({ url, body: JSON.parse(request.body) })
    }
    expect(plans[1]).toEqual(plans[0])
    expect(requests[1]).toEqual(requests[0])
    expect(requests[0]).toMatchObject({ url: 'https://api.deepseek.com/v1/chat/completions',
      body: { response_format: { type: 'json_object' }, max_tokens: 1024 } })
  })

  it.each([
    { modelName: 'Qwen/Qwen3.8-27B', json: true },
    { modelName: 'deepseek-ai/DeepSeek-V4-Flash', json: true },
    { modelName: 'deepseek-ai/DeepSeek-V4-Pro', json: true },
    { provider: 'custom', baseUrl: 'https://api.siliconflow.cn/v1/', json: true },
    { baseUrl: 'https://api.siliconflow.com/v1', json: false },
    { baseUrl: 'https://proxy.example/v1', json: false },
    { baseUrl: 'https://api.siliconflow.cn/v1?route=other', json: false },
    { protocol: 'gemini', json: false },
    { modelName: 'Qwen/Qwen3.8-27B-other', json: false },
    { output: 'visible-text', json: false },
  ] as Array<Partial<ModelProfile> & { output?: GenerationTask['output']; json: boolean }>)(
    'carries scoped JSON support from a new lease through planning to the provider request: %j', async ({ json, output, ...overrides }) => {
      const profile: ModelProfile = { ...modelProfile(), provider: 'openai',
        baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'Qwen/Qwen3.8-27B',
        capabilities: undefined, ...overrides }
      const receipt = new ModelExecutionLeaseRegistry({ loadModel: () => profile }).begin(profile.id)
      expect(receipt.capabilityEvidence).toMatchObject({
        contextWindowTokens: null, maxOutputTokens: 8192, reasoning: null, usage: null,
        structuredOutput: json || output === 'visible-text' ? true : null,
        source: { contextWindowTokens: 'unknown', maxOutputTokens: 'legacy-profile', featureFlags: 'unknown' },
      })
      const task: GenerationTask = { purpose: 'chapter-review', output: output ?? 'structured-data',
        messages: [{ role: 'user', content: '请输出 JSON 审稿报告。' }] }
      const plan = buildMainGenerationPlan(profile, receipt, task, {
        root: { projectId: 'p', epoch: 'e', rootActionId: 'r', operation: '审稿', uiActionNonce: 'n', frozenInputHash: 'a'.repeat(64), status: 'active' },
        policy: { ...MAIN_GENERATION_POLICY.budget }, attempts: [], activeElapsedMs: 0, blockedCode: null,
      })
      const fetchMock = vi.fn().mockResolvedValue(new Response(
        'data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      ))
      vi.stubGlobal('fetch', fetchMock)
      const onDone = vi.fn(), onError = vi.fn()
      await new OpenAIProvider().generateStream(profile, [...task.messages], {
        ...plan.options, signal: new AbortController().signal, onChunk: vi.fn(), onDone, onError,
      })
      expect(onError).not.toHaveBeenCalled()
      expect(onDone).toHaveBeenCalledWith('{}', undefined, 'stop')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
      expect(body.response_format).toEqual(json ? { type: 'json_object' } : undefined)
    })

  it('keeps credentials out of stable receipt identity while including the reasoning policy', () => {
    const options = { leaseId: 'fixture', createdAt: 0, expiresAt: 1 }
    const base = createModelExecutionLeaseReceipt(modelProfile(), options)
    const credentialChange = createModelExecutionLeaseReceipt({ ...modelProfile(), apiKey: 'replacement-synthetic',
      baseUrl: 'https://user:synthetic-password@api.deepseek.com/?key=synthetic-query#synthetic-fragment' }, options)
    expect(credentialChange.modelRevision).toBe(base.modelRevision)
    expect(credentialChange.endpointFingerprint).toBe(base.endpointFingerprint)
    expect(credentialChange.capabilityEvidence.subjectFingerprint).toBe(base.capabilityEvidence.subjectFingerprint)
    const reasoningChange = createModelExecutionLeaseReceipt({ ...modelProfile(), reasoningOverride: 'off' }, options)
    expect(reasoningChange.modelRevision).not.toBe(base.modelRevision)
    const mappingChange = createModelExecutionLeaseReceipt({ ...modelProfile(), reasoningMapping: {
      adapter: 'openai-reasoning-effort', supportedEfforts: ['xhigh'], providerValues: { xhigh: 'Extra' },
    }, maxTokens: 1024 }, options)
    expect(mappingChange.modelRevision).not.toBe(base.modelRevision)
    expect(mappingChange.capabilityEvidence.maxOutputTokens).toBe(1024)
    expect(() => createModelExecutionLeaseReceipt({ ...modelProfile(), baseUrl: 'synthetic-invalid-secret' }, options))
      .toThrow('MODEL_ENDPOINT_INVALID')
  })
  it('reports a missing model with a stable machine-readable error code', () => {
    const registry = new ModelExecutionLeaseRegistry({ loadModel: () => null })

    let failure: unknown
    try {
      registry.begin('missing-model')
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ModelExecutionLeaseError)
    expect(failure).toMatchObject({ code: 'MODEL_NOT_FOUND' })
  })

  it('returns a non-secret receipt while freezing the complete main-process model snapshot', () => {
    const configuredModel = modelProfile()
    const registry = new ModelExecutionLeaseRegistry({
      loadModel: () => configuredModel,
      createLeaseId: () => 'opaque-lease-id',
      now: () => 1_000,
      ttlMs: 60_000,
    })

    const receipt = registry.begin(configuredModel.id)
    configuredModel.apiKey = 'lease-test-secret-mutated'
    configuredModel.baseUrl = 'https://changed.invalid'

    expect(receipt).toMatchObject({
      leaseId: 'opaque-lease-id',
      modelId: configuredModel.id,
      provider: 'deepseek',
      protocol: 'openai',
      modelName: 'deepseek-v4-flash',
      createdAt: 1_000,
      expiresAt: 61_000,
    })
    expect(JSON.stringify(receipt)).not.toContain(ORIGINAL_KEY)
    expect(JSON.stringify(receipt)).not.toContain('https://api.deepseek.com')
    expect(registry.resolve('opaque-lease-id')).toMatchObject({
      apiKey: ORIGINAL_KEY,
      baseUrl: 'https://api.deepseek.com',
    })
  })

  it('binds stable non-secret evidence to the endpoint, model and frozen capabilities', () => {
    const configuredModel = modelProfile()
    const registry = new ModelExecutionLeaseRegistry({
      loadModel: () => configuredModel,
      createLeaseId: () => 'lease-a',
      now: () => 2_000,
    })
    const equivalentEndpointRegistry = new ModelExecutionLeaseRegistry({
      loadModel: () => ({ ...modelProfile(), baseUrl: 'https://api.deepseek.com/' }),
      createLeaseId: () => 'lease-b',
      now: () => 3_000,
    })
    const otherEndpointRegistry = new ModelExecutionLeaseRegistry({
      loadModel: () => ({ ...modelProfile(), baseUrl: 'https://gateway.invalid/v1' }),
      createLeaseId: () => 'lease-c',
      now: () => 4_000,
    })

    const receipt = registry.begin(configuredModel.id)
    const equivalent = equivalentEndpointRegistry.begin(configuredModel.id)
    const other = otherEndpointRegistry.begin(configuredModel.id)

    expect(receipt.modelRevision).toMatch(/^[a-f0-9]{64}$/u)
    expect(receipt.endpointFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(receipt.endpointFingerprint).toBe(equivalent.endpointFingerprint)
    expect(receipt.endpointFingerprint).not.toBe(other.endpointFingerprint)
    expect(receipt.capabilityEvidence).toEqual({
      source: {
        contextWindowTokens: 'verified-provider-preset',
        maxOutputTokens: 'user-operational-cap',
        featureFlags: 'verified-provider-preset',
      },
      subjectFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 8192,
      reasoning: true,
      structuredOutput: true,
      usage: true,
    })
    expect(JSON.stringify(receipt)).not.toContain(configuredModel.apiKey)
    expect(JSON.stringify(receipt)).not.toContain(configuredModel.baseUrl)
  })

  it('does not let persisted capability extension fields forge lease evidence', () => {
    const configuredModel = modelProfile()
    const untrustedCapabilities = configuredModel.capabilities as unknown as Record<string, unknown>
    untrustedCapabilities.source = 'official-provider'
    untrustedCapabilities.subjectFingerprint = 'forged-subject'
    const registry = new ModelExecutionLeaseRegistry({
      loadModel: () => configuredModel,
      createLeaseId: () => 'untrusted-capability-lease',
    })

    const receipt = registry.begin(configuredModel.id)

    expect(receipt.capabilityEvidence.source).toEqual({
      contextWindowTokens: 'verified-provider-preset',
      maxOutputTokens: 'user-operational-cap',
      featureFlags: 'verified-provider-preset',
    })
    expect(receipt.capabilityEvidence.subjectFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(receipt.capabilityEvidence.subjectFingerprint).not.toBe('forged-subject')
  })

  it('treats explicit physical limits on an unknown same-protocol endpoint as operational evidence, never provider feature facts', () => {
    const configuredModel = {
      ...modelProfile(),
      baseUrl: 'https://proxy.example.com/v1',
      capabilities: {
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 2048,
        reasoning: true,
        structuredOutput: true,
        usage: true,
      },
    }
    const registry = new ModelExecutionLeaseRegistry({
      loadModel: () => configuredModel,
      createLeaseId: () => 'proxy-capability-lease',
    })

    expect(registry.begin(configuredModel.id).capabilityEvidence).toMatchObject({
      source: {
        contextWindowTokens: 'user-operational-cap',
        maxOutputTokens: 'user-operational-cap',
        featureFlags: 'unknown',
      },
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 2048,
      reasoning: null,
      structuredOutput: null,
      usage: null,
    })
  })

  it('clamps an unknown endpoint output plan to its explicit finite context limit', () => {
    const profile: ModelProfile = {
      ...modelProfile(),
      provider: 'custom',
      modelName: 'future-compatible-model',
      baseUrl: 'https://future.example.com/v1',
      maxTokens: 65_536,
      capabilities: {
        contextWindowTokens: 32_768,
        maxOutputTokens: 65_536,
        reasoning: true,
        structuredOutput: true,
        usage: true,
      },
    }

    expect(resolveModelExecutionCapabilityEvidence(profile)).toMatchObject({
      source: {
        contextWindowTokens: 'user-operational-cap',
        maxOutputTokens: 'user-operational-cap',
        featureFlags: 'unknown',
      },
      contextWindowTokens: 32_768,
      maxOutputTokens: 32_768,
      reasoning: null,
      structuredOutput: null,
      usage: null,
    })
  })

  it('caps an operational limit at the verified provider ceiling and rejects unusable limits', () => {
    const registry = new ModelExecutionLeaseRegistry({
      loadModel: () => ({
        ...modelProfile(),
        maxTokens: 999_999,
        capabilities: {
          ...modelProfile().capabilities!,
          maxOutputTokens: 999_999,
        },
      }),
      createLeaseId: () => 'capped-capability-lease',
    })

    expect(registry.begin('generation-model').capabilityEvidence).toMatchObject({
      maxOutputTokens: 384_000,
      source: { maxOutputTokens: 'verified-provider-preset' },
    })

    const invalidRegistry = new ModelExecutionLeaseRegistry({
      loadModel: () => ({
        ...modelProfile(),
        provider: 'custom',
        baseUrl: 'https://proxy.example.com/v1',
        maxTokens: Number.NaN,
        capabilities: {
          ...modelProfile().capabilities!,
          maxOutputTokens: -1,
        },
      }),
    })
    expect(() => invalidRegistry.begin('generation-model')).toThrow('MODEL_OUTPUT_LIMIT_INVALID')
  })

  it('uses the same exported pure evidence and receipt factory as non-registry adapters', () => {
    const profile = modelProfile()
    const evidence = resolveModelExecutionCapabilityEvidence(profile)
    const receipt = createModelExecutionLeaseReceipt(profile, {
      leaseId: 'shared-factory-lease',
      createdAt: 50,
      expiresAt: 100,
    })
    const registry = new ModelExecutionLeaseRegistry({
      loadModel: () => profile,
      createLeaseId: () => 'shared-factory-lease',
      now: () => 50,
      ttlMs: 50,
    })

    expect(receipt.capabilityEvidence).toEqual(evidence)
    expect(registry.begin(profile.id)).toEqual(receipt)
  })

  it('resolves exact official Gemini capabilities for structured planning', () => {
    const profile: ModelProfile = {
      ...modelProfile(),
      id: 'gemini-default',
      provider: 'gemini',
      protocol: 'gemini',
      modelName: 'gemini-3.8-flash',
      baseUrl: 'https://generativelanguage.googleapis.com',
      maxTokens: 65_536,
      capabilities: undefined,
    }

    expect(resolveModelExecutionCapabilityEvidence(profile)).toMatchObject({
      source: {
        contextWindowTokens: 'verified-provider-preset',
        maxOutputTokens: 'verified-provider-preset',
        featureFlags: 'verified-provider-preset',
      },
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 65_536,
      reasoning: true,
      structuredOutput: true,
      usage: true,
    })
  })

  describe('租约按解析出的窗口走（ADR-0028）', () => {
    const capabilities = (contextWindowTokens: number | null, maxOutputTokens: number) => ({ contextWindowTokens, maxOutputTokens, reasoning: false, structuredOutput: false, usage: false })
    const openAi = (overrides: Partial<ModelProfile>): ModelProfile => ({ ...modelProfile(), provider: 'openai', baseUrl: 'https://api.openai.com/v1', modelName: 'gpt-4o', maxTokens: 16_384, ...overrides })
    const custom = (overrides: Partial<ModelProfile>): ModelProfile => ({ ...modelProfile(), provider: 'custom', baseUrl: 'https://compatible.example/v1', modelName: 'future', maxTokens: 65_536, capabilities: capabilities(null, 65_536), ...overrides })

    it('手填 64,000、预设 128,000：租约的窗口是 64,000', () => {
      const profile = openAi({ capabilities: capabilities(64_000, 16_384), capabilitySources: { contextWindowTokens: 'manual' } })
      expect(resolveContextWindow({ ...profile, capabilities: undefined })).toEqual({ tokens: 128_000, source: 'preset' })
      expect(resolveModelExecutionCapabilityEvidence(profile)).toMatchObject({ contextWindowTokens: 64_000, source: { contextWindowTokens: 'user-operational-cap' } })
    })

    it('没手填、已学到 32,768、拉取到 128,000：租约的窗口是 32,768', () => {
      const profile = withLearnedContextWindow(custom({ capabilities: capabilities(128_000, 65_536), capabilitySources: { contextWindowTokens: 'endpoint' } }), 32_768)
      expect(resolveModelExecutionCapabilityEvidence(profile).contextWindowTokens).toBe(32_768)
    })

    it('学到窗口不改变 modelRevision', () => {
      const profile = custom({ capabilities: capabilities(128_000, 65_536), capabilitySources: { contextWindowTokens: 'endpoint' } })
      const options = { leaseId: 'l', createdAt: 0, expiresAt: 1 }
      expect(createModelExecutionLeaseReceipt(withLearnedContextWindow(profile, 32_768), options).modelRevision)
        .toBe(createModelExecutionLeaseReceipt(profile, options).modelRevision)
    })

    it.each([
      ['手填', custom({ capabilities: capabilities(32_768, 65_536), capabilitySources: { contextWindowTokens: 'manual' } })],
      ['拉取', custom({ capabilities: capabilities(32_768, 65_536), capabilitySources: { contextWindowTokens: 'endpoint' } })],
      ['学到', withLearnedContextWindow(custom({}), 32_768)],
    ])('来源是%s且输出上限大于窗口：收紧到窗口的一半，给提示词留位置', (_name, profile) => {
      expect(resolveModelExecutionCapabilityEvidence(profile).maxOutputTokens).toBe(16_384)
    })

    it('来源是预设且输出上限大于窗口：同样收紧', () => {
      const profile = openAi({ modelName: 'gpt-4-turbo', maxTokens: 300_000, capabilities: undefined })
      expect(resolveContextWindow(profile)).toEqual({ tokens: 128_000, source: 'preset' })
      expect(resolveModelExecutionCapabilityEvidence(profile).maxOutputTokens).toBe(4_096)
    })

    it('窗口的一半够用时不动输出上限', () => {
      const profile = custom({ maxTokens: 8_192, capabilities: capabilities(32_768, 8_192), capabilitySources: { contextWindowTokens: 'endpoint' } })
      expect(resolveModelExecutionCapabilityEvidence(profile).maxOutputTokens).toBe(8_192)
    })

    it('窗口只是默认猜测：输出上限不收紧，窗口记为未知', () => {
      expect(resolveModelExecutionCapabilityEvidence(custom({}))).toMatchObject({ contextWindowTokens: null, maxOutputTokens: 65_536, source: { contextWindowTokens: 'unknown' } })
    })
  })

  it('irreversibly closes an active lease without affecting other leases', () => {
    const registry = new ModelExecutionLeaseRegistry({
      loadModel: () => modelProfile(),
      createLeaseId: (() => {
        const ids = ['lease-a', 'lease-b']
        return () => ids.shift() ?? 'unexpected-lease'
      })(),
    })
    registry.begin('generation-model')
    registry.begin('generation-model')

    expect(registry.close('lease-a')).toBe(true)
    expect(() => registry.resolve('lease-a')).toThrow('MODEL_EXECUTION_LEASE_INVALID')
    expect(registry.resolve('lease-b').id).toBe('generation-model')
    expect(registry.close('lease-a')).toBe(false)
  })

  it('rejects and removes a lease at its expiry boundary', () => {
    let now = 10_000
    const registry = new ModelExecutionLeaseRegistry({
      loadModel: () => modelProfile(),
      createLeaseId: () => 'expiring-lease',
      now: () => now,
      ttlMs: 500,
    })
    registry.begin('generation-model')

    now = 10_499
    expect(registry.resolve('expiring-lease').id).toBe('generation-model')
    now = 10_500
    expect(() => registry.resolve('expiring-lease')).toThrow('MODEL_EXECUTION_LEASE_EXPIRED')
    expect(registry.close('expiring-lease')).toBe(false)
  })
})
