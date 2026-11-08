import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'

import type { ModelDiscoveryRequest, ModelDiscoveryResult, ModelProfile } from '../../../shared/ipc-channels'
import type { Locale } from '../../../i18n/types'
import { BUILTIN_PRESETS } from '../../../shared/provider-presets'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import StageSettings from '../../stage/settings/StageSettings'
import { ModelForm } from '../ModelForm'

const originalLayoutState = useLayoutStore.getState()
const originalLLMState = useLLMStore.getState()
const originalLocaleState = useLocaleStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface TestVelaApi {
  invoke: ReturnType<typeof vi.fn>
  on: () => () => void
  once: () => void
  send: () => void
  setZoomLevel: () => void
  setZoomFactor: () => void
  getZoomLevel: () => number
}

function savedProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'saved-discovery-profile',
    name: 'Discovery profile',
    provider: 'custom',
    protocol: 'openai',
    modelName: 'manual-model',
    apiKey: `credential-${crypto.randomUUID()}`,
    baseUrl: 'https://provider.invalid/v1',
    temperature: 0.7,
    maxTokens: 4096,
    purposes: ['generation'],
    ...overrides,
  }
}

function discoveryRequest(model: ModelProfile) {
  return {
    provider: model.provider,
    protocol: model.protocol,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
    purposes: model.purposes,
  }
}

const suggestionOptions = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
const suggestionValues = () => suggestionOptions().map(option => option.querySelector('span')?.textContent ?? '')
const modelNameInput = () => {
  const input = document.querySelector('input[role="combobox"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('Missing model name combobox')
  return input
}
const apiKeyInput = () => {
  const input = modelNameInput().closest('.rounded-xl')?.querySelector('input[type="password"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('Missing API key input')
  return input
}
const baseUrlInput = (value: string) => {
  const input = Array.from(document.querySelectorAll('input')).find(candidate => candidate.value === value)
  if (!input) throw new Error(`Missing base URL input with ${value}`)
  return input
}
const statusText = () => document.getElementById(modelNameInput().getAttribute('aria-describedby') ?? '')?.textContent ?? undefined
const endpointModels = (...values: string[]) => values.map(value => ({ id: value, name: value, value }))
const listed = (...values: string[]) => vi.fn<(request: ModelDiscoveryRequest) => Promise<ModelDiscoveryResult>>(async () => ({ success: true, models: endpointModels(...values) }))
/** 比自动获取的防抖多等一点，确认这段时间里确实没有发请求。 */
const AUTO_DISCOVERY_WAIT_MS = 800
const DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro']
const OLLAMA_MODELS = ['qwen2.5', 'llama3.3', 'llama3.2']

async function openSuggestions(locale: Locale = 'zh-CN') {
  if (modelNameInput().getAttribute('aria-expanded') === 'true') {
    await act(async () => {
      await page.getByRole('button', { name: locale === 'zh-CN' ? '收起候选模型' : 'Hide model suggestions', exact: true }).click()
    })
  }
  await act(async () => {
    await page.getByRole('button', { name: locale === 'zh-CN' ? '展开候选模型' : 'Show model suggestions', exact: true }).click()
  })
}

async function chooseSuggestion(value: string) {
  const option = suggestionOptions().find(candidate => candidate.querySelector('span')?.textContent === value)
  if (!option) throw new Error(`Missing suggestion ${value}`)
  await act(async () => option.click())
}

async function typeInto(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

let root: Root | undefined
let container: HTMLDivElement | undefined

async function renderSettings(
  model: ModelProfile,
  discoverModels: ReturnType<typeof useLLMStore.getState>['discoverModels'],
  locale: Locale = 'zh-CN',
  additionalModels: ModelProfile[] = [],
  persisted = true,
) {
  const saveModel = vi.fn<(model: ModelProfile) => Promise<boolean>>(async () => true)
  const setDefaultModel = vi.fn(async () => true)
  useLayoutStore.setState({ settingsSection: 'llm' })
  useLocaleStore.setState({ locale })
  useLLMStore.setState({
    models: persisted ? [model, ...additionalModels] : additionalModels,
    loaded: true,
    defaultModelId: model.id,
    saveModel,
    setDefaultModel,
    discoverModels,
  })
  ;(window as unknown as { aiNovelAPI: TestVelaApi }).aiNovelAPI = {
    invoke: vi.fn(),
    on: () => () => {},
    once: () => {},
    send: () => {},
    setZoomLevel: () => {},
    setZoomFactor: () => {},
    getZoomLevel: () => 0,
  }

  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<StageSettings library={false} />)
  })
  return { saveModel, setDefaultModel }
}

/** 打开一份已保存、条件齐全的配置，展开列表，等端点模型列出来。 */
async function renderFetched(values: readonly string[], overrides: Partial<ModelProfile> = {}) {
  const discoverModels = vi.fn<(request: ModelDiscoveryRequest) => Promise<ModelDiscoveryResult>>(async () => ({ success: true, models: endpointModels(...values) }))
  const rendered = await renderSettings(savedProfile({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash', ...overrides }), discoverModels)
  await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
  await openSuggestions()
  await vi.waitFor(() => expect(suggestionValues()).toEqual([...values]))
  return { ...rendered, discoverModels }
}

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useLayoutStore.setState(originalLayoutState)
  useLLMStore.setState(originalLLMState)
  useLocaleStore.setState(originalLocaleState)
  delete (window as unknown as { aiNovelAPI?: TestVelaApi }).aiNovelAPI
  vi.restoreAllMocks()
})

describe('model discovery settings flow', () => {
  it('previews and preserves separate Qwen thinking budgets after saving and reopening', async () => {
    const model = savedProfile({ baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'Qwen/Qwen3.8-27B',
      maxTokens: 16384, reasoningOverride: 'medium' })
    const { saveModel } = await renderSettings(model, vi.fn())
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
    })
    expect(container?.textContent).toContain('数字预算是应用映射')
    expect(container?.querySelector('[data-reasoning-wire]')?.textContent).toBe('enable_thinking=true; thinking_budget=16384')
    const mapping = { adapter: 'openai-thinking-budget', supportedEfforts: ['off', 'medium'], providerValues: { off: 0, medium: 4096 } }
    await act(async () => {
      await page.getByText('高级参数映射', { exact: true }).click()
      await page.getByLabelText('推理参数映射 JSON').fill(JSON.stringify(mapping))
      await page.getByRole('button', { name: '应用映射', exact: true }).click()
      await page.getByRole('button', { name: '保存配置', exact: true }).click()
    })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ reasoningMapping: mapping, reasoningOverride: 'medium', maxTokens: 16384 }))
    const saved = saveModel.mock.calls[0][0]
    await act(async () => { useLLMStore.setState({ models: [JSON.parse(JSON.stringify(saved))] }) })
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
    })
    expect(container?.querySelector('[data-reasoning-wire]')?.textContent).toBe('enable_thinking=true; thinking_budget=4096')
    await act(async () => { await page.getByLabelText('模型推理覆盖').selectOptions('off') })
    expect(container?.querySelector('[data-reasoning-wire]')?.textContent).toBe('enable_thinking=false')
  })

  it.each([
    { baseUrl: 'https://api.x.ai/v1', value: 'grok-4.5', declared: undefined, context: 500000, output: 8192 },
    { baseUrl: 'https://new.test/v1', value: 'unlisted', declared: { contextWindowTokens: 64000, maxOutputTokens: 12000, reasoning: true }, context: 64000, output: 12000 },
  ])('applies endpoint selection metadata and preserves the author limit: $value', async ({ baseUrl, value, declared, context, output }) => {
    const model = savedProfile({ baseUrl, maxTokens: 2048 })
    const discoverModels = vi.fn(async () => ({ success: true as const,
      models: [{ id: value, name: value, value, capabilities: declared }] }))
    const { saveModel } = await renderSettings(model, discoverModels)
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })
    await vi.waitFor(() => expect(suggestionValues()).toContain(value))
    await chooseSuggestion(value)
    await act(async () => {
      await expect.element(page.getByLabelText('上下文窗口', { exact: true })).toHaveValue(context)
      await page.getByLabelText('上下文窗口', { exact: true }).fill('32000')
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
      await page.getByLabelText('最大输出 Tokens', { exact: true }).fill('1024')
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })
    expect(saveModel).not.toHaveBeenCalled()
    await expect.element(page.getByLabelText('最大输出 Tokens', { exact: true })).toHaveValue(1024)
    await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ modelName: value, maxTokens: 1024,
      capabilities: expect.objectContaining({ contextWindowTokens: 32000, maxOutputTokens: output, reasoning: true }),
      capabilitySources: expect.objectContaining({ contextWindowTokens: 'manual', maxOutputTokens: declared ? 'endpoint' : 'preset' }) }))
    const saved = saveModel.mock.calls[0][0] as unknown as ModelProfile
    await act(async () => { useLLMStore.setState({ models: [JSON.parse(JSON.stringify(saved))] }) })
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    expect(container?.querySelector('[data-context-window-source]')?.textContent).toBe('你填的')
    expect(container?.querySelector('[data-capability-sources]')?.textContent).toContain(declared ? '模型输出容量：来自服务商' : '模型输出容量：内置资料')
  })

  describe('上下文窗口来源标签', () => {
    const windowInput = (locale: Locale = 'zh-CN') => page.getByLabelText(locale === 'zh-CN' ? '上下文窗口' : 'Context Window', { exact: true })
    const sourceTag = () => container?.querySelector('[data-context-window-source]')?.textContent
    const windowElement = () => windowInput().element() as HTMLInputElement
    const openEditor = (locale: Locale = 'zh-CN') => act(async () => { await page.getByRole('button', { name: locale === 'zh-CN' ? /^编辑「/ : /^Edit “/ }).click() })
    const stored = (tokens: number, source: 'manual' | 'endpoint' | 'preset'): Partial<ModelProfile> => ({
      capabilities: { contextWindowTokens: tokens, maxOutputTokens: 4096, reasoning: false, structuredOutput: false, usage: false },
      capabilitySources: { contextWindowTokens: source },
    })

    it.each<[Locale, Partial<ModelProfile>, string]>([
      ['zh-CN', stored(1_000, 'manual'), '你填的'],
      ['zh-CN', stored(64_000, 'endpoint'), '来自服务商'],
      ['zh-CN', stored(64_000, 'preset'), '内置资料'],
      ['zh-CN', {}, '默认值'],
      ['en-US', stored(1_000, 'manual'), 'Set by you'],
      ['en-US', stored(64_000, 'endpoint'), 'From provider'],
      ['en-US', stored(64_000, 'preset'), 'Built-in data'],
      ['en-US', {}, 'Default'],
    ])('%s 下档案 %j 显示 %s', async (locale, overrides, label) => {
      await renderSettings(savedProfile(overrides), listed('manual-model'), locale)
      await openEditor(locale)
      expect(sourceTag()).toBe(label)
    })

    it.each<[Locale, 'manual' | 'endpoint' | 'preset' | 'unknown', string, string]>([
      ['zh-CN', 'manual', '你填的', '模型输出容量：你填的'],
      ['zh-CN', 'endpoint', '来自服务商', '模型输出容量：来自服务商'],
      ['zh-CN', 'preset', '内置资料', '模型输出容量：内置资料'],
      ['zh-CN', 'unknown', '默认值', '模型输出容量：默认值'],
      ['en-US', 'manual', 'Set by you', 'Model output capacity: Set by you'],
      ['en-US', 'endpoint', 'From provider', 'Model output capacity: From provider'],
      ['en-US', 'preset', 'Built-in data', 'Model output capacity: Built-in data'],
      ['en-US', 'unknown', 'Default', 'Model output capacity: Default'],
    ])('%s 下来源 %s 在窗口标签和下面一行是同一个词', async (locale, source, word, line) => {
      const capabilities = source === 'unknown' ? undefined : { contextWindowTokens: 64_000, maxOutputTokens: 4096, reasoning: false, structuredOutput: false, usage: false }
      await renderSettings(savedProfile({ capabilities, capabilitySources: { contextWindowTokens: source, maxOutputTokens: source } }), listed('manual-model'), locale)
      await openEditor(locale)
      expect(sourceTag()).toBe(word)
      expect(container?.querySelector('[data-capability-sources]')?.textContent).toContain(line)
    })

    it('LM Studio 未加载模型、读不到窗口时按 4096，没有提示，配置能保存', async () => {
      const { saveModel } = await renderSettings(savedProfile({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', modelName: '' }), listed('gemma-3'))
      useLLMStore.setState({ discoverLocalContextWindow: vi.fn(async () => null) })
      await openEditor()
      await openSuggestions()
      await vi.waitFor(() => expect(suggestionValues()).toContain('gemma-3'))
      await chooseSuggestion('gemma-3')
      expect(windowElement().value).toBe('')
      expect(windowElement().placeholder).toBe('4096')
      expect(sourceTag()).toBe('默认值')
      expect(container?.querySelector('[role="alert"]')).toBeNull()
      await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
      expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'gemma-3' }))
    })

    it('LM Studio 已加载模型时取实例的窗口', async () => {
      await renderSettings(savedProfile({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', modelName: '' }), listed('gemma-3'))
      useLLMStore.setState({ discoverLocalContextWindow: vi.fn(async () => 8_192) })
      await openEditor()
      await openSuggestions()
      await vi.waitFor(() => expect(suggestionValues()).toContain('gemma-3'))
      await chooseSuggestion('gemma-3')
      await vi.waitFor(() => expect(windowElement().value).toBe('8192'))
      expect(sourceTag()).toBe('来自服务商')
    })

    it('没有窗口的模型留空，占位显示生效的默认数；Ollama 显示 4096', async () => {
      await renderSettings(savedProfile(), listed('manual-model'))
      await openEditor()
      expect(windowElement().value).toBe('')
      expect(windowElement().placeholder).toBe('32768')
    })

    it('Ollama 默认 4096，选中后读到运行值写入并标来自服务商', async () => {
      const discoverLocalContextWindow = vi.fn(async () => 8_192)
      const model = savedProfile({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', modelName: '' })
      await renderSettings(model, listed('qwen2.5'))
      useLLMStore.setState({ discoverLocalContextWindow })
      await openEditor()
      expect(windowElement().placeholder).toBe('4096')
      await openSuggestions()
      await vi.waitFor(() => expect(suggestionValues()).toContain('qwen2.5'))
      await chooseSuggestion('qwen2.5')
      await vi.waitFor(() => expect(windowElement().value).toBe('8192'))
      expect(sourceTag()).toBe('来自服务商')
      expect(discoverLocalContextWindow).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'http://localhost:11434/v1', modelName: 'qwen2.5' }))
    })

    it('读不到本机窗口时没有提示，配置照常能保存', async () => {
      const model = savedProfile({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', modelName: '' })
      const { saveModel } = await renderSettings(model, listed('qwen2.5'))
      useLLMStore.setState({ discoverLocalContextWindow: vi.fn(async () => { throw new Error('down') }) })
      await openEditor()
      await openSuggestions()
      await vi.waitFor(() => expect(suggestionValues()).toContain('qwen2.5'))
      await chooseSuggestion('qwen2.5')
      expect(sourceTag()).toBe('默认值')
      expect(statusText()).toContain('已从端点获取')
      expect(container?.querySelector('[role="alert"]')).toBeNull()
      await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
      expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'qwen2.5' }))
    })

    it('清空窗口后读到本机运行值，不改作者的最大输出', async () => {
      const { saveModel } = await renderSettings(savedProfile({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', modelName: 'gemma-3', maxTokens: 8192,
        capabilities: { contextWindowTokens: 1_000, maxOutputTokens: 4096, reasoning: false, structuredOutput: false, usage: false },
        capabilitySources: { contextWindowTokens: 'manual' } }), listed('gemma-3'))
      useLLMStore.setState({ discoverLocalContextWindow: vi.fn(async () => 16_384) })
      await openEditor()
      await act(async () => { await windowInput().fill('') })
      await vi.waitFor(() => expect(windowElement().value).toBe('16384'))
      await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
      expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 8192 }))
    })

    it('手打本机模型名，停止输入后读一次窗口；打开表单不读', async () => {
      const discoverLocalContextWindow = vi.fn(async () => 8_192)
      await renderSettings(savedProfile({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', modelName: 'old-name' }), listed())
      useLLMStore.setState({ discoverLocalContextWindow })
      await openEditor()
      await new Promise(resolve => setTimeout(resolve, AUTO_DISCOVERY_WAIT_MS))
      expect(discoverLocalContextWindow).not.toHaveBeenCalled()
      await typeInto(modelNameInput(), 'typed')
      await typeInto(modelNameInput(), 'typed-model')
      await vi.waitFor(() => expect(windowElement().value).toBe('8192'))
      expect(sourceTag()).toBe('来自服务商')
      expect(discoverLocalContextWindow).toHaveBeenCalledTimes(1)
      expect(discoverLocalContextWindow).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'http://127.0.0.1:1234/v1', modelName: 'typed-model' }))
    })

    it('换了端点不用碰模型名，同名模型向新端点读窗口', async () => {
      const discoverLocalContextWindow = vi.fn(async () => 8_192)
      await renderSettings(savedProfile({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', modelName: 'same-name' }), listed())
      useLLMStore.setState({ discoverLocalContextWindow })
      await openEditor()
      await typeInto(baseUrlInput('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:5678/v1')
      await vi.waitFor(() => expect(windowElement().value).toBe('8192'))
      expect(discoverLocalContextWindow).toHaveBeenCalledTimes(1)
      expect(discoverLocalContextWindow).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'http://127.0.0.1:5678/v1', modelName: 'same-name' }))
    })

    it('先发的读取后返回，不盖掉后发的结果', async () => {
      const responses: Array<(tokens: number | null) => void> = []
      const discoverLocalContextWindow = vi.fn(() => new Promise<number | null>(resolve => { responses.push(resolve) }))
      await renderSettings(savedProfile({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', modelName: 'gemma-3', ...stored(1_000, 'manual') }), listed())
      useLLMStore.setState({ discoverLocalContextWindow })
      await openEditor()
      await act(async () => { await windowInput().fill('') })
      await vi.waitFor(() => expect(responses).toHaveLength(1))
      await act(async () => { await windowInput().fill('2000') })
      await act(async () => { await windowInput().fill('') })
      await vi.waitFor(() => expect(responses).toHaveLength(2))
      await act(async () => { responses[1](16_384) })
      await act(async () => { responses[0](9_999) })
      expect(windowElement().value).toBe('16384')
    })

    describe('窗口取值矩阵', () => {
      type How = 'select' | 'type' | 'type-list-open' | 'reopen'
      type Prior = 'none' | 'manual' | 'manual-other-model' | 'empty-manual' | 'endpoint'
      const ENDPOINTS = { local: { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '' }, cloud: { baseUrl: 'https://provider.invalid/v1' } }
      const priorProfile = (prior: Prior, how: How): Partial<ModelProfile> => {
        const onTarget = prior === 'manual' || prior === 'empty-manual' || prior === 'endpoint' || how === 'reopen'
        const modelName = onTarget ? 'target' : 'old'
        if (prior === 'none') return { modelName: how === 'select' ? '' : modelName }
        if (prior === 'endpoint') return { modelName, ...stored(32_768, 'endpoint') }
        if (prior === 'empty-manual') return { modelName, capabilities: { contextWindowTokens: null, maxOutputTokens: 4096, reasoning: false, structuredOutput: false, usage: false }, capabilitySources: { contextWindowTokens: 'manual' } }
        return { modelName, ...stored(1_000, 'manual') }
      }

      it.each<[keyof typeof ENDPOINTS, How, Prior, number | undefined, number | null, string, string]>([
        ['local', 'select', 'none', undefined, 8_192, '8192', '来自服务商'],
        ['local', 'select', 'none', 64_000, 8_192, '8192', '来自服务商'],
        ['local', 'select', 'none', 64_000, null, '64000', '来自服务商'],
        ['local', 'select', 'none', undefined, null, '', '默认值'],
        ['local', 'select', 'manual', undefined, 8_192, '1000', '你填的'],
        ['local', 'select', 'empty-manual', undefined, 8_192, '8192', '来自服务商'],
        ['local', 'select', 'endpoint', undefined, null, '', '默认值'],
        ['local', 'type', 'none', undefined, 8_192, '8192', '来自服务商'],
        ['local', 'type', 'manual-other-model', undefined, 8_192, '8192', '来自服务商'],
        ['local', 'reopen', 'endpoint', undefined, 8_192, '32768', '来自服务商'],
        ['local', 'reopen', 'manual', undefined, 8_192, '1000', '你填的'],
        ['cloud', 'select', 'none', 128_000, null, '128000', '来自服务商'],
        ['cloud', 'select', 'none', undefined, null, '', '默认值'],
        ['cloud', 'select', 'manual', 128_000, null, '1000', '你填的'],
        ['cloud', 'type', 'none', 128_000, null, '128000', '来自服务商'],
        ['cloud', 'type-list-open', 'none', 128_000, null, '128000', '来自服务商'],
        ['cloud', 'type', 'manual-other-model', 128_000, null, '128000', '来自服务商'],
        ['cloud', 'reopen', 'endpoint', 128_000, null, '32768', '来自服务商'],
        ['cloud', 'reopen', 'manual', 128_000, null, '1000', '你填的'],
      ])('%s × %s × 先前 %s × 列表 %s × 运行值 %s：窗口 %j，来源 %s', async (endpoint, how, prior, listWindow, runtime, value, tag) => {
        const discoverLocalContextWindow = vi.fn(async () => runtime)
        const discoverModels = vi.fn(async () => ({ success: true as const, models: [{ id: 'target', name: 'target', value: 'target', ...(listWindow === undefined ? {} : { capabilities: { contextWindowTokens: listWindow } }) }] }))
        await renderSettings(savedProfile({ ...ENDPOINTS[endpoint], ...priorProfile(prior, how) }), discoverModels)
        useLLMStore.setState({ discoverLocalContextWindow })
        await openEditor()
        if (how === 'select' || how === 'type-list-open') {
          await openSuggestions()
          await vi.waitFor(() => expect(suggestionValues()).toContain('target'))
        }
        if (how === 'select') await chooseSuggestion('target')
        if (how === 'type' || how === 'type-list-open') await typeInto(modelNameInput(), 'target')
        await act(async () => { await new Promise(resolve => setTimeout(resolve, AUTO_DISCOVERY_WAIT_MS)) })
        expect(windowElement().value).toBe(value)
        expect(sourceTag()).toBe(tag)
        if (how === 'reopen') {
          expect(discoverLocalContextWindow).not.toHaveBeenCalled()
          expect(discoverModels).not.toHaveBeenCalled()
        }
      })
    })

    it('窗口填负数按清空处理，不存成手填', async () => {
      const { saveModel } = await renderSettings(savedProfile({ ...stored(1_000, 'manual') }), listed('manual-model'))
      await openEditor()
      await act(async () => { await windowInput().fill('-5') })
      expect(sourceTag()).toBe('默认值')
      await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
      expect(saveModel.mock.calls[0][0].capabilities?.contextWindowTokens ?? null).toBeNull()
    })

    describe('事件先后顺序矩阵', () => {
      const LOCAL_URL = 'http://127.0.0.1:1234/v1'
      const CLOUD_URL = 'https://provider.invalid/v1'
      const STALE_WINDOW = 999
      const START = {
        local: { baseUrl: LOCAL_URL, apiKey: '', modelName: 'target' },
        cloud: { baseUrl: CLOUD_URL, apiKey: 'key-0', modelName: 'target' },
        'cloud-unfilled': { baseUrl: CLOUD_URL, apiKey: '', modelName: '' },
        'cloud-manual': { baseUrl: CLOUD_URL, apiKey: 'key-0', modelName: 'target', ...stored(1_000, 'manual') },
      } satisfies Record<string, Partial<ModelProfile>>
      const listResponse = (tokens?: number): ModelDiscoveryResult => ({ success: true, models: [
        { id: 'target', name: 'target', value: 'target', ...(tokens === undefined ? {} : { capabilities: { contextWindowTokens: tokens } }) },
        { id: 'other', name: 'other', value: 'other' },
      ] })
      const settle = async <T,>(pending: Array<(value: T) => void>, end: 'newest' | 'oldest', value: T) => {
        await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0), { timeout: 3_000 })
        const resolve = end === 'newest' ? pending.pop() : pending.shift()
        await act(async () => { resolve?.(value) })
      }

      it.each<[keyof typeof START, string, number | undefined, number | null, string, string, number, number]>([
        ['local', 'url runtime list', 64_000, 8_192, '8192', '来自服务商', 1, 1],
        ['local', 'url list runtime', 64_000, 8_192, '8192', '来自服务商', 1, 1],
        ['local', 'url runtime list', 64_000, null, '64000', '来自服务商', 1, 1],
        ['local', 'url list runtime', 64_000, null, '64000', '来自服务商', 1, 1],
        ['local', 'url runtime list', undefined, null, '', '默认值', 1, 1],
        ['local', 'url list runtime', undefined, 8_192, '8192', '来自服务商', 1, 1],
        ['local', 'url manual runtime list', 64_000, 8_192, '20000', '你填的', 1, 1],
        ['local', 'url runtime manual list', 64_000, null, '20000', '你填的', 1, 1],
        ['local', 'url list manual runtime', 64_000, 8_192, '20000', '你填的', 1, 1],
        ['local', 'url runtime list manual clear runtime', 64_000, 8_192, '8192', '来自服务商', 2, 1],
        ['local', 'url runtime list manual clear runtime', 64_000, null, '64000', '来自服务商', 2, 1],
        ['local', 'open list manual clear runtime', 64_000, 8_192, '8192', '来自服务商', 1, 1],
        ['local', 'open list manual clear runtime', 64_000, null, '64000', '来自服务商', 1, 1],
        ['local', 'open list select runtime', 64_000, 8_192, '8192', '来自服务商', 1, 1],
        ['local', 'open list select runtime', 64_000, null, '64000', '来自服务商', 1, 1],
        ['local', 'open list select runtime manual clear runtime', 64_000, 8_192, '8192', '来自服务商', 2, 1],
        ['local', 'open list manual clear manual runtime', 64_000, 8_192, '20000', '你填的', 1, 1],
        ['local', 'url await-runtime await-list url2 await-runtime-2 await-list-2 runtime runtime-stale list list-stale', 64_000, 8_192, '8192', '来自服务商', 2, 2],
        ['local', 'url await-runtime await-list url2 runtime-stale list-stale runtime list', 64_000, 8_192, '8192', '来自服务商', 2, 2],
        ['local', 'url await-runtime await-list url2 list-stale runtime-stale runtime list', 64_000, null, '64000', '来自服务商', 2, 2],
        ['local', 'open list', 64_000, 8_192, '', '默认值', 0, 1],
        ['local', 'url runtime list refresh list-failed', 64_000, null, '64000', '来自服务商', 1, 2],
        ['local', 'url runtime list refresh list-failed refresh idle list-failed', 64_000, null, '64000', '来自服务商', 1, 3],
        ['local', 'url runtime list refresh list-without-target', 64_000, null, '', '默认值', 1, 2],
        ['local', 'url list-failed runtime', 64_000, 8_192, '8192', '来自服务商', 1, 1],
        ['cloud-unfilled', 'name key list', 128_000, null, '128000', '来自服务商', 0, 1],
        ['cloud-unfilled', 'key name list', 128_000, null, '128000', '来自服务商', 0, 1],
        ['cloud-unfilled', 'key name await-list idle list', 128_000, null, '128000', '来自服务商', 0, 1],
        ['cloud-unfilled', 'key list name', 128_000, null, '128000', '来自服务商', 0, 1],
        ['cloud-unfilled', 'name key list', undefined, null, '', '默认值', 0, 1],
        ['cloud-unfilled', 'name manual key list', 128_000, null, '20000', '你填的', 0, 1],
        ['cloud-unfilled', 'name key manual list', 128_000, null, '20000', '你填的', 0, 1],
        ['cloud-unfilled', 'name key list manual clear', 128_000, null, '128000', '来自服务商', 0, 1],
        ['cloud-unfilled', 'name key list name2 name', 128_000, null, '128000', '来自服务商', 0, 1],
        ['cloud-unfilled', 'name key await-list key2 await-list-2 list list-stale', 128_000, null, '128000', '来自服务商', 0, 2],
        ['cloud-unfilled', 'name key await-list key2 list-stale list', 128_000, null, '128000', '来自服务商', 0, 2],
        ['cloud', 'url list', 128_000, null, '128000', '来自服务商', 0, 1],
        ['cloud', 'key2 list', 128_000, null, '128000', '来自服务商', 0, 1],
        ['cloud', 'open list', 128_000, null, '', '默认值', 0, 1],
        ['cloud', 'open list select', 128_000, null, '128000', '来自服务商', 0, 1],
        ['cloud', 'open list manual clear', 128_000, null, '128000', '来自服务商', 0, 1],
        ['cloud', 'url list refresh list-failed', 128_000, null, '128000', '来自服务商', 0, 2],
        ['cloud', 'url list refresh idle list-failed', 128_000, null, '128000', '来自服务商', 0, 2],
        ['cloud', 'url list refresh list-without-target', 128_000, null, '', '默认值', 0, 2],
        ['cloud-manual', 'key2 list', 128_000, null, '1000', '你填的', 0, 1],
        ['cloud-manual', 'clear list', 128_000, null, '128000', '来自服务商', 0, 1],
        ['cloud-manual', 'clear list open list-lower select refresh list-without-window', 128_000, null, '64000', '来自服务商', 0, 3],
        ['cloud-manual', 'clear await-list manual list', 128_000, null, '20000', '你填的', 0, 1],
        ['cloud-manual', 'clear await-list key2 await-list-2 list list-stale', 128_000, null, '128000', '来自服务商', 0, 2],
      ])('%s：%s（列表 %s，运行值 %s）→ 窗口 %j，来源 %s', { timeout: 15_000 }, async (start, steps, listWindow, runtime, value, tag, runtimeReads, listReads) => {
        const runtimeReplies: Array<(tokens: number | null) => void> = []
        const listReplies: Array<(result: ModelDiscoveryResult) => void> = []
        const discoverLocalContextWindow = vi.fn(() => new Promise<number | null>(resolve => { runtimeReplies.push(resolve) }))
        const discoverModels = vi.fn(() => new Promise<ModelDiscoveryResult>(resolve => { listReplies.push(resolve) }))
        await renderSettings(savedProfile(START[start]), discoverModels)
        useLLMStore.setState({ discoverLocalContextWindow })
        await openEditor()

        let url = START[start].baseUrl
        const moveTo = async (next: string) => {
          await typeInto(baseUrlInput(url), next)
          url = next
        }
        const actions: Record<string, () => Promise<unknown>> = {
          open: () => openSuggestions(),
          select: async () => {
            await vi.waitFor(() => expect(suggestionValues()).toContain('target'))
            await chooseSuggestion('target')
          },
          list: () => settle(listReplies, 'newest', listResponse(listWindow)),
          'list-stale': () => settle(listReplies, 'oldest', listResponse(STALE_WINDOW)),
          'list-lower': () => settle(listReplies, 'newest', listResponse(64_000)),
          'list-without-window': () => settle(listReplies, 'newest', listResponse()),
          'list-failed': () => settle(listReplies, 'newest', { success: false, errorCode: 'network' }),
          'list-without-target': () => settle(listReplies, 'newest', { success: true, models: endpointModels('other') }),
          refresh: () => act(async () => { await page.getByRole('button', { name: '获取模型列表', exact: true }).click() }),
          'await-list': () => vi.waitFor(() => expect(listReplies.length).toBeGreaterThan(0), { timeout: 3_000 }),
          'await-list-2': () => vi.waitFor(() => expect(listReplies.length).toBe(2), { timeout: 3_000 }),
          runtime: () => settle(runtimeReplies, 'newest', runtime),
          'runtime-stale': () => settle(runtimeReplies, 'oldest', STALE_WINDOW),
          'await-runtime': () => vi.waitFor(() => expect(runtimeReplies.length).toBeGreaterThan(0), { timeout: 3_000 }),
          'await-runtime-2': () => vi.waitFor(() => expect(runtimeReplies.length).toBe(2), { timeout: 3_000 }),
          url: () => moveTo(start === 'local' ? 'http://127.0.0.1:5678/v1' : 'https://other.invalid/v1'),
          url2: () => moveTo('http://127.0.0.1:9999/v1'),
          key: () => typeInto(apiKeyInput(), 'key-1'),
          key2: () => typeInto(apiKeyInput(), 'key-2'),
          name: () => typeInto(modelNameInput(), 'target'),
          name2: () => typeInto(modelNameInput(), 'unlisted'),
          manual: () => act(async () => { await windowInput().fill('20000') }),
          clear: () => act(async () => { await windowInput().fill('') }),
          idle: () => act(async () => { await new Promise(resolve => setTimeout(resolve, AUTO_DISCOVERY_WAIT_MS)) }),
        }
        for (const step of steps.split(' ')) await actions[step]()
        await act(async () => { await new Promise(resolve => setTimeout(resolve, AUTO_DISCOVERY_WAIT_MS)) })

        expect(windowElement().value).toBe(value)
        expect(sourceTag()).toBe(tag)
        expect(discoverLocalContextWindow).toHaveBeenCalledTimes(runtimeReads)
        expect(discoverModels).toHaveBeenCalledTimes(listReads)
      })

      it.each([
        ['云端先填模型名、后填 Key，列表到达', 'cloud-unfilled', 1],
        ['本机改地址，运行值读不到早于列表到达', 'local', 1],
      ] as const)('%s：窗口只写一次，不重复请求', async (_, start, windowWrites) => {
        const runtimeReplies: Array<(tokens: number | null) => void> = []
        const listReplies: Array<(result: ModelDiscoveryResult) => void> = []
        const discoverLocalContextWindow = vi.fn(() => new Promise<number | null>(resolve => { runtimeReplies.push(resolve) }))
        const discoverModels = vi.fn(() => new Promise<ModelDiscoveryResult>(resolve => { listReplies.push(resolve) }))
        useLLMStore.setState({ discoverLocalContextWindow, discoverModels })
        const onChange = vi.fn<(next: ModelProfile) => void>()
        function Form() {
          const [model, setModel] = useState(savedProfile(START[start]))
          return (
            <ModelForm model={model} onChange={next => { onChange(next); setModel(next) }} onSave={() => {}} onCancel={() => {}}
              saving={false} purposeOptions={['generation']} presets={BUILTIN_PRESETS} />
          )
        }
        container = document.createElement('div')
        document.body.append(container)
        root = createRoot(container)
        await act(async () => root?.render(<Form />))

        if (start === 'local') await typeInto(baseUrlInput(LOCAL_URL), 'http://127.0.0.1:5678/v1')
        else {
          await typeInto(modelNameInput(), 'target')
          await typeInto(apiKeyInput(), 'key-1')
        }
        if (start === 'local') await settle(runtimeReplies, 'newest', null)
        await vi.waitFor(() => expect(listReplies.length).toBeGreaterThan(0), { timeout: 3_000 })
        const before = onChange.mock.calls.length
        await settle(listReplies, 'newest', listResponse(64_000))
        await act(async () => { await new Promise(resolve => setTimeout(resolve, AUTO_DISCOVERY_WAIT_MS)) })

        expect(onChange.mock.calls.slice(before).map(([next]) => next.capabilities?.contextWindowTokens)).toEqual(Array(windowWrites).fill(64_000))
        expect(discoverModels).toHaveBeenCalledTimes(1)
        expect(discoverLocalContextWindow).toHaveBeenCalledTimes(start === 'local' ? 1 : 0)
      })
    })

    it('本机列表声明 64000、运行值 8192：手填后清空，取运行值', async () => {
      const discoverLocalContextWindow = vi.fn(async () => 8_192)
      const discoverModels = vi.fn(async () => ({ success: true as const, models: [{ id: 'gemma-3', name: 'gemma-3', value: 'gemma-3', capabilities: { contextWindowTokens: 64_000 } }] }))
      await renderSettings(savedProfile({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', modelName: '' }), discoverModels)
      useLLMStore.setState({ discoverLocalContextWindow })
      await openEditor()
      await openSuggestions()
      await vi.waitFor(() => expect(suggestionValues()).toContain('gemma-3'))
      await chooseSuggestion('gemma-3')
      await vi.waitFor(() => expect(windowElement().value).toBe('8192'))
      await act(async () => { await windowInput().fill('20000') })
      await act(async () => { await windowInput().fill('') })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
      expect(windowElement().value).toBe('8192')
      expect(sourceTag()).toBe('来自服务商')
      expect(discoverLocalContextWindow).toHaveBeenCalledTimes(2)
    })

    it('云端先填模型名、后填 Key：自动拉到的列表补上窗口', async () => {
      const discoverModels = vi.fn(async () => ({ success: true as const, models: [{ id: 'gateway', name: 'gateway', value: 'gateway', capabilities: { contextWindowTokens: 128_000 } }] }))
      await renderSettings(savedProfile({ modelName: '', apiKey: '' }), discoverModels)
      await openEditor()
      await typeInto(modelNameInput(), 'gateway')
      await act(async () => { await new Promise(resolve => setTimeout(resolve, AUTO_DISCOVERY_WAIT_MS)) })
      expect(discoverModels).not.toHaveBeenCalled()
      await typeInto(apiKeyInput(), 'late-key')
      await vi.waitFor(() => expect(statusText()).toContain('已从端点获取'), { timeout: 3_000 })
      await vi.waitFor(() => expect(windowElement().value).toBe('128000'))
      expect(sourceTag()).toBe('来自服务商')
      expect(discoverModels).toHaveBeenCalledTimes(1)
    })

    it('本机网关改地址，运行值读不到早于列表到达：用列表声明的窗口', async () => {
      const discoverLocalContextWindow = vi.fn(async () => null)
      let respond: (result: ModelDiscoveryResult) => void = () => {}
      const discoverModels = vi.fn(() => new Promise<ModelDiscoveryResult>(resolve => { respond = resolve }))
      await renderSettings(savedProfile({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', modelName: 'gateway' }), discoverModels)
      useLLMStore.setState({ discoverLocalContextWindow })
      await openEditor()
      await typeInto(baseUrlInput('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:5678/v1')
      await vi.waitFor(() => expect(discoverLocalContextWindow).toHaveBeenCalled(), { timeout: 3_000 })
      await vi.waitFor(() => expect(discoverModels).toHaveBeenCalled())
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
      await act(async () => { respond({ success: true, models: [{ id: 'gateway', name: 'gateway', value: 'gateway', capabilities: { contextWindowTokens: 64_000 } }] }) })
      await vi.waitFor(() => expect(windowElement().value).toBe('64000'))
      expect(sourceTag()).toBe('来自服务商')
    })

    it.each<[string, string, string, number | null]>([
      ['1.5', '', '默认值', null],
      ['1e3', '1e3', '你填的', 1_000],
      ['-5', '', '默认值', null],
      ['', '', '默认值', null],
    ])('手填 %j：窗口 %j，来源 %s，不写成 1', async (raw, value, tag, saved) => {
      const { saveModel } = await renderSettings(savedProfile({ ...stored(20_000, 'manual') }), listed('manual-model'))
      await openEditor()
      await act(async () => { await windowInput().fill(raw) })
      expect(windowElement().value).toBe(value)
      expect(sourceTag()).toBe(tag)
      await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
      expect(saveModel.mock.calls[0][0].capabilities?.contextWindowTokens ?? null).toBe(saved)
    })

    it('切换服务商后，窗口取值不把旧 Key 发给新端点', async () => {
      const discoverModels = vi.fn<(request: ModelDiscoveryRequest) => Promise<ModelDiscoveryResult>>(async () => ({ success: true, models: endpointModels('typed-model') }))
      const model = savedProfile({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'gateway', ...stored(20_000, 'manual') })
      await renderSettings(model, discoverModels)
      await openEditor()
      await act(async () => { await windowInput().fill('') })
      await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(1))
      expect(discoverModels.mock.calls[0][0]).toMatchObject({ baseUrl: 'https://api.deepseek.com', apiKey: model.apiKey })

      const providerSelect = Array.from(document.querySelectorAll('select')).find(select => select.value === 'deepseek')
      if (!providerSelect) throw new Error('Missing provider select')
      await typeInto(providerSelect, 'gemini')
      await typeInto(modelNameInput(), 'typed-model')
      await act(async () => { await new Promise(resolve => setTimeout(resolve, AUTO_DISCOVERY_WAIT_MS)) })
      expect(discoverModels).toHaveBeenCalledTimes(1)

      await typeInto(apiKeyInput(), 'gemini-key')
      await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(2), { timeout: 3_000 })
      expect(discoverModels.mock.calls[1][0]).toMatchObject({ baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'gemini-key' })
    })

    it('重新打开后清空手填，向当前端点重新取回声明的窗口', async () => {
      const discoverModels = vi.fn(async () => ({ success: true as const, models: [{ id: 'gateway', name: 'gateway', value: 'gateway', capabilities: { contextWindowTokens: 128_000 } }] }))
      const model = savedProfile({ modelName: 'gateway', ...stored(20_000, 'manual') })
      await renderSettings(model, discoverModels)
      await openEditor()
      expect(discoverModels).not.toHaveBeenCalled()
      await act(async () => { await windowInput().fill('') })
      await vi.waitFor(() => expect(windowElement().value).toBe('128000'))
      expect(sourceTag()).toBe('来自服务商')
      expect(discoverModels).toHaveBeenCalledWith(discoveryRequest(model))
    })

    it.each<['endpoint' | 'manual', string, string, string]>([
      ['endpoint', '', '4096', '默认值'],
      ['manual', '32768', '32768', '你填的'],
    ])('重新选中已保存的本机模型读不到窗口：%s 的旧值变成 %j', async (source, value, placeholder, tag) => {
      await renderSettings(savedProfile({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', modelName: 'gemma-3', ...stored(32_768, source) }), listed('gemma-3'))
      useLLMStore.setState({ discoverLocalContextWindow: vi.fn(async () => null) })
      await openEditor()
      await openSuggestions()
      await vi.waitFor(() => expect(suggestionValues()).toContain('gemma-3'))
      await chooseSuggestion('gemma-3')
      await vi.waitFor(() => expect(sourceTag()).toBe(tag))
      expect(windowElement().value).toBe(value)
      expect(windowElement().placeholder).toBe(placeholder)
    })

    it('取回窗口期间换了 API Key，旧响应不写回', async () => {
      let respond: (result: ModelDiscoveryResult) => void = () => {}
      const discoverModels = vi.fn(() => new Promise<ModelDiscoveryResult>(resolve => { respond = resolve }))
      await renderSettings(savedProfile({ modelName: 'gateway', ...stored(20_000, 'manual') }), discoverModels)
      await openEditor()
      await act(async () => { await windowInput().fill('') })
      await vi.waitFor(() => expect(discoverModels).toHaveBeenCalled())
      await typeInto(apiKeyInput(), 'replacement-credential')
      await act(async () => { respond({ success: true, models: [{ id: 'gateway', name: 'gateway', value: 'gateway', capabilities: { contextWindowTokens: 128_000 } }] }) })
      expect(windowElement().value).toBe('')
      expect(sourceTag()).toBe('默认值')
    })

    it('重新取回窗口失败时静默用默认值', async () => {
      await renderSettings(savedProfile({ modelName: 'gateway', ...stored(20_000, 'manual') }), vi.fn(async () => { throw new Error('down') }))
      await openEditor()
      await act(async () => { await windowInput().fill('') })
      await vi.waitFor(() => expect(sourceTag()).toBe('默认值'))
      expect(windowElement().placeholder).toBe('32768')
      expect(container?.querySelector('[role="alert"]')).toBeNull()
    })

    it('作者填数后变你填的，清空后回到列表声明的值', async () => {
      const discoverModels = vi.fn(async () => ({ success: true as const, models: [{ id: 'gateway', name: 'gateway', value: 'gateway', capabilities: { contextWindowTokens: 128_000 } }] }))
      await renderSettings(savedProfile({ modelName: '' }), discoverModels)
      await openEditor()
      await openSuggestions()
      await vi.waitFor(() => expect(suggestionValues()).toContain('gateway'))
      await chooseSuggestion('gateway')
      expect(windowElement().value).toBe('128000')
      expect(sourceTag()).toBe('来自服务商')
      await act(async () => { await windowInput().fill('20000') })
      expect(sourceTag()).toBe('你填的')
      await act(async () => { await windowInput().fill('') })
      expect(windowElement().value).toBe('128000')
      expect(sourceTag()).toBe('来自服务商')
    })
  })

  it('previews the Gemini 3 thinking level and accepts a thinking-level mapping on the Gemini protocol', async () => {
    const model = savedProfile({ provider: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com',
      modelName: 'gemini-3.8-flash', reasoningOverride: 'high' })
    const { saveModel } = await renderSettings(model, vi.fn())
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
    })
    expect(container?.querySelector('[data-reasoning-wire]')?.textContent).toBe('thinking_level=high')
    const mapping = { adapter: 'gemini-thinking-level', supportedEfforts: ['high'], providerValues: { high: 'medium' } }
    await act(async () => {
      await page.getByText('高级参数映射', { exact: true }).click()
      await page.getByLabelText('推理参数映射 JSON').fill(JSON.stringify(mapping))
      await page.getByRole('button', { name: '应用映射', exact: true }).click()
      await page.getByRole('button', { name: '保存配置', exact: true }).click()
    })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ reasoningMapping: mapping }))
  })

  it.each([
    ['zh-CN', '关闭 → 低', 'Gemini 3 无法完全关闭思考'],
    ['en-US', 'Off → Low', 'Gemini 3 cannot turn thinking fully off'],
  ] as const)('explains in %s that turning thinking off on Gemini 3 sends its lowest level', async (locale, outcome, note) => {
    const model = savedProfile({ provider: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com',
      modelName: 'gemini-3.1-pro-preview', reasoningOverride: 'off' })
    await renderSettings(model, vi.fn(), locale)
    await act(async () => {
      await page.getByRole('button', { name: locale === 'zh-CN' ? /^编辑「/ : /^Edit “/ }).click()
      await page.getByRole('button', { name: locale === 'zh-CN' ? '高级设置' : 'Advanced settings', exact: true }).click()
    })
    const settings = container?.querySelector('[data-model-reasoning-override-settings]')?.textContent ?? ''
    expect(settings).toContain(outcome)
    expect(container?.querySelector('[data-reasoning-wire]')?.textContent).toBe('thinking_level=low')
    expect(settings).toContain(note)
  })

  it('does not show the Gemini 3 thinking note for other models', async () => {
    await renderSettings(savedProfile({ reasoningOverride: 'off' }), vi.fn())
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
    })
    expect(container?.querySelector('[data-model-reasoning-override-settings]')?.textContent).not.toContain('Gemini 3')
  })

  it('applies, rejects and clears an advanced mapping before saving', async () => {
    const { saveModel } = await renderSettings(savedProfile(), vi.fn())
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
      await page.getByText('高级参数映射', { exact: true }).click()
      await page.getByLabelText('推理参数映射 JSON').fill('{broken')
      await page.getByRole('button', { name: '应用映射', exact: true }).click()
    })
    await expect.element(page.getByRole('alert')).toHaveTextContent('映射无效')
    const mapping = { adapter: 'openai-reasoning-effort', supportedEfforts: ['xhigh'], providerValues: { xhigh: 'Extra' } }
    await act(async () => {
      await page.getByLabelText('推理参数映射 JSON').fill(JSON.stringify(mapping))
      await page.getByRole('button', { name: '应用映射', exact: true }).click()
      await page.getByLabelText('模型推理覆盖').selectOptions('xhigh')
    })
    expect(container?.textContent).toContain('reasoning_effort=Extra')
    await act(async () => {
      await page.getByLabelText('推理参数映射 JSON').fill(JSON.stringify({ adapter: 'deepseek-v4-thinking',
        supportedEfforts: ['off', 'high'], providerValues: { off: 'disabled', high: 'enabled' } }))
      await page.getByRole('button', { name: '应用映射', exact: true }).click()
    })
    expect(container?.textContent).toContain('仅支持思考开关')
    await act(async () => {
      await page.getByLabelText('推理参数映射 JSON').fill('')
      await page.getByRole('button', { name: '应用映射', exact: true }).click()
      await page.getByLabelText('模型推理覆盖').selectOptions('off')
    })
    expect(container?.textContent).toContain('未发送 / 供应商默认')
    await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ reasoningMapping: undefined, reasoningOverride: 'off' }))
  })
  it('does not discover when settings opens and refreshes explicitly with the current form configuration', async () => {
    const model = savedProfile()
    const discoverModels = vi.fn(async () => ({
      success: true as const,
      models: [
        { id: 'provider/model-a', name: 'Model A', value: 'provider/model-a' },
      ],
    }))
    await renderSettings(model, discoverModels)

    expect(discoverModels).not.toHaveBeenCalled()
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
    })
    expect(discoverModels).not.toHaveBeenCalled()

    await act(async () => {
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })

    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledWith(discoveryRequest(model)))
    expect(discoverModels.mock.calls[0]).toEqual([discoveryRequest(model)])
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['provider/model-a']))
  })

  it('refreshes models from a new unsaved endpoint and credentials', async () => {
    const model = savedProfile()
    const discoverModels = vi.fn(async () => ({
      success: true as const,
      models: [{ id: 'fresh-model', name: 'Fresh model', value: 'fresh-model' }],
    }))
    await renderSettings(model, discoverModels, 'zh-CN', [], false)
    await act(async () => {
      await page.getByRole('button', { name: '添加模型', exact: true }).click()
    })

    const editedBaseUrl = 'https://edited-provider.invalid/v1'
    const editedApiKey = `edited-${crypto.randomUUID()}`
    const baseUrlInput = Array.from(document.querySelectorAll('input'))
      .find(candidate => candidate.value === 'https://api.openai.com')
    const apiKeyInput = document.querySelector('input[placeholder="sk-..."]')
    if (!(baseUrlInput instanceof HTMLInputElement)) throw new Error('Missing base URL input')
    if (!(apiKeyInput instanceof HTMLInputElement)) throw new Error('Missing API key input')
    for (const [input, nextValue] of [
      [baseUrlInput, editedBaseUrl],
      [apiKeyInput, editedApiKey],
    ] as const) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, nextValue)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }

    await act(async () => {
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })

    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledWith({
      provider: 'openai',
      protocol: 'openai',
      baseUrl: editedBaseUrl,
      apiKey: editedApiKey,
      purposes: ['generation', 'refinement', 'summary'],
    }))
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['fresh-model']))
  })

  it('allows saving a complete manual configuration without a display name', async () => {
    const model = savedProfile({ name: '' })
    const discoverModels = vi.fn()
    const { saveModel } = await renderSettings(model, discoverModels)
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
    })

    await expect.element(page.getByRole('button', { name: '保存配置', exact: true })).toBeEnabled()
    await act(async () => {
      await page.getByRole('button', { name: '保存配置', exact: true }).click()
    })
    await vi.waitFor(() => expect(saveModel).toHaveBeenCalledWith(model))
  })

  it('clears stale capabilities for an unknown selected id and saves only after confirmation', async () => {
    const model = savedProfile({
      capabilities: {
        contextWindowTokens: 32_768,
        maxOutputTokens: 4096,
        reasoning: false,
        structuredOutput: false,
        usage: false,
      },
      reasoningOverride: 'off',
    })
    const discoverModels = vi.fn(async () => ({
      success: true as const,
      models: [
        { id: 'provider/model-a', name: 'Model A', value: 'provider/model-a' },
        { id: 'provider/model-b', name: 'Model B', value: 'provider/model-b' },
      ],
    }))
    const { saveModel, setDefaultModel } = await renderSettings(model, discoverModels)
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })

    await vi.waitFor(() => expect(suggestionValues()).toEqual(['provider/model-a', 'provider/model-b']))
    await chooseSuggestion('provider/model-b')

    expect(saveModel).not.toHaveBeenCalled()
    expect(setDefaultModel).not.toHaveBeenCalled()
    expect(useLLMStore.getState().defaultModelId).toBe(model.id)
    expect(modelNameInput().value).toBe('provider/model-b')
    expect(suggestionOptions()).toHaveLength(0)

    await act(async () => {
      await page.getByRole('button', { name: '保存配置', exact: true }).click()
    })
    await vi.waitFor(() => expect(saveModel).toHaveBeenCalledTimes(1))
    expect(saveModel).toHaveBeenCalledWith({
      ...model,
      modelName: 'provider/model-b',
      capabilities: undefined,
      capabilitySources: { contextWindowTokens: 'unknown', maxOutputTokens: 'unknown', reasoning: 'unknown', structuredOutput: 'unknown', usage: 'unknown' },
      reasoningOverride: 'auto',
    })
    expect(setDefaultModel).not.toHaveBeenCalled()
    expect(useLLMStore.getState().defaultModelId).toBe(model.id)
  })

  it('keeps manual model input available after discovery fails', async () => {
    const model = savedProfile()
    const discoverModels = vi.fn(async () => ({
      success: false as const,
      errorCode: 'unsupported' as const,
    }))
    const { saveModel } = await renderSettings(model, discoverModels)
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })

    await expect.element(page.getByText('该端点不支持标准模型列表接口。请继续手工填写模型 ID。', { exact: true })).toBeVisible()
    const manualModelInput = Array.from(document.querySelectorAll('input'))
      .find(input => input.value === model.modelName)
    if (!(manualModelInput instanceof HTMLInputElement)) throw new Error('Missing manual model input')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(manualModelInput, 'manual-fallback-model')
      manualModelInput.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(saveModel).not.toHaveBeenCalled()
    await act(async () => {
      await page.getByRole('button', { name: '保存配置', exact: true }).click()
    })
    await vi.waitFor(() => expect(saveModel).toHaveBeenCalledWith({
      ...model,
      modelName: 'manual-fallback-model',
      capabilities: undefined,
      capabilitySources: { contextWindowTokens: 'unknown', maxOutputTokens: 'unknown', reasoning: 'unknown', structuredOutput: 'unknown', usage: 'unknown' },
      reasoningOverride: 'auto',
    }))
  })

  it('ignores a pending discovery after its endpoint configuration is edited', async () => {
    const model = savedProfile()
    let settleDiscovery!: (result: ModelDiscoveryResult) => void
    const pendingDiscovery = new Promise<ModelDiscoveryResult>((resolve) => {
      settleDiscovery = resolve
    })
    const discoverModels = vi.fn(() => pendingDiscovery)
    await renderSettings(model, discoverModels)
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })
    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(1))

    const endpointInput = Array.from(document.querySelectorAll('input'))
      .find(candidate => candidate.value === model.baseUrl)
    if (!(endpointInput instanceof HTMLInputElement)) throw new Error('Missing endpoint input')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(endpointInput, 'https://edited-provider.invalid/v1')
      endpointInput.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await expect.element(page.getByRole('button', { name: '获取模型列表', exact: true })).toBeEnabled()
    expect(discoverModels).toHaveBeenCalledTimes(1)

    await act(async () => {
      settleDiscovery({
        success: true,
        models: [{ id: 'stale-model', name: 'Stale model', value: 'stale-model' }],
      })
      await pendingDiscovery
    })

    expect(suggestionValues()).not.toContain('stale-model')
  })

  it('ignores a pending discovery after switching to another saved profile', async () => {
    const first = savedProfile({ id: 'first-profile', name: 'First profile' })
    const second = savedProfile({ id: 'second-profile', name: 'Second profile', modelName: 'second-manual-model' })
    let settleDiscovery!: (result: ModelDiscoveryResult) => void
    const pendingDiscovery = new Promise<ModelDiscoveryResult>((resolve) => {
      settleDiscovery = resolve
    })
    const discoverModels = vi.fn(() => pendingDiscovery)
    await renderSettings(first, discoverModels, 'zh-CN', [second])

    const clickEditButton = async (index: number) => {
      const buttons = Array.from(document.querySelectorAll('button[aria-label^="编辑「"]'))
      const button = buttons[index]
      if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing edit button ${index}`)
      await act(async () => button.click())
    }

    await clickEditButton(0)
    await act(async () => {
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })
    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledWith(discoveryRequest(first)))
    await act(async () => {
      await page.getByRole('button', { name: '取消', exact: true }).click()
    })
    await clickEditButton(1)

    await act(async () => {
      settleDiscovery({
        success: true,
        models: [{ id: 'stale-first-model', name: 'Stale first model', value: 'stale-first-model' }],
      })
      await pendingDiscovery
    })

    discoverModels.mockImplementation(async () => ({ success: true as const, models: [{ id: 'fresh', name: 'fresh', value: 'fresh' }] }))
    await openSuggestions()
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['fresh']))
    expect(modelNameInput().value).toBe(second.modelName)
    await expect.element(page.getByRole('button', { name: '获取模型列表', exact: true })).toBeEnabled()
  })

  it('ignores a pending discovery after settings is closed and reopened', async () => {
    const model = savedProfile()
    let settleDiscovery!: (result: ModelDiscoveryResult) => void
    const pendingDiscovery = new Promise<ModelDiscoveryResult>((resolve) => {
      settleDiscovery = resolve
    })
    const discoverModels = vi.fn(() => pendingDiscovery)
    await renderSettings(model, discoverModels)
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })
    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(1))

    await act(async () => {
      root?.render(<></>)
    })
    await act(async () => {
      root?.render(<StageSettings library={false} />)
    })
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
      settleDiscovery({
        success: true,
        models: [{ id: 'stale-closed-model', name: 'Stale closed model', value: 'stale-closed-model' }],
      })
      await pendingDiscovery
    })

    discoverModels.mockImplementation(async () => ({ success: true as const, models: [{ id: 'fresh', name: 'fresh', value: 'fresh' }] }))
    await openSuggestions()
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['fresh']))
    await expect.element(page.getByRole('button', { name: '获取模型列表', exact: true })).toBeEnabled()
  })

  it.each([
    {
      errorCode: 'auth' as const,
      locale: 'zh-CN' as const,
      expected: '鉴权失败：请检查 API Key。手工模型 ID 仍可使用。',
    },
    {
      errorCode: 'auth' as const,
      locale: 'en-US' as const,
      expected: 'Authentication failed. Check the API key. Manual model IDs remain available.',
    },
    {
      errorCode: 'unsupported' as const,
      locale: 'zh-CN' as const,
      expected: '该端点不支持标准模型列表接口。请继续手工填写模型 ID。',
    },
    {
      errorCode: 'unsupported' as const,
      locale: 'en-US' as const,
      expected: 'This endpoint does not support the standard model-list API. Continue with a manual model ID.',
    },
    {
      errorCode: 'network' as const,
      locale: 'zh-CN' as const,
      expected: '网络请求失败，请检查端点或网络后重试。手工模型 ID 仍可使用。',
    },
    {
      errorCode: 'network' as const,
      locale: 'en-US' as const,
      expected: 'The network request failed. Check the endpoint or network and retry. Manual model IDs remain available.',
    },
    {
      errorCode: 'invalid_response' as const,
      locale: 'zh-CN' as const,
      expected: '端点返回了无法识别的模型列表。请继续手工填写模型 ID。',
    },
    {
      errorCode: 'invalid_response' as const,
      locale: 'en-US' as const,
      expected: 'The endpoint returned an invalid model list. Continue with a manual model ID.',
    },
    {
      errorCode: 'no_models' as const,
      locale: 'zh-CN' as const,
      expected: '端点没有返回任何模型。请继续手工填写模型 ID。',
    },
    {
      errorCode: 'no_models' as const,
      locale: 'en-US' as const,
      expected: 'The endpoint returned no models. Continue with a manual model ID.',
    },
    {
      errorCode: 'no_suitable_models' as const,
      locale: 'zh-CN' as const,
      expected: '端点返回的模型都不适合当前用途。请继续手工填写模型 ID。',
    },
    {
      errorCode: 'no_suitable_models' as const,
      locale: 'en-US' as const,
      expected: 'None of the endpoint models fit this purpose. Continue with a manual model ID.',
    },
  ])('renders $locale $errorCode guidance', async ({ errorCode, locale, expected }) => {
    const model = savedProfile()
    const discoverModels = vi.fn(async () => ({ success: false as const, errorCode }))
    await renderSettings(model, discoverModels, locale)
    await act(async () => {
      await page.getByRole('button', { name: locale === 'zh-CN' ? /^编辑「/ : /^Edit “/ }).click()
      await page.getByRole('button', { name: locale === 'zh-CN' ? '获取模型列表' : 'Refresh model list', exact: true }).click()
    })
    await expect.element(page.getByText(expected, { exact: true })).toBeVisible()
  })

  it('reduces an IPC rejection to generic network guidance and re-enables refresh', async () => {
    const model = savedProfile()
    const sensitiveDetail = `ipc-${model.apiKey}-${model.baseUrl}`
    const discoverModels = vi.fn(async () => {
      throw new Error(sensitiveDetail)
    })
    await renderSettings(model, discoverModels)
    await act(async () => {
      await page.getByRole('button', { name: /^编辑「/ }).click()
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
    })

    await expect.element(page.getByText('网络请求失败，请检查端点或网络后重试。手工模型 ID 仍可使用。', { exact: true })).toBeVisible()
    expect(document.body.textContent).not.toContain(sensitiveDetail)
    await expect.element(page.getByRole('button', { name: '获取模型列表', exact: true })).toBeEnabled()
  })

  it.each([
    { locale: 'zh-CN' as const, add: '添加模型', hint: '填写 base_url 和 API Key 后获取模型列表。' },
    { locale: 'en-US' as const, add: 'Add model', hint: 'Enter the base_url and API key to fetch the model list.' },
  ])('offers no suggestions and asks for the base_url and key in $locale before they are filled', async ({ locale, add, hint }) => {
    const discoverModels = listed('gpt-5.5-mini')
    await renderSettings(savedProfile(), discoverModels, locale, [], false)
    await act(async () => { await page.getByRole('button', { name: add, exact: true }).click() })
    expect(statusText()).toBe(hint)
    await openSuggestions(locale)
    expect(suggestionOptions()).toHaveLength(0)
    expect(statusText()).toBe(hint)
    expect(document.body.textContent).not.toMatch(/推荐|Recommended/u)
    await typeInto(baseUrlInput('https://api.openai.com'), 'https://gateway.invalid/v1')
    await new Promise(resolve => setTimeout(resolve, AUTO_DISCOVERY_WAIT_MS))
    expect(discoverModels).not.toHaveBeenCalled()
    expect(statusText()).toBe(hint)
  })

  it('starts a new configuration with an empty model name and says what is missing before saving', async () => {
    await renderSettings(savedProfile(), vi.fn(), 'zh-CN', [], false)
    await act(async () => { await page.getByRole('button', { name: '添加模型', exact: true }).click() })
    expect(modelNameInput().value).toBe('')
    const save = page.getByRole('button', { name: '保存配置', exact: true })
    await expect.element(save).toBeDisabled()
    await expect.element(save).toHaveAccessibleDescription('保存前还需填写：API Key、模型名称。')
    await typeInto(apiKeyInput(), 'sk-new-key')
    await expect.element(save).toHaveAccessibleDescription('保存前还需填写：模型名称。')
    await typeInto(modelNameInput(), 'my-model')
    await expect.element(save).toBeEnabled()
  })

  it('asks for the endpoint and key before the model name, and fetches once the key is filled without opening the list', async () => {
    const discoverModels = listed('gpt-5.5-mini')
    await renderSettings(savedProfile(), discoverModels, 'zh-CN', [], false)
    await act(async () => { await page.getByRole('button', { name: '添加模型', exact: true }).click() })
    const form = modelNameInput().closest('.rounded-xl')
    const labels = Array.from(form?.querySelectorAll('label') ?? []).map(label => label.textContent?.trim())
    const order = ['服务商', '调用协议', 'base_url', 'API Key', 'model（模型名称）'].map(label => labels.indexOf(label))
    expect(order.every(index => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((left, right) => left - right))

    for (const partial of ['s', 'sk-', 'sk-new-key']) await typeInto(apiKeyInput(), partial)
    await vi.waitFor(() => expect(statusText()).toBe('已从端点获取 1 个模型。'))
    expect(discoverModels).toHaveBeenCalledTimes(1)
    expect(discoverModels).toHaveBeenCalledWith({ provider: 'openai', protocol: 'openai', baseUrl: 'https://api.openai.com',
      apiKey: 'sk-new-key', purposes: ['generation', 'refinement', 'summary'] })
    expect(modelNameInput().getAttribute('aria-expanded')).toBe('false')
    await openSuggestions()
    expect(suggestionValues()).toEqual(['gpt-5.5-mini'])
    expect(discoverModels).toHaveBeenCalledTimes(1)
  })

  it('drops the fetched list and fetches again with the new key after the key changes', async () => {
    const discoverModels = vi.fn(async ({ apiKey }: { apiKey: string }) => ({ success: true as const,
      models: endpointModels(apiKey === 'sk-second' ? 'second-key-model' : 'first-key-model') }))
    await renderSettings(savedProfile(), discoverModels, 'zh-CN', [], false)
    await act(async () => { await page.getByRole('button', { name: '添加模型', exact: true }).click() })
    await typeInto(apiKeyInput(), 'sk-first')
    await vi.waitFor(() => expect(statusText()).toBe('已从端点获取 1 个模型。'))
    await typeInto(apiKeyInput(), 'sk-second')
    expect(statusText()).toBeUndefined()
    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(2))
    expect(discoverModels.mock.calls[1][0]).toMatchObject({ apiKey: 'sk-second' })
    await vi.waitFor(() => expect(statusText()).toBe('已从端点获取 1 个模型。'))
    await openSuggestions()
    expect(suggestionValues()).toEqual(['second-key-model'])
  })

  it('fetches, tests and saves a generation model on a local address without a key', async () => {
    const discoverModels = listed('local-model')
    const { saveModel } = await renderSettings(savedProfile(), discoverModels, 'zh-CN', [], false)
    await act(async () => { await page.getByRole('button', { name: '添加模型', exact: true }).click() })
    await typeInto(baseUrlInput('https://api.openai.com'), 'http://127.0.0.1:1234/v1')
    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '' })))
    await typeInto(modelNameInput(), 'local-model')
    await expect.element(page.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled()
    await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', modelName: 'local-model' }))
  })

  it('saves an embedding model on a local address that is not Ollama without a key', async () => {
    const model = savedProfile({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', modelName: 'local-embed', purposes: ['embedding'] })
    const { saveModel } = await renderSettings(model, listed('local-embed'))
    await act(async () => { useLayoutStore.setState({ settingsSection: 'embedding' }) })
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    const save = page.getByRole('button', { name: '保存配置', exact: true })
    await expect.element(save).toBeEnabled()
    expect(apiKeyInput().placeholder).toBe('本地部署可留空')
    await act(async () => { await save.click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', modelName: 'local-embed' }))
  })

  it('still asks for a key before saving a cloud embedding model', async () => {
    const model = savedProfile({ baseUrl: 'https://provider.invalid/v1', apiKey: '', modelName: 'cloud-embed', purposes: ['embedding'] })
    await renderSettings(model, listed('cloud-embed'))
    await act(async () => { useLayoutStore.setState({ settingsSection: 'embedding' }) })
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    const save = page.getByRole('button', { name: '保存配置', exact: true })
    await expect.element(save).toBeDisabled()
    await expect.element(save).toHaveAccessibleDescription('保存前还需填写：API Key。')
  })

  it('keeps the connection test off until a model name is filled', async () => {
    await renderSettings(savedProfile(), vi.fn(), 'zh-CN', [], false)
    await act(async () => { await page.getByRole('button', { name: '添加模型', exact: true }).click() })
    await typeInto(apiKeyInput(), 'sk-new-key')
    const test = page.getByRole('button', { name: '测试连接', exact: true })
    await expect.element(test).toBeDisabled()
    await typeInto(modelNameInput(), 'gpt-5.5-mini')
    await expect.element(test).toBeEnabled()
  })

  it('saves a typed model name on a new configuration whose endpoint has no model list', async () => {
    const discoverModels = vi.fn(async () => ({ success: false as const, errorCode: 'unsupported' as const }))
    const { saveModel } = await renderSettings(savedProfile(), discoverModels, 'zh-CN', [], false)
    await act(async () => { await page.getByRole('button', { name: '添加模型', exact: true }).click() })
    await typeInto(baseUrlInput('https://api.openai.com'), 'https://gateway.invalid/v1')
    await typeInto(apiKeyInput(), 'sk-gateway')
    await expect.element(page.getByText('该端点不支持标准模型列表接口。请继续手工填写模型 ID。', { exact: true })).toBeVisible()
    await typeInto(modelNameInput(), 'gateway/private-model')
    await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://gateway.invalid/v1', modelName: 'gateway/private-model' }))
  })

  it.each(['selected', 'typed'] as const)('keeps the Gemini 3 thinking evidence for a %s model named like a preset', async (how) => {
    const model = savedProfile({ provider: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', modelName: '' })
    const discoverModels = vi.fn(async () => ({ success: true as const, models: [
      { id: 'models/gemini-3.8-flash', name: 'Gemini 3.8 Flash', value: 'gemini-3.8-flash', capabilities: { contextWindowTokens: 1_048_576, maxOutputTokens: 65_536 } },
    ] }))
    const { saveModel } = await renderSettings(model, discoverModels)
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    if (how === 'selected') {
      await openSuggestions()
      await vi.waitFor(() => expect(suggestionValues()).toEqual(['gemini-3.8-flash']))
      await chooseSuggestion('gemini-3.8-flash')
    } else {
      await typeInto(modelNameInput(), 'gemini-3.8-flash')
    }
    await act(async () => {
      await page.getByRole('button', { name: '高级设置', exact: true }).click()
      await page.getByLabelText('模型推理覆盖').selectOptions('off')
    })
    const settings = container?.querySelector('[data-model-reasoning-override-settings]')?.textContent ?? ''
    expect(settings).toContain('关闭 → 低')
    expect(settings).toContain('Gemini 3 无法完全关闭思考')
    expect(container?.querySelector('[data-reasoning-wire]')?.textContent).toBe('thinking_level=low')
    await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'gemini-3.8-flash',
      capabilities: expect.objectContaining({ reasoning: true, structuredOutput: true }) }))
  })

  it('applies the preset capabilities of a typed embedding model', async () => {
    const model = savedProfile({ provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', modelName: '', purposes: ['embedding'] })
    const { saveModel } = await renderSettings(model, vi.fn())
    await act(async () => { useLayoutStore.setState({ settingsSection: 'embedding' }) })
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    await typeInto(modelNameInput(), 'BAAI/bge-m3')
    await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'BAAI/bge-m3',
      capabilities: expect.objectContaining({ contextWindowTokens: 8192 }) }))
  })

  it.each(['typed', 'selected'] as const)('drops the previous capabilities when an embedding model without preset data is %s', async (how) => {
    const model = savedProfile({ provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'BAAI/bge-m3', purposes: ['embedding'],
      capabilities: { contextWindowTokens: 8192, maxOutputTokens: 0, reasoning: false, structuredOutput: false, usage: true } })
    const { saveModel } = await renderSettings(model, listed('Qwen/Qwen3-Embedding-8B'))
    await act(async () => { useLayoutStore.setState({ settingsSection: 'embedding' }) })
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    if (how === 'typed') {
      await typeInto(modelNameInput(), 'Qwen/Qwen3-Embedding-8B')
    } else {
      await openSuggestions()
      await vi.waitFor(() => expect(suggestionValues()).toEqual(['Qwen/Qwen3-Embedding-8B']))
      await chooseSuggestion('Qwen/Qwen3-Embedding-8B')
    }
    await expect.element(page.getByLabelText('上下文窗口', { exact: true })).toHaveValue(null)
    await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'Qwen/Qwen3-Embedding-8B', capabilities: undefined }))
  })

  it('does not fetch while the base_url is not yet an http address', async () => {
    const discoverModels = listed('gpt-5.5-mini')
    await renderSettings(savedProfile(), discoverModels, 'zh-CN', [], false)
    await act(async () => { await page.getByRole('button', { name: '添加模型', exact: true }).click() })
    await typeInto(apiKeyInput(), 'sk-new-key')
    await typeInto(baseUrlInput('https://api.openai.com'), 'api.example')
    await new Promise(resolve => setTimeout(resolve, AUTO_DISCOVERY_WAIT_MS))
    expect(discoverModels).not.toHaveBeenCalled()
    await typeInto(baseUrlInput('api.example'), 'https://api.example/v1')
    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(1))
  })

  it('forgets the capability sources of the previous embedding model after switching provider', async () => {
    const model = savedProfile({ provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'BAAI/bge-m3', purposes: ['embedding'],
      capabilities: { contextWindowTokens: 8192, maxOutputTokens: 1, reasoning: false, structuredOutput: false, usage: true },
      capabilitySources: { contextWindowTokens: 'preset', maxOutputTokens: 'preset', reasoning: 'preset', structuredOutput: 'preset', usage: 'preset' } })
    const { saveModel } = await renderSettings(model, vi.fn())
    await act(async () => { useLayoutStore.setState({ settingsSection: 'embedding' }) })
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    const providerSelect = Array.from(document.querySelectorAll('select')).find(select => select.value === 'siliconflow')
    if (!providerSelect) throw new Error('Missing provider select')
    await typeInto(providerSelect, 'openai')
    await typeInto(apiKeyInput(), 'sk-openai')
    await typeInto(modelNameInput(), 'text-embedding-3-small')
    await act(async () => { await page.getByLabelText('上下文窗口', { exact: true }).fill('4096') })
    await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'text-embedding-3-small',
      capabilitySources: expect.objectContaining({ contextWindowTokens: 'manual', usage: 'unknown' }) }))
  })

  it('keeps the author settings when the current embedding model is chosen again', async () => {
    const capabilities = { contextWindowTokens: 4096, maxOutputTokens: 1, reasoning: false, structuredOutput: false, usage: false }
    const model = savedProfile({ provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', modelName: 'Qwen/Qwen3-Embedding-8B',
      purposes: ['embedding'], capabilities, capabilitySources: { contextWindowTokens: 'manual' } })
    const { saveModel } = await renderSettings(model, listed('Qwen/Qwen3-Embedding-8B'))
    await act(async () => { useLayoutStore.setState({ settingsSection: 'embedding' }) })
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    await openSuggestions()
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['Qwen/Qwen3-Embedding-8B']))
    await chooseSuggestion('Qwen/Qwen3-Embedding-8B')
    await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ capabilities, capabilitySources: { contextWindowTokens: 'manual' } }))
  })

  it('keeps the base_url and key hint instead of requesting when refresh is pressed too early', async () => {
    const discoverModels = listed('gpt-5.5-mini')
    await renderSettings(savedProfile(), discoverModels, 'zh-CN', [], false)
    await act(async () => { await page.getByRole('button', { name: '添加模型', exact: true }).click() })
    await act(async () => { await page.getByRole('button', { name: '获取模型列表', exact: true }).click() })
    expect(discoverModels).not.toHaveBeenCalled()
    expect(statusText()).toBe('填写 base_url 和 API Key 后获取模型列表。')
  })

  it('fetches once when a saved configuration first opens its list and shows the endpoint order', async () => {
    const model = savedProfile({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash' })
    const discoverModels = listed('deepseek-chat-next', 'deepseek-v4-flash')
    await renderSettings(model, discoverModels)
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    await new Promise(resolve => setTimeout(resolve, AUTO_DISCOVERY_WAIT_MS))
    expect(discoverModels).not.toHaveBeenCalled()

    await openSuggestions()
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['deepseek-chat-next', 'deepseek-v4-flash']))
    expect(discoverModels).toHaveBeenCalledWith(discoveryRequest(model))
    await expect.element(page.getByText('已从端点获取 2 个模型。', { exact: true })).toBeVisible()

    await openSuggestions()
    await openSuggestions()
    expect(discoverModels).toHaveBeenCalledTimes(1)
  })

  it('keeps the endpoint capability declaration of a catalog model served by a gateway', async () => {
    const model = savedProfile({ provider: 'openai', baseUrl: 'https://gateway.example/v1', modelName: 'manual-model', maxTokens: 65_536 })
    const discoverModels = vi.fn(async () => ({ success: true as const, models: [
      { id: 'gpt-4.1', name: 'gpt-4.1', value: 'gpt-4.1', capabilities: { contextWindowTokens: 16_000, maxOutputTokens: 8_000 } },
    ] }))
    const { saveModel } = await renderSettings(model, discoverModels)
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    await openSuggestions()
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['gpt-4.1']))
    await chooseSuggestion('gpt-4.1')
    await expect.element(page.getByLabelText('上下文窗口', { exact: true })).toHaveValue(16_000)
    await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'gpt-4.1',
      capabilities: expect.objectContaining({ contextWindowTokens: 16_000, maxOutputTokens: 8_000 }) }))
  })

  it('keeps the list in place while a press on a control below it completes, so the click is not lost', async () => {
    await renderFetched(DEEPSEEK_MODELS)
    const input = modelNameInput()
    await act(async () => { input.focus() })
    const cancel = Array.from(document.querySelectorAll('button')).find(button => button.textContent === '取消')
    if (!cancel) throw new Error('Missing cancel button')
    const pressedAt = cancel.getBoundingClientRect().top

    // 浏览器的顺序：pointerdown，按下的默认动作让输入框失焦，pointerup，再 click。
    await act(async () => {
      cancel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      cancel.focus({ preventScroll: true })
    })
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(cancel.getBoundingClientRect().top).toBe(pressedAt)
    await act(async () => {
      cancel.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(input.getAttribute('aria-expanded')).toBe('false')
  })

  it('starts ArrowUp at the last suggestion after typing, and leaves Enter to the IME while composing', async () => {
    await renderFetched(OLLAMA_MODELS, { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', modelName: 'qwen2.5', apiKey: '' })
    const input = modelNameInput()
    await act(async () => { input.focus() })
    await typeInto(input, 'LLAMA')
    await act(async () => { await userEvent.keyboard('{ArrowUp}') })
    const active = () => document.getElementById(input.getAttribute('aria-activedescendant') ?? '')?.querySelector('span')?.textContent
    expect(active()).toBe('llama3.2')

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }))
    })
    expect(input.value).toBe('LLAMA')
    expect(input.getAttribute('aria-expanded')).toBe('true')
  })

  it('drops a stale highlight when a refresh replaces the suggestions', async () => {
    const { discoverModels } = await renderFetched(DEEPSEEK_MODELS)
    let settle!: (result: ModelDiscoveryResult) => void
    discoverModels.mockImplementationOnce(() => new Promise<ModelDiscoveryResult>(resolve => { settle = resolve }))
    await act(async () => { await page.getByRole('button', { name: '获取模型列表', exact: true }).click() })
    const input = modelNameInput()
    await act(async () => { await userEvent.keyboard('{ArrowDown}') })
    await act(async () => { await userEvent.keyboard('{ArrowDown}') })
    expect(document.activeElement).toBe(input)
    expect(document.getElementById(input.getAttribute('aria-activedescendant') ?? '')?.querySelector('span')?.textContent).toBe('deepseek-v4-pro')

    await act(async () => settle({ success: true, models: endpointModels('deepseek-v4-flash', 'endpoint-only') }))
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['deepseek-v4-flash', 'endpoint-only']))
    expect(input.hasAttribute('aria-activedescendant')).toBe(false)
    await act(async () => { await userEvent.keyboard('{Enter}') })
    expect(input.value).toBe('deepseek-v4-flash')
  })

  it('asks Ollama users only for the base_url', async () => {
    const model = savedProfile({ provider: 'ollama', baseUrl: '', modelName: 'qwen2.5', apiKey: '' })
    await renderSettings(model, vi.fn())
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    expect(statusText()).toBe('填写 base_url 后获取模型列表。')
  })

  it('collapses the list when focus leaves it with the keyboard', async () => {
    await renderFetched(DEEPSEEK_MODELS)
    await act(async () => { modelNameInput().focus() })
    await act(async () => { await userEvent.keyboard('{Tab}') })
    expect(modelNameInput().getAttribute('aria-expanded')).toBe('true')
    await act(async () => { await userEvent.keyboard('{Tab}') })
    expect(modelNameInput().getAttribute('aria-expanded')).toBe('false')
  })

  it('filters suggestions while typing and keeps any typed model name', async () => {
    const { saveModel } = await renderFetched(OLLAMA_MODELS, { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', modelName: 'qwen2.5', apiKey: '' })

    await typeInto(modelNameInput(), 'LLAMA3')
    expect(suggestionValues()).toEqual(['llama3.3', 'llama3.2'])
    await typeInto(modelNameInput(), 'my-private-model')
    expect(suggestionOptions()).toHaveLength(0)
    await expect.element(page.getByText('没有匹配的候选，将使用输入的名称。', { exact: true })).toBeVisible()
    await act(async () => { await page.getByRole('button', { name: '保存配置', exact: true }).click() })
    expect(saveModel).toHaveBeenCalledWith(expect.objectContaining({ modelName: 'my-private-model' }))
  })

  it('chooses a suggestion with the arrow keys and Enter, and Escape only closes the list', async () => {
    await renderFetched(DEEPSEEK_MODELS)
    const input = modelNameInput()
    await act(async () => { await page.getByRole('button', { name: '收起候选模型', exact: true }).click() })
    await act(async () => { input.focus() })

    await act(async () => { await userEvent.keyboard('{ArrowDown}') })
    expect(input.getAttribute('aria-expanded')).toBe('true')
    await act(async () => { await userEvent.keyboard('{ArrowDown}') })
    const active = document.getElementById(input.getAttribute('aria-activedescendant') ?? '')
    expect(active?.querySelector('span')?.textContent).toBe('deepseek-v4-pro')
    await act(async () => { await userEvent.keyboard('{Enter}') })
    expect(input.value).toBe('deepseek-v4-pro')
    expect(input.getAttribute('aria-expanded')).toBe('false')

    await act(async () => { await userEvent.keyboard('{ArrowDown}') })
    await act(async () => { await userEvent.keyboard('{Escape}') })
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.value).toBe('deepseek-v4-pro')
    expect(document.activeElement).toBe(input)
    await expect.element(page.getByRole('button', { name: '保存配置', exact: true })).toBeVisible()
  })

  it('links the model name to a status line between the input and the list that also reads out empty results', async () => {
    await renderFetched(OLLAMA_MODELS, { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', modelName: 'qwen2.5', apiKey: '' })
    const status = () => document.getElementById(modelNameInput().getAttribute('aria-describedby') ?? '')
    expect(status()?.getAttribute('role')).toBe('status')
    expect(status()?.textContent).toBe(`已从端点获取 ${OLLAMA_MODELS.length} 个模型。`)

    const listbox = document.querySelector('[role="listbox"]')!
    expect(status()!.compareDocumentPosition(listbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await typeInto(modelNameInput(), 'my-private-model')
    expect(status()?.textContent).toContain('没有匹配的候选，将使用输入的名称。')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(modelNameInput().getAttribute('aria-expanded')).toBe('false')
    expect(modelNameInput().hasAttribute('aria-controls')).toBe(false)
    await act(async () => { await page.getByRole('button', { name: '展开候选模型', exact: true }).click() })
    expect(suggestionValues()).toContain('llama3.2')
  })

  it('keeps the list open and the input focused when the list padding is pressed', async () => {
    await renderFetched(DEEPSEEK_MODELS)
    await act(async () => { modelNameInput().focus() })
    await act(async () => { await userEvent.click(page.getByRole('listbox'), { position: { x: 2, y: 2 } }) })
    expect(document.activeElement).toBe(modelNameInput())
    expect(modelNameInput().getAttribute('aria-expanded')).toBe('true')
  })

  it('does not claim there are no suggestions while the endpoint list is still loading', async () => {
    const discoverModels = vi.fn(() => new Promise<ModelDiscoveryResult>(() => {}))
    await renderSettings(savedProfile(), discoverModels)
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    await openSuggestions()
    expect(statusText()).toBe('正在获取端点模型列表…')
  })

  it('marks only the current model with a check', async () => {
    await renderFetched(DEEPSEEK_MODELS, { modelName: 'deepseek-v4-pro' })
    const checked = suggestionOptions().filter(option => option.querySelector('svg[aria-hidden="true"]'))
    expect(checked.map(option => option.querySelector('span')?.textContent)).toEqual(['deepseek-v4-pro'])
    expect(checked[0].getAttribute('aria-selected')).toBe('true')
  })

  it('ignores clicks on suggestions while a refresh is about to replace them', async () => {
    const { discoverModels } = await renderFetched(DEEPSEEK_MODELS)
    let settle!: (result: ModelDiscoveryResult) => void
    discoverModels.mockImplementationOnce(() => new Promise<ModelDiscoveryResult>(resolve => { settle = resolve }))
    await act(async () => { await page.getByRole('button', { name: '获取模型列表', exact: true }).click() })
    expect(suggestionOptions().every(option => option.getAttribute('aria-disabled') === 'true')).toBe(true)
    await chooseSuggestion('deepseek-v4-pro')
    expect(modelNameInput().value).toBe('deepseek-v4-flash')

    await act(async () => settle({ success: true, models: endpointModels('deepseek-v4-flash', 'endpoint-only') }))
    await chooseSuggestion('endpoint-only')
    expect(modelNameInput().value).toBe('endpoint-only')
  })

  it('clears the model name, the key and the fetched list after switching provider, so the old key never reaches the new endpoint', async () => {
    const model = savedProfile({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash' })
    const discoverModels = vi.fn<(request: { provider: string }) => Promise<ModelDiscoveryResult>>(async () => ({
      success: true, models: endpointModels('deepseek-only'),
    }))
    await renderSettings(model, discoverModels)
    await act(async () => { await page.getByRole('button', { name: /^编辑「/ }).click() })
    await openSuggestions()
    await vi.waitFor(() => expect(suggestionValues()).toEqual(['deepseek-only']))
    await act(async () => { await page.getByRole('button', { name: '收起候选模型', exact: true }).click() })

    const providerSelect = Array.from(document.querySelectorAll('select')).find(select => select.value === 'deepseek')
    if (!providerSelect) throw new Error('Missing provider select')
    discoverModels.mockImplementationOnce(async () => ({ success: true,
      models: [{ id: 'models/gemini-3.8-flash', name: 'Gemini 3.8 Flash', value: 'gemini-3.8-flash' }] }))
    await typeInto(providerSelect, 'gemini')
    expect(modelNameInput().value).toBe('')
    expect(apiKeyInput().value).toBe('')
    expect(statusText()).toBe('填写 base_url 和 API Key 后获取模型列表。')
    await new Promise(resolve => setTimeout(resolve, AUTO_DISCOVERY_WAIT_MS))
    expect(discoverModels).toHaveBeenCalledTimes(1)
    await typeInto(apiKeyInput(), 'gemini-key')
    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(2))
    expect(discoverModels.mock.calls[1][0]).toMatchObject({ provider: 'gemini', protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'gemini-key' })
    await vi.waitFor(() => expect(statusText()).toBe('已从端点获取 1 个模型。'))
    await openSuggestions()
    expect(suggestionValues()).toEqual(['gemini-3.8-flash'])
  })
})
