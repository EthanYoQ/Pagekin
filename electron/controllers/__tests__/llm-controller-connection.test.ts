import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelProfile } from '../../../src/shared/ipc-channels'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  generate: vi.fn(),
  models: [] as ModelProfile[],
  locale: 'en-US',
}))

vi.mock('electron', () => ({
  app: { getLocale: () => mocks.locale },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('../../utils/config-utils', () => ({
  MODELS_CONFIG_PATH: 'models.json',
  GLOBAL_CONFIG_PATH: 'config.json',
  DEFAULT_GLOBAL_CONFIG: { proxy: { enabled: false } },
  readJsonFile: vi.fn((filePath: string, fallback: unknown) => filePath === 'models.json' ? mocks.models : fallback),
  tryReadJsonFile: vi.fn(() => ({ status: 'missing' })),
  writeJsonFile: vi.fn(),
}))

vi.mock('../../llm/llm-factory', () => ({
  LLMFactory: {
    getProvider: vi.fn(() => ({ generate: mocks.generate })),
  },
}))

import { registerLLMController } from '../llm-controller'

const deepSeekModel: ModelProfile = {
  id: 'deepseek-reasoner',
  name: 'DeepSeek Reasoner',
  provider: 'deepseek',
  protocol: 'openai',
  modelName: 'deepseek-reasoner',
  apiKey: 'test-key',
  baseUrl: 'https://api.deepseek.com',
  temperature: 0.7,
  maxTokens: 8192,
  purposes: ['generation'],
}

const fixedTemperatureKimiModel: ModelProfile = {
  ...deepSeekModel,
  id: 'kimi-k3',
  name: 'Kimi K3',
  provider: 'custom',
  modelName: 'kimi-k3',
  baseUrl: 'https://api.moonshot.cn/v1',
  temperature: 1,
}

const xaiReasoningModel: ModelProfile = {
  ...deepSeekModel,
  id: 'grok-4.5',
  name: 'Grok 4.5',
  provider: 'xai',
  modelName: 'grok-4.5',
  baseUrl: 'https://api.x.ai/v1',
  reasoningOverride: 'medium',
}

const legacyDeepSeekV4Model: ModelProfile = {
  ...deepSeekModel,
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  modelName: 'deepseek-v4-flash',
  capabilities: {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    reasoning: false,
    structuredOutput: true,
    usage: true,
  },
}

function connectionHandler(): IpcHandler {
  const handler = mocks.handlers.get('llm:test-connection')
  if (!handler) throw new Error('Missing llm:test-connection handler')
  return handler
}

beforeAll(() => {
  registerLLMController()
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.generate.mockImplementation(async (
    _model: ModelProfile,
    _messages: unknown,
    options: { maxTokens: number },
  ) => options.maxTokens <= 10
    ? { success: false, content: '', finishReason: 'length', error: 'API 返回的文本未正常完成' }
    : { success: true, content: 'hello', finishReason: 'stop' })
  mocks.models = [deepSeekModel]
})

describe('llm connection test', () => {
  it('uses the configured profile temperature for a generic connection probe', async () => {
    const genericModel: ModelProfile = {
      ...deepSeekModel,
      temperature: 1,
    }

    await expect(connectionHandler()({}, genericModel)).resolves.toEqual({
      success: true,
      error: undefined,
    })

    expect(mocks.generate).toHaveBeenCalledWith(
      genericModel,
      [{ role: 'user', content: 'Say "hello" and nothing else.' }],
      expect.objectContaining({ temperature: 1 }),
    )
  })

  it('omits temperature for a fixed-temperature Kimi connection probe', async () => {
    await expect(connectionHandler()({}, fixedTemperatureKimiModel)).resolves.toEqual({
      success: true,
      error: undefined,
    })

    expect(mocks.generate).toHaveBeenCalledWith(
      fixedTemperatureKimiModel,
      [{ role: 'user', content: 'Say "hello" and nothing else.' }],
      expect.objectContaining({ temperature: undefined }),
    )
  })

  it('gives reasoning models enough output budget to complete the probe', async () => {
    await expect(connectionHandler()({}, deepSeekModel)).resolves.toEqual({
      success: true,
      error: undefined,
    })

    expect(mocks.generate).toHaveBeenCalledWith(
      deepSeekModel,
      [{ role: 'user', content: 'Say "hello" and nothing else.' }],
      expect.objectContaining({ maxTokens: expect.any(Number) }),
    )
    const options = mocks.generate.mock.calls[0]?.[2] as { maxTokens: number }
    expect(options.maxTokens).toBeGreaterThanOrEqual(256)
  })

  describe('rerank profiles', () => {
    const rerankModel: ModelProfile = {
      ...deepSeekModel,
      id: 'rerank',
      provider: 'custom',
      modelName: 'my-reranker',
      apiKey: 'sk-fake-rerank',
      baseUrl: 'https://rerank.example/v1',
      purposes: ['rerank'],
    }
    const fetchMock = vi.fn()

    beforeEach(() => {
      fetchMock.mockReset()
      vi.stubGlobal('fetch', fetchMock)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    it('probes the rerank endpoint with the profile key instead of the chat endpoint', async () => {
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        const { documents } = JSON.parse(String(init.body)) as { documents: string[] }
        return new Response(JSON.stringify({ results: documents.map((_, index) => ({ index, relevance_score: 1 - index / 10 })) }))
      })

      await expect(connectionHandler()({}, rerankModel)).resolves.toEqual({ success: true, error: undefined })

      expect(mocks.generate).not.toHaveBeenCalled()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]!
      expect(url).toBe('https://rerank.example/v1/rerank')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-fake-rerank')
    })

    it('reports a failed probe without the endpoint or key', async () => {
      fetchMock.mockImplementation(async () => new Response('{}', { status: 401 }))

      const result = await connectionHandler()({}, rerankModel) as { success: boolean; error: string }

      expect(result.success).toBe(false)
      expect(result.error).toBeTruthy()
      expect(result.error).not.toContain('rerank.example')
      expect(result.error).not.toContain('sk-fake-rerank')
    })

    it.each([
      ['timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError')), 'timed out'],
      ['request-failed', () => Promise.reject(new TypeError('fetch failed')), 'Check the base_url'],
      ['http-error', async () => new Response('{}', { status: 401 }), 'Check the API key and model name'],
      ['invalid-response', async () => new Response('{}'), 'supports reranking'],
    ] as const)('explains a %s probe failure with its own advice', async (_reason, respond, advice) => {
      fetchMock.mockImplementation(respond)

      const result = await connectionHandler()({}, rerankModel) as { success: boolean; error: string }

      expect(result).toMatchObject({ success: false, error: expect.stringContaining(advice) })
    })
  })
})

describe('renderer-side generation entry points', () => {
  it.each([
    'llm:generate',
    'llm:generate-stream',
    'llm:cancel',
    'llm:begin-execution-lease',
    'llm:close-execution-lease',
  ])('registers no %s handler, so a renderer has no model call outside a main-owned generation run', channel => {
    expect(mocks.handlers.has(channel)).toBe(false)
  })
})

describe('llm generation parameter policy for the connection probe', () => {
  it('uses the verified reasoning policy', async () => {
    mocks.models = [xaiReasoningModel]
    await connectionHandler()({}, xaiReasoningModel, 'deep-planning')
    expect(mocks.generate.mock.calls.at(-1)?.[2]).toMatchObject({
      reasoning: { adapter: 'openai-reasoning-effort', reasoningEffort: 'medium' },
    })
  })

  it('uses the verified DeepSeek V4 policy', async () => {
    mocks.models = [legacyDeepSeekV4Model]
    await connectionHandler()({}, legacyDeepSeekV4Model, 'auto')
    expect(mocks.generate.mock.calls.at(-1)?.[2]).toMatchObject({
      reasoning: {
        adapter: 'deepseek-v4-thinking',
        thinking: 'enabled',
        reasoningEffort: 'low',
      },
    })
  })
})

describe('connection probe conversation scope', () => {
  it('does not give the connection probe a creative conversation scope', async () => {
    await connectionHandler()({}, deepSeekModel)

    const options = mocks.generate.mock.calls[0]?.[2] as { conversationId?: string }
    expect(options.conversationId).toBeUndefined()
  })
})

// 检索模型的连接测试：embedding 只交错误码（#474 B3），这里按系统语言换回可读说明，HTTP 状态与建议地址留着。
describe('retrieval model connection test', () => {
  const retrievalModel: ModelProfile = { ...deepSeekModel, id: 'bge', modelName: 'bge-m3', baseUrl: 'https://embedding.example/v1', purposes: ['embedding'] }

  it.each([
    ['en-US', 'Retrieval model request failed (HTTP 401)'],
    ['zh-CN', '检索模型请求失败（HTTP 401）'],
  ])('explains an HTTP failure in %s', async (locale, expected) => {
    mocks.locale = locale
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 401 })))
    try {
      const result = await mocks.handlers.get('llm:test-connection')!({}, retrievalModel) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain(expected)
      expect(result.error).not.toMatch(/EMBEDDING_|Error:/u)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    ['en-US', 'returned an unusable result', /\p{Script=Han}|EMBEDDING_|Error:/u],
    ['zh-CN', '检索模型返回的结果不合格', /EMBEDDING_|Error:/u],
  ])('explains an unusable embedding response in %s', async (locale, expected, forbidden) => {
    mocks.locale = locale
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 })))
    try {
      const result = await mocks.handlers.get('llm:test-connection')!({}, retrievalModel) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain(expected)
      expect(result.error).not.toMatch(forbidden)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('refuses an Anthropic-protocol retrieval model without sending any request', async () => {
    mocks.locale = 'en-US'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = await mocks.handlers.get('llm:test-connection')!({}, {
        ...retrievalModel, provider: 'bigmodel-anthropic', protocol: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      }) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Anthropic')
      expect(fetchMock).not.toHaveBeenCalled()
      expect(mocks.generate).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the suggested OpenAI-compatible Ollama address', async () => {
    mocks.locale = 'en-US'
    const result = await mocks.handlers.get('llm:test-connection')!({}, { ...retrievalModel, baseUrl: 'http://localhost:11434/api' }) as { success: boolean; error: string }
    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('http://localhost:11434/v1')
    expect(result.error).not.toMatch(/EMBEDDING_|\p{Script=Han}/u)
  })
})

// 模型表单原样显示连接测试的 error（#474 B6）：provider 只交码，主进程按界面语言写成说明，HTTP 状态与服务返回留着。
describe('generation model connection test failures', () => {
  it.each([
    ['en-US', 'Model request failed (HTTP 401)', /\p{Script=Han}|LLM_/u],
    ['zh-CN', '模型请求失败（HTTP 401）', /LLM_/u],
  ])('explains an HTTP failure in %s with the service response', async (locale, expected, forbidden) => {
    mocks.locale = locale
    mocks.generate.mockResolvedValueOnce({
      success: false, content: '', finishReason: 'error', error: 'LLM_REQUEST_FAILED',
      httpFailure: { status: 401, body: '{"error":"invalid api key"}' },
    })
    const result = await connectionHandler()({}, deepSeekModel) as { success: boolean; error: string }
    expect(result.success).toBe(false)
    expect(result.error).toContain(expected)
    expect(result.error).toContain('invalid api key')
    expect(result.error.replace('{"error":"invalid api key"}', '')).not.toMatch(forbidden)
  })

  it('names the finish reason when the probe reply was cut short', async () => {
    mocks.locale = 'en-US'
    mocks.generate.mockResolvedValueOnce({ success: false, content: '', finishReason: 'length', error: 'LLM_RESPONSE_INCOMPLETE' })
    await expect(connectionHandler()({}, deepSeekModel)).resolves.toEqual({
      success: false,
      error: 'The model did not finish its reply (finish reason: length).',
    })
  })

  it.each([
    ['en-US', 'only accepts a temperature from 0 to 1'],
    ['zh-CN', '温度必须在 0 到 1 之间'],
  ])('explains an out-of-range Kimi temperature in %s before any request', async (locale, expected) => {
    mocks.locale = locale
    const result = await connectionHandler()({}, { ...fixedTemperatureKimiModel, modelName: 'kimi-future-preview', temperature: 1.1 }) as { success: boolean; error: string }
    expect(result.success).toBe(false)
    expect(result.error).toContain(expected)
    expect(result.error).not.toContain('GENERATION_')
    expect(mocks.generate).not.toHaveBeenCalled()
  })
})

describe('connection test timeout', () => {
  const retrievalModel: ModelProfile = { ...deepSeekModel, id: 'bge', modelName: 'bge-m3', baseUrl: 'https://embedding.example/v1', purposes: ['embedding'] }
  const hangUntilAborted = (signal: AbortSignal | undefined) => new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each([
    ['en-US', 'did not finish within 30 seconds', /\p{Script=Han}|LLM_|AbortError/u],
    ['zh-CN', '连接测试 30 秒内没有完成', /LLM_|AbortError/u],
  ])('cancels a hanging generation probe after 30 seconds and explains it in %s', async (locale, expected, forbidden) => {
    mocks.locale = locale
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let signal: AbortSignal | undefined
    mocks.generate.mockImplementationOnce(async (_model: ModelProfile, _messages: unknown, options: { signal?: AbortSignal }) => {
      signal = options.signal
      try {
        return await hangUntilAborted(options.signal)
      } catch (error) {
        return { success: false, content: '', finishReason: 'error', error: String(error) }
      }
    })
    const pending = connectionHandler()({}, deepSeekModel) as Promise<{ success: boolean; error: string }>
    await vi.advanceTimersByTimeAsync(29_999)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    const result = await pending
    expect(signal?.aborted).toBe(true)
    expect(result.success).toBe(false)
    expect(result.error).toContain(expected)
    expect(result.error).not.toMatch(forbidden)
  })

  it.each([
    ['localhost', { baseUrl: 'http://localhost:1234/v1' }],
    ['127.0.0.1', { baseUrl: 'http://127.0.0.1:8080/v1' }],
    ['[::1]', { baseUrl: 'http://[::1]:11434/v1' }],
    ['the Ollama provider', { provider: 'ollama', baseUrl: 'http://gpu-box.lan:11434/v1' }],
  ] as const)('gives %s 120 seconds before cancelling the probe', async (_label, endpoint) => {
    mocks.locale = 'zh-CN'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let signal: AbortSignal | undefined
    mocks.generate.mockImplementationOnce(async (_model: ModelProfile, _messages: unknown, options: { signal?: AbortSignal }) => {
      signal = options.signal
      return hangUntilAborted(options.signal).catch(error => ({ success: false, content: '', finishReason: 'error', error: String(error) }))
    })
    const pending = connectionHandler()({}, { ...deepSeekModel, ...endpoint }) as Promise<{ success: boolean; error: string }>
    await vi.advanceTimersByTimeAsync(119_999)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    const result = await pending
    expect(signal?.aborted).toBe(true)
    expect(result).toEqual({ success: false, error: '连接测试 120 秒内没有完成，已停止等待。请检查网络或代理设置后重试。' })
  })

  it('cancels a hanging retrieval probe request after 30 seconds', async () => {
    mocks.locale = 'en-US'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined
      return hangUntilAborted(requestSignal)
    }))
    const pending = connectionHandler()({}, retrievalModel) as Promise<{ success: boolean; error: string }>
    await vi.advanceTimersByTimeAsync(30_000)

    const result = await pending
    expect(requestSignal?.aborted).toBe(true)
    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('did not finish within 30 seconds')
  })

})

describe('generation model connection test with an empty error body', () => {
  it('ends the explanation without a dangling service response', async () => {
    mocks.locale = 'en-US'
    mocks.generate.mockResolvedValueOnce({
      success: false, content: '', finishReason: 'error', error: 'LLM_REQUEST_FAILED', httpFailure: { status: 403, body: '' },
    })
    await expect(connectionHandler()({}, deepSeekModel)).resolves.toEqual({
      success: false,
      error: 'Model request failed (HTTP 403). Check the Base URL, API key, and model name.',
    })
  })
})
