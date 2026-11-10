import { describe, expect, it } from 'vitest'

import type { ModelProfile } from '../ipc-channels'
import { applyModelProfileSelection, clearContextWindowOverride, createModelProfileDraft, DEFAULT_GENERATION_OUTPUT_TOKENS, resolveContextWindow, withLearnedContextWindow } from '../model-profile-draft'

describe('model profile drafts', () => {
  it('starts a generation draft on the OpenAI endpoint with no model name and the default output limit', () => {
    expect(DEFAULT_GENERATION_OUTPUT_TOKENS).toBe(65536)
    const draft = createModelProfileDraft({id:'new-generation',purposes:['generation']})
    expect(draft).toMatchObject({ provider:'openai', baseUrl:'https://api.openai.com', modelName:'', maxTokens:65536 })
    expect(draft.capabilities).toBeUndefined()
  })
  it.each([16384,32768,65536])('leaves an existing explicit %i output limit unchanged', maxTokens => {
    const profile={...createModelProfileDraft({id:'old-generation',purposes:['generation']}),maxTokens,
      capabilities:{contextWindowTokens:262144,maxOutputTokens:maxTokens,reasoning:false,structuredOutput:true,usage:true}}
    expect(applyModelProfileSelection(profile,{modelName:profile.modelName})).toEqual(profile)
  })
  it('preserves manual fields for the same identity and clears automatic fields on endpoint or protocol changes', () => {
    const initial = createModelProfileDraft({ id: 'sources', purposes: ['generation'] })
    const endpoint = applyModelProfileSelection(initial, { modelName: 'new', baseUrl: 'https://new.test/v1' },
      { contextWindowTokens: 64000, maxOutputTokens: 12000 })
    expect(endpoint.capabilitySources).toMatchObject({ contextWindowTokens: 'endpoint', maxOutputTokens: 'endpoint', reasoning: 'unknown' })
    const manual = { ...endpoint, capabilities: { ...endpoint.capabilities!, contextWindowTokens: 32000 },
      capabilitySources: { ...endpoint.capabilitySources, contextWindowTokens: 'manual' as const } }
    const refreshed = applyModelProfileSelection(manual, { modelName: 'new' }, { contextWindowTokens: 128000 })
    expect(refreshed.capabilities?.contextWindowTokens).toBe(32000)
    expect(refreshed.capabilitySources?.contextWindowTokens).toBe('manual')
    for (const selection of [{ baseUrl: 'https://other.test/v1' }, { protocol: 'gemini' as const }]) {
      const changed = applyModelProfileSelection({ ...refreshed, reasoningMapping: {
        adapter: 'openai-reasoning-effort', supportedEfforts: ['high'], providerValues: { high: 'high' },
      } }, selection)
      expect(changed.capabilities).toBeUndefined()
      expect(changed.reasoningMapping).toBeUndefined()
      expect(changed.capabilitySources?.contextWindowTokens).toBe('unknown')
    }
  })
  it('matches selected models by endpoint while preserving the author output limit', () => {
    const draft = { ...createModelProfileDraft({ id: 'choice', purposes: ['generation'] }),
      provider: 'custom' as const, maxTokens: 2048, reasoningOverride: 'high' as const }
    const selected = applyModelProfileSelection(draft, { baseUrl: 'https://api.x.ai/v1', modelName: 'grok-4.5' })
    expect(selected).toMatchObject({ maxTokens: 2048, capabilities: { contextWindowTokens: 500000, maxOutputTokens: 8192 }, reasoningOverride: 'auto' })
    const edited = { ...selected, maxTokens: 8192, capabilities: { ...selected.capabilities!, maxOutputTokens: 1024 } }
    expect(applyModelProfileSelection(edited, { modelName: 'grok-4.5' })).toEqual(edited)
    expect(applyModelProfileSelection(edited, { modelName: 'unlisted' }))
      .toMatchObject({ modelName: 'unlisted', maxTokens: 1024, capabilities: undefined, reasoningOverride: 'auto' })
  })
  it('creates a complete SiliconFlow bge-m3 embedding profile without an API key', () => {
    const draft = createModelProfileDraft({
      id: 'new-embedding-profile',
      purposes: ['embedding'],
    })

    expect(draft).toMatchObject({
      id: 'new-embedding-profile',
      name: 'SiliconFlow BAAI/bge-m3',
      provider: 'siliconflow',
      protocol: 'openai',
      baseUrl: 'https://api.siliconflow.cn/v1',
      modelName: 'BAAI/bge-m3',
      apiKey: '',
      purposes: ['embedding'],
      capabilities: {
        contextWindowTokens: 8192,
        maxOutputTokens: 0,
        reasoning: false,
        structuredOutput: false,
        usage: true,
      },
    })
  })

  describe('上下文窗口取值：手填 > 拉取 > 预设 > 默认', () => {
    const draft = () => createModelProfileDraft({ id: 'window', purposes: ['generation'] })
    const custom = (overrides: Partial<ModelProfile> = {}): ModelProfile => ({ ...draft(), provider: 'custom', baseUrl: 'https://future.example.com/v1', modelName: 'future', ...overrides })
    const official = (overrides: Partial<ModelProfile> = {}): ModelProfile => ({ ...draft(), provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash', ...overrides })
    const catalogued = () => resolveContextWindow(applyModelProfileSelection(official({ modelName: '' }), { modelName: 'deepseek-v4-flash' }))
    const stored = (tokens: number | null, source?: 'manual' | 'endpoint' | 'preset' | 'unknown'): Partial<ModelProfile> => ({
      capabilities: { contextWindowTokens: tokens, maxOutputTokens: 4096, reasoning: false, structuredOutput: false, usage: false },
      capabilitySources: source ? { contextWindowTokens: source } : undefined,
    })

    it('预设模型选中后来源是内置资料', () => expect(catalogued().source).toBe('preset'))

    it.each([1_000, 9_000_000])('手填 %i 压过预设', tokens => {
      expect(resolveContextWindow(official(stored(tokens, 'manual')))).toEqual({ tokens, source: 'manual' })
    })

    it('拉取的值压过预设', () => {
      expect(resolveContextWindow(official(stored(64_000, 'endpoint')))).toEqual({ tokens: 64_000, source: 'endpoint' })
    })

    it('手填清空后不算手填，退回预设', () => {
      expect(resolveContextWindow(official(stored(null, 'manual')))).toEqual(catalogued())
    })

    it('不明模型默认 32,768，Ollama 默认 4,096', () => {
      expect(resolveContextWindow(custom())).toEqual({ tokens: 32_768, source: 'default' })
      expect(resolveContextWindow(custom({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1' }))).toEqual({ tokens: 4_096, source: 'default' })
    })

    it('LM Studio 这类本机服务读不到窗口时也按 4,096，读到时用实际值', () => {
      const lmStudio = { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', modelName: 'gemma-3' }
      expect(resolveContextWindow(custom(lmStudio))).toEqual({ tokens: 4_096, source: 'default' })
      expect(resolveContextWindow(custom({ ...lmStudio, ...stored(8_192, 'endpoint') }))).toEqual({ tokens: 8_192, source: 'endpoint' })
    })

    it('旧档案没有来源记录：等于预设的算内置资料，不同的算手填，没有数的看预设或默认', () => {
      const preset = catalogued().tokens
      expect(resolveContextWindow(official(stored(preset)))).toEqual({ tokens: preset, source: 'preset' })
      expect(resolveContextWindow(official(stored(preset + 1)))).toEqual({ tokens: preset + 1, source: 'manual' })
      expect(resolveContextWindow(official({ capabilities: undefined, capabilitySources: undefined }))).toEqual(catalogued())
      expect(resolveContextWindow(custom({ capabilities: undefined, capabilitySources: undefined }))).toEqual({ tokens: 32_768, source: 'default' })
    })

    describe('学到的窗口：手填 > 学到 > 拉取 > 预设 > 默认', () => {
      it('学到的值压过拉取、预设和默认', () => {
        expect(resolveContextWindow(withLearnedContextWindow(official(stored(128_000, 'endpoint')), 32_768))).toEqual({ tokens: 32_768, source: 'learned' })
        expect(resolveContextWindow(withLearnedContextWindow(official(), 32_768))).toEqual({ tokens: 32_768, source: 'learned' })
        expect(resolveContextWindow(withLearnedContextWindow(custom(), 16_000))).toEqual({ tokens: 16_000, source: 'learned' })
      })

      it('作者手填过就不用学到的值', () => {
        const manual = official(stored(64_000, 'manual'))
        expect(withLearnedContextWindow(manual, 32_768)).toBe(manual)
        const learnedFirst = withLearnedContextWindow(official(stored(128_000, 'endpoint')), 32_768)
        const filledLater = { ...learnedFirst, ...stored(64_000, 'manual') }
        expect(resolveContextWindow(filledLater)).toEqual({ tokens: 64_000, source: 'manual' })
      })

      it('已有可信的窗口时只收紧，不放大', () => {
        const endpoint = official(stored(64_000, 'endpoint'))
        expect(withLearnedContextWindow(endpoint, 64_000)).toBe(endpoint)
        expect(withLearnedContextWindow(endpoint, 128_000)).toBe(endpoint)
        const learned = withLearnedContextWindow(endpoint, 32_768)
        expect(resolveContextWindow(withLearnedContextWindow(learned, 16_000)).tokens).toBe(16_000)
        expect(resolveContextWindow(withLearnedContextWindow(learned, 48_000)).tokens).toBe(32_768)
      })

      it('默认值只是猜测：服务商报的数和它相同也算学到', () => {
        expect(resolveContextWindow(withLearnedContextWindow(custom(), 32_768))).toEqual({ tokens: 32_768, source: 'learned' })
      })

      it.each([
        ['服务商', { provider: 'siliconflow' as const }],
        ['协议', { protocol: 'anthropic' as const }],
        ['地址', { baseUrl: 'https://other.example.com/v1' }],
        ['模型名', { modelName: 'other-model' }],
      ])('改了%s，学到的窗口作废', (_name, change) => {
        const learned = withLearnedContextWindow(custom(stored(128_000, 'endpoint')), 32_768)
        expect(resolveContextWindow({ ...learned, ...change })).toEqual({ tokens: 128_000, source: 'endpoint' })
      })
    })

    it('清空手填：有列表声明用声明，没有回预设或默认，其他手填项不动', () => {
      const manual = official({ ...stored(1_000), maxTokens: 8_192, capabilitySources: { contextWindowTokens: 'manual', maxOutputTokens: 'manual' } })
      const declared = clearContextWindowOverride(manual, 64_000)
      expect(resolveContextWindow(declared)).toEqual({ tokens: 64_000, source: 'endpoint' })
      expect(declared.capabilitySources?.maxOutputTokens).toBe('manual')
      expect(declared.capabilities?.maxOutputTokens).toBe(4096)
      expect(declared.maxTokens).toBe(8_192)
      expect(resolveContextWindow(clearContextWindowOverride(manual))).toEqual(catalogued())
      expect(resolveContextWindow(clearContextWindowOverride(custom(stored(1_000, 'manual'))))).toEqual({ tokens: 32_768, source: 'default' })
    })

    it('手填后再拉取或重选同一模型不覆盖，换模型后失效', () => {
      const manual = custom(stored(1_000, 'manual'))
      expect(resolveContextWindow(applyModelProfileSelection(manual, { modelName: 'future' }, { contextWindowTokens: 64_000 }))).toEqual({ tokens: 1_000, source: 'manual' })
      expect(resolveContextWindow(applyModelProfileSelection(manual, { modelName: 'other' }, { contextWindowTokens: 64_000 }))).toEqual({ tokens: 64_000, source: 'endpoint' })
      expect(resolveContextWindow(applyModelProfileSelection(manual, { modelName: 'other' }))).toEqual({ tokens: 32_768, source: 'default' })
    })
  })
})
