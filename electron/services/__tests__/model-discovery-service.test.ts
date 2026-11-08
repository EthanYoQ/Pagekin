import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { ModelDiscoveryService } from '../model-discovery-service'
import { applyModelProfileSelection, resolveContextWindow } from '../../../src/shared/model-profile-draft'
import { resolveGenerationParameters } from '../../llm/generation-parameter-policy'
import { OpenAIProvider } from '../../llm/openai-provider'

const servers: Server[] = []

function profile(overrides: Partial<ModelProfile>): ModelProfile {
  return {
    id: 'saved-openai',
    name: 'Saved OpenAI-compatible profile',
    provider: 'custom',
    protocol: 'openai',
    modelName: 'manual-model',
    apiKey: crypto.randomUUID(),
    baseUrl: '',
    temperature: 0.7,
    maxTokens: 4096,
    purposes: ['generation'],
    ...overrides,
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  servers.push(server)
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })))
  vi.restoreAllMocks()
})

describe('ModelDiscoveryService', () => {
  it.each([
    ['gemini', 'https://generativelanguage.googleapis.com', { models: [{ name: 'models/gemini-next', displayName: 'Next', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent'] }] }, 'gemini-next', 1_048_576],
    ['anthropic', 'https://api.anthropic.com', { data: [{ id: 'claude-next', display_name: 'Next', max_input_tokens: 200_000 }] }, 'claude-next', 200_000],
    ['openai', 'https://example.test/v1', { data: [{ id: 'gateway-next', context_window: 128_000 }] }, 'gateway-next', 128_000],
  ] as const)('选中 %s 协议声明了窗口的模型后写入档案，来源记服务商', async (protocol, baseUrl, payload, value, window) => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => payload })
    const result = await new ModelDiscoveryService({ fetchImpl }).discoverModels(profile({ protocol, baseUrl }))
    if (!result.success) throw new Error('Expected discovered models')
    const candidate = result.models.find(model => model.value === value)!
    const selected = applyModelProfileSelection(profile({ protocol, baseUrl }), { modelName: value }, candidate.capabilities)
    expect(selected.capabilities?.contextWindowTokens).toBe(window)
    expect(resolveContextWindow(selected)).toEqual({ tokens: window, source: 'endpoint' })
  })

  it('Gemini 的输出上限不随窗口写入档案', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: 'models/gemini-next', displayName: 'Next', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent'] }] }) })
    const result = await new ModelDiscoveryService({ fetchImpl }).discoverModels(profile({ protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' }))
    if (!result.success) throw new Error('Expected discovered models')
    expect(result.models[0].capabilities).toEqual({ contextWindowTokens: 1_048_576 })
  })

  it('没有窗口字段的列表（硅基流动样本）不写窗口，模型照常可选', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'vendor/unlisted', object: 'model', created: 0, owned_by: 'vendor' }] }) })
    const baseUrl = 'https://api.siliconflow.cn/v1'
    const result = await new ModelDiscoveryService({ fetchImpl }).discoverModels(profile({ baseUrl }))
    if (!result.success) throw new Error('Expected discovered models')
    const selected = applyModelProfileSelection(profile({ baseUrl }), { modelName: 'vendor/unlisted' }, result.models[0].capabilities)
    expect(resolveContextWindow(selected)).toEqual({ tokens: 32_768, source: 'default' })
  })

  describe('本机服务的运行窗口', () => {
    const ollama = (overrides: Partial<ModelProfile> = {}) => profile({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', modelName: 'qwen2.5', ...overrides })
    const lmStudio = (overrides: Partial<ModelProfile> = {}) => profile({ baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', modelName: 'gemma-3', ...overrides })
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
    const routed = (routes: Record<string, unknown>) => vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>(async url => {
      const path = new URL(url).pathname
      return path in routes ? json(routes[path]) : { ok: false, status: 404, json: async () => ({}) }
    })
    const service = (fetchImpl: unknown) => new ModelDiscoveryService({ fetchImpl: fetchImpl as typeof fetch })

    it('Ollama 取 /api/ps 的运行值，不再问 /api/show', async () => {
      const fetchImpl = routed({ '/api/ps': { models: [{ name: 'qwen2.5:latest', model: 'qwen2.5:latest', context_length: 8_192 }] } })
      await expect(service(fetchImpl).discoverLocalContextWindow(ollama())).resolves.toBe(8_192)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('Ollama 没加载时看 /api/show 的 num_ctx，不把模型架构上限当窗口', async () => {
      const fetchImpl = routed({ '/api/ps': { models: [] }, '/api/show': { parameters: 'stop "<|im_end|>"\nnum_ctx                        16384', model_info: { 'qwen2.context_length': 131_072 } } })
      await expect(service(fetchImpl).discoverLocalContextWindow(ollama())).resolves.toBe(16_384)
    })

    it('Ollama 只有架构上限时返回空，档案按 4,096 写稿', async () => {
      const fetchImpl = routed({ '/api/ps': { models: [] }, '/api/show': { model_info: { 'qwen2.context_length': 131_072 } } })
      await expect(service(fetchImpl).discoverLocalContextWindow(ollama())).resolves.toBeNull()
      expect(resolveContextWindow(applyModelProfileSelection(ollama({ modelName: '' }), { modelName: 'qwen2.5' }))).toEqual({ tokens: 4_096, source: 'default' })
    })

    it('LM Studio 取已加载实例的运行值，未加载不写窗口', async () => {
      const loaded = routed({ '/api/v1/models': { models: [{ key: 'gemma-3', max_context_length: 262_144, loaded_instances: [{ id: 'gemma-3', config: { context_length: 4_096 } }] }] } })
      await expect(service(loaded).discoverLocalContextWindow(lmStudio())).resolves.toBe(4_096)
      const unloaded = routed({ '/api/v1/models': { models: [{ key: 'gemma-3', max_context_length: 262_144, loaded_instances: [] }] } })
      await expect(service(unloaded).discoverLocalContextWindow(lmStudio())).resolves.toBeNull()
    })

    it.each([
      ['超时', async () => { throw new DOMException('aborted', 'AbortError') }],
      ['401', async () => ({ ok: false, status: 401, json: async () => ({}) })],
      ['格式不对', async () => json('not-an-object')],
      ['JSON 坏了', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad') } })],
    ])('%s 时静默返回空', async (_name, fetchImpl) => {
      await expect(service(fetchImpl).discoverLocalContextWindow(ollama())).resolves.toBeNull()
      await expect(service(fetchImpl).discoverLocalContextWindow(lmStudio())).resolves.toBeNull()
    })

    it.each([
      ['Ollama', () => ollama({ baseUrl: 'http://gpu-box.lan:11434/proxy/v1', apiKey: 'local-secret' }), 'http://gpu-box.lan:11434/proxy/api/ps'],
      ['LM Studio', () => lmStudio({ apiKey: 'local-secret' }), 'http://127.0.0.1:1234/api/v1/models'],
    ] as const)('%s 的凭据只发往档案自己的地址，且不跟随重定向', async (_name, build, firstUrl) => {
      const fetchImpl = routed({ '/proxy/api/ps': { models: [] }, '/proxy/api/show': {} })
      const model = build()
      await service(fetchImpl).discoverLocalContextWindow(model)
      expect(fetchImpl.mock.calls[0][0]).toBe(firstUrl)
      for (const [url, init] of fetchImpl.mock.calls) {
        expect(new URL(url).origin).toBe(new URL(model.baseUrl).origin)
        expect(init?.redirect).toBe('error')
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer local-secret')
      }
    })

    it('云端服务商和非 OpenAI 协议的档案不发请求', async () => {
      const fetchImpl = routed({})
      await expect(service(fetchImpl).discoverLocalContextWindow(profile({ baseUrl: 'https://example.test/v1' }))).resolves.toBeNull()
      await expect(service(fetchImpl).discoverLocalContextWindow(lmStudio({ protocol: 'anthropic' }))).resolves.toBeNull()
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  })

  it('keeps explicit capacity fields but does not infer context from max_tokens', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [
      { id: 'new-model', context_length: 64000, max_output_tokens: 12000, capabilities: { reasoning: true } },
      { id: 'ambiguous-model', max_tokens: 999999 },
    ] }) })
    const result = await new ModelDiscoveryService({ fetchImpl }).discoverModels(profile({ baseUrl: 'https://example.test/v1' }))
    expect(result).toMatchObject({ success: true, models: [
      { value: 'new-model', capabilities: { contextWindowTokens: 64000, maxOutputTokens: 12000, reasoning: true } },
      { value: 'ambiguous-model' },
    ] })
    if (!result.success) throw new Error('Expected discovered models')
    expect(result.models[1]).not.toHaveProperty('capabilities')
    const selected = applyModelProfileSelection(profile({ baseUrl: 'https://example.test/v1', maxTokens: 16000 }),
      { modelName: result.models[0].value }, result.models[0].capabilities)
    const post = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) })
    vi.stubGlobal('fetch', post)
    await new OpenAIProvider().generate(selected, [], resolveGenerationParameters(selected, {}))
    const body = JSON.parse(post.mock.calls[0][1].body)
    expect(body.max_tokens).toBe(12000)
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('enable_thinking')
  })
  it('discovers OpenAI-compatible models from the current form without leaking its credential', async () => {
    const credential = crypto.randomUUID()
    let requestUrl = ''
    let authorization = ''
    const baseUrl = await listen(createServer((request, response) => {
      requestUrl = request.url ?? ''
      authorization = String(request.headers.authorization ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        data: [
          { id: 'gateway/model-a' },
          { id: 'gateway/model-b', name: 'Model B' },
        ],
      }))
    }))
    const saved = profile({ apiKey: credential, baseUrl: `${baseUrl}/v1` })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await new ModelDiscoveryService().discoverModels(saved)

    expect(requestUrl).toBe('/v1/models')
    expect(requestUrl).not.toContain(credential)
    expect(authorization).toBe(`Bearer ${credential}`)
    expect(result).toEqual({
      success: true,
      models: [
        { id: 'gateway/model-a', name: 'gateway/model-a', value: 'gateway/model-a' },
        { id: 'gateway/model-b', name: 'Model B', value: 'gateway/model-b' },
      ],
    })
    expect(JSON.stringify(result)).not.toContain(credential)
    expect(JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls])).not.toContain(credential)
  })

  it('uses the current Gemini form and keeps its credential in the request header', async () => {
    const credential = crypto.randomUUID()
    let requestUrl = ''
    let googleApiKey = ''
    let authorization = ''
    const baseUrl = await listen(createServer((request, response) => {
      requestUrl = request.url ?? ''
      googleApiKey = String(request.headers['x-goog-api-key'] ?? '')
      authorization = String(request.headers.authorization ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        models: [
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
          { name: 'models/text-embedding-004' },
        ],
      }))
    }))
    const saved = profile({
      id: 'saved-gemini',
      provider: 'gemini',
      protocol: 'gemini',
      apiKey: credential,
      baseUrl,
    })

    const result = await new ModelDiscoveryService().discoverModels(saved)

    expect(requestUrl).toBe('/v1beta/models')
    expect(requestUrl).not.toContain(credential)
    expect(googleApiKey).toBe(credential)
    expect(authorization).toBe('')
    expect(result).toEqual({
      success: true,
      models: [
        {
          id: 'models/gemini-2.5-flash',
          name: 'Gemini 2.5 Flash',
          value: 'gemini-2.5-flash',
        },
        {
          id: 'models/text-embedding-004',
          name: 'models/text-embedding-004',
          value: 'text-embedding-004',
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain(credential)
  })

  it.each([
    { protocol: 'openai' as const, provider: 'custom' as const },
    { protocol: 'gemini' as const, provider: 'gemini' as const },
  ])('refuses a cross-origin $protocol redirect without sending a second request', async ({ protocol, provider }) => {
    const credential = crypto.randomUUID()
    let redirectedRequests = 0
    let redirectedRequest = ''
    const targetBaseUrl = await listen(createServer((request, response) => {
      redirectedRequests += 1
      redirectedRequest = JSON.stringify({ url: request.url, headers: request.headers })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(protocol === 'gemini' ? { models: [] } : { data: [] }))
    }))
    const sourceBaseUrl = await listen(createServer((_request, response) => {
      response.writeHead(302, { location: `${targetBaseUrl}/redirect-target` })
      response.end()
    }))
    const saved = profile({
      id: `redirect-${protocol}`,
      provider,
      protocol,
      apiKey: credential,
      baseUrl: sourceBaseUrl,
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await new ModelDiscoveryService().discoverModels(saved)

    expect(result).toEqual({ success: false, errorCode: 'network' })
    expect(redirectedRequests).toBe(0)
    const observableOutput = JSON.stringify({
      result,
      redirectedRequest,
      logs: [log.mock.calls, warn.mock.calls, error.mock.calls],
    })
    expect(observableOutput).not.toContain(credential)
    expect(observableOutput).not.toContain(sourceBaseUrl)
    expect(observableOutput).not.toContain(targetBaseUrl)
  })

  it.each([
    { phase: 'fetch', protocol: 'openai' as const, provider: 'custom' as const },
    { phase: 'body', protocol: 'openai' as const, provider: 'custom' as const },
    { phase: 'fetch', protocol: 'gemini' as const, provider: 'gemini' as const },
    { phase: 'body', protocol: 'gemini' as const, provider: 'gemini' as const },
  ])('times out a stalled $protocol $phase without exposing provider details', async ({ phase, protocol, provider }) => {
    const credential = crypto.randomUUID()
    const providerDetail = `provider-detail-${credential}`
    const baseUrl = 'https://provider.invalid/private-models'
    const saved = profile({
      id: `timeout-${protocol}-${phase}`,
      provider,
      protocol,
      apiKey: credential,
      baseUrl,
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const waitForAbortOrFallback = (signal: AbortSignal | null) => new Promise<void>((resolve, reject) => {
      const fallback = setTimeout(resolve, 100)
      signal?.addEventListener('abort', () => {
        clearTimeout(fallback)
        reject(new Error(providerDetail))
      }, { once: true })
    })
    const payload = protocol === 'gemini'
      ? { models: [{ name: 'models/safe-model' }] }
      : { data: [{ id: 'safe-model' }] }
    const fetchImpl: typeof fetch = async (_input, init) => {
      const signal = init?.signal ?? null
      if (phase === 'fetch') await waitForAbortOrFallback(signal)
      return {
        ok: true,
        status: 200,
        json: async () => {
          if (phase === 'body') await waitForAbortOrFallback(signal)
          return payload
        },
      } as Response
    }

    const result = await new ModelDiscoveryService({
      fetchImpl,
      timeoutMs: 25,
    }).discoverModels(saved)

    expect(result).toEqual({ success: false, errorCode: 'network' })
    const observableOutput = JSON.stringify({
      result,
      logs: [log.mock.calls, warn.mock.calls, error.mock.calls],
    })
    expect(observableOutput).not.toContain(credential)
    expect(observableOutput).not.toContain(providerDetail)
    expect(observableOutput).not.toContain(baseUrl)
  })

  it.each([
    { protocol: 'openai' as const, provider: 'custom' as const },
    { protocol: 'gemini' as const, provider: 'gemini' as const },
  ])('returns auth without echoing $protocol provider details', async ({ protocol, provider }) => {
    const credential = crypto.randomUUID()
    const providerDetail = `denied-${credential}`
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: providerDetail }))
    }))
    const saved = profile({
      id: `auth-${protocol}`,
      provider,
      protocol,
      apiKey: credential,
      baseUrl,
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await new ModelDiscoveryService().discoverModels(saved)

    expect(result).toEqual({ success: false, errorCode: 'auth' })
    const observableOutput = JSON.stringify({
      result,
      logs: [log.mock.calls, warn.mock.calls, error.mock.calls],
    })
    expect(observableOutput).not.toContain(credential)
    expect(observableOutput).not.toContain(providerDetail)
    expect(observableOutput).not.toContain(baseUrl)
  })

  it.each([
    { protocol: 'openai' as const, provider: 'custom' as const },
    { protocol: 'gemini' as const, provider: 'gemini' as const },
  ])('classifies a malformed $protocol success response as invalid_response', async ({ protocol, provider }) => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{not valid json')
    }))
    const saved = profile({
      id: `invalid-${protocol}`,
      provider,
      protocol,
      baseUrl,
    })

    await expect(new ModelDiscoveryService().discoverModels(saved))
      .resolves.toEqual({ success: false, errorCode: 'invalid_response' })
  })

  it.each([
    { protocol: 'openai' as const, provider: 'custom' as const, status: 404 },
    { protocol: 'openai' as const, provider: 'custom' as const, status: 405 },
    { protocol: 'gemini' as const, provider: 'gemini' as const, status: 404 },
    { protocol: 'gemini' as const, provider: 'gemini' as const, status: 405 },
  ])('classifies $protocol HTTP $status as unsupported', async ({ protocol, provider, status }) => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(status, { 'content-type': 'text/plain' })
      response.end('provider-specific route detail')
    }))
    const saved = profile({ id: `unsupported-${protocol}-${status}`, provider, protocol, baseUrl })

    await expect(new ModelDiscoveryService().discoverModels(saved))
      .resolves.toEqual({ success: false, errorCode: 'unsupported' })
  })

  it.each([
    {
      protocol: 'openai' as const,
      provider: 'custom' as const,
      payload: { data: [] },
    },
    {
      protocol: 'gemini' as const,
      provider: 'gemini' as const,
      payload: { models: [] },
    },
  ])('reports an empty $protocol model list without inventing entries', async ({ protocol, provider, payload }) => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }))
    const saved = profile({ id: `empty-${protocol}`, provider, protocol, baseUrl })

    await expect(new ModelDiscoveryService().discoverModels(saved))
      .resolves.toEqual({ success: false, errorCode: 'no_models' })
  })

  it('tells a list with no model for this purpose apart from an empty list', async () => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ models: [
        { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] },
      ] }))
    }))
    const saved = profile({ id: 'unsuitable-gemini', provider: 'gemini', protocol: 'gemini', baseUrl, purposes: ['generation'] })

    await expect(new ModelDiscoveryService().discoverModels(saved))
      .resolves.toEqual({ success: false, errorCode: 'no_suitable_models' })
  })

  it.each([
    {
      protocol: 'openai' as const,
      provider: 'custom' as const,
      payload: { data: Array.from({ length: 501 }, (_, index) => ({ id: `model-${index}` })) },
    },
    {
      protocol: 'gemini' as const,
      provider: 'gemini' as const,
      payload: { models: Array.from({ length: 501 }, (_, index) => ({ name: `models/model-${index}` })) },
    },
  ])('rejects a $protocol list beyond the 500-entry IPC bound', async ({ protocol, provider, payload }) => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }))
    const saved = profile({ id: `oversized-list-${protocol}`, provider, protocol, baseUrl })

    await expect(new ModelDiscoveryService().discoverModels(saved))
      .resolves.toEqual({ success: false, errorCode: 'invalid_response' })
  })

  it.each([
    {
      label: 'OpenAI-compatible ID over 512 UTF-8 bytes',
      protocol: 'openai' as const,
      provider: 'custom' as const,
      invalidText: '模'.repeat(171),
      payload: (invalidText: string) => ({ data: [{ id: 'safe-model' }, { id: invalidText }] }),
    },
    {
      label: 'OpenAI-compatible display name with a control character',
      protocol: 'openai' as const,
      provider: 'custom' as const,
      invalidText: 'unsafe\u0000name',
      payload: (invalidText: string) => ({ data: [{ id: 'safe-model' }, { id: 'other-model', name: invalidText }] }),
    },
    {
      label: 'Gemini ID with a control character',
      protocol: 'gemini' as const,
      provider: 'gemini' as const,
      invalidText: 'models/unsafe\u0000model',
      payload: (invalidText: string) => ({ models: [{ name: 'models/safe-model' }, { name: invalidText }] }),
    },
    {
      label: 'Gemini display name over 512 UTF-8 bytes',
      protocol: 'gemini' as const,
      provider: 'gemini' as const,
      invalidText: '名'.repeat(171),
      payload: (invalidText: string) => ({ models: [{ name: 'models/safe-model' }, { name: 'models/other-model', displayName: invalidText }] }),
    },
  ])('rejects a single unsafe $label without returning any list entry', async ({ protocol, provider, invalidText, payload }) => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload(invalidText)))
    }))
    const saved = profile({ id: `unsafe-entry-${protocol}`, provider, protocol, baseUrl })

    const result = await new ModelDiscoveryService().discoverModels(saved)

    expect(result).toEqual({ success: false, errorCode: 'invalid_response' })
    expect(JSON.stringify(result)).not.toContain(invalidText)
    expect(JSON.stringify(result)).not.toContain('safe-model')
  })

  it.each([
    {
      protocol: 'openai' as const,
      provider: 'custom' as const,
      payload: {
        data: [
          { id: 'duplicate-model', name: 'First display name' },
          { id: 'duplicate-model', name: 'Second display name' },
          { id: 'other-model' },
        ],
      },
      expected: [
        { id: 'duplicate-model', name: 'First display name', value: 'duplicate-model' },
        { id: 'other-model', name: 'other-model', value: 'other-model' },
      ],
    },
    {
      protocol: 'gemini' as const,
      provider: 'gemini' as const,
      payload: {
        models: [
          { name: 'models/duplicate-model', displayName: 'First display name' },
          { name: 'duplicate-model', displayName: 'Second display name' },
          { name: 'models/other-model' },
        ],
      },
      expected: [
        { id: 'models/duplicate-model', name: 'First display name', value: 'duplicate-model' },
        { id: 'models/other-model', name: 'models/other-model', value: 'other-model' },
      ],
    },
  ])('keeps the first $protocol entry for each saved selection value', async ({ protocol, provider, payload, expected }) => {
    const baseUrl = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }))
    const saved = profile({ id: `deduplicate-${protocol}`, provider, protocol, baseUrl })

    await expect(new ModelDiscoveryService().discoverModels(saved))
      .resolves.toEqual({ success: true, models: expected })
  })

  it('reduces a fetch failure to network without returning the URL, credential, or provider error', async () => {
    const credential = crypto.randomUUID()
    const baseUrl = 'https://provider.invalid/private-path'
    const providerError = `request to ${baseUrl} failed with ${credential}`
    const saved = profile({ apiKey: credential, baseUrl })
    const fetchImpl: typeof fetch = async () => {
      throw new Error(providerError)
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await new ModelDiscoveryService({ fetchImpl }).discoverModels(saved)

    expect(result).toEqual({ success: false, errorCode: 'network' })
    const observableOutput = JSON.stringify({
      result,
      logs: [log.mock.calls, warn.mock.calls, error.mock.calls],
    })
    expect(observableOutput).not.toContain(baseUrl)
    expect(observableOutput).not.toContain(credential)
    expect(observableOutput).not.toContain(providerError)
  })

  describe('按用途筛选端点返回的模型', () => {
    // 节选自 2026-10-24 真实 Gemini models 接口：TTS、图像、转写、音乐与实时模型同样声明 generateContent。
    const geminiCatalog = {
      models: [
        { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/nano-banana-pro-preview', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-transcribe', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/lyria-3.5', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/gemini-2.5-computer-use-preview-10-2025', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/deep-research-preview-04-2026', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/antigravity-preview-latest', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-robotics-er-2-preview', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.1-pro-preview-customtools', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-native-audio-latest', supportedGenerationMethods: ['countTokens', 'bidiGenerateContent'] },
        { name: 'models/gemini-3.8-live', supportedGenerationMethods: ['bidiGenerateContent'] },
        { name: 'models/aqa', supportedGenerationMethods: ['generateAnswer'] },
        { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent', 'countTokens'] },
        { name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent', 'countTokens'] },
        { name: 'models/gateway-without-methods' },
      ],
    }
    const geminiFetch = () => vi.fn().mockResolvedValue({ ok: true, json: async () => geminiCatalog })
    const values = (result: Awaited<ReturnType<ModelDiscoveryService['discoverModels']>>) =>
      result.success ? result.models.map(model => model.value) : result

    it('生成用途只留下能写作的 generateContent 模型', async () => {
      const result = await new ModelDiscoveryService({ fetchImpl: geminiFetch() }).discoverModels(profile({
        provider: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', purposes: ['generation'],
      }))
      expect(values(result)).toEqual(['gemini-3.8-flash', 'gemini-3.1-pro-preview-customtools', 'gateway-without-methods'])
    })

    it('向量用途只留下 embedContent 模型', async () => {
      const result = await new ModelDiscoveryService({ fetchImpl: geminiFetch() }).discoverModels(profile({
        provider: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', purposes: ['embedding'],
      }))
      expect(values(result)).toEqual(['gemini-embedding-001', 'gemini-embedding-2', 'gateway-without-methods'])
    })

    it('OpenAI 兼容端点的向量用途把向量模型排在对话模型前面', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [
        { id: 'Qwen/Qwen3.8-27B' }, { id: 'BAAI/bge-m3' }, { id: 'deepseek-v4-flash' }, { id: 'Qwen/Qwen3-Embedding-8B' },
      ] }) })
      const service = new ModelDiscoveryService({ fetchImpl })
      const embedding = await service.discoverModels(profile({ baseUrl: 'https://example.test/v1', purposes: ['embedding'] }))
      expect(values(embedding)).toEqual(['BAAI/bge-m3', 'Qwen/Qwen3-Embedding-8B', 'Qwen/Qwen3.8-27B', 'deepseek-v4-flash'])
      const generation = await service.discoverModels(profile({ baseUrl: 'https://example.test/v1', purposes: ['generation'] }))
      expect(values(generation)).toEqual(['Qwen/Qwen3.8-27B', 'BAAI/bge-m3', 'deepseek-v4-flash', 'Qwen/Qwen3-Embedding-8B'])
    })

    it('Anthropic 协议拉取官方模型列表，向量用途直接判为无合适模型', async () => {
      const credential = crypto.randomUUID()
      let requestUrl = ''
      let apiKeyHeader = ''
      let versionHeader = ''
      const baseUrl = await listen(createServer((request, response) => {
        requestUrl = request.url ?? ''
        apiKeyHeader = String(request.headers['x-api-key'] ?? '')
        versionHeader = String(request.headers['anthropic-version'] ?? '')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          data: [
            { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
            { id: 'glm-4.6' },
          ],
          has_more: false,
        }))
      }))
      const anthropic = profile({
        provider: 'bigmodel-anthropic', protocol: 'anthropic',
        apiKey: credential, baseUrl: `${baseUrl}/api/anthropic`,
      })

      const generation = await new ModelDiscoveryService().discoverModels(anthropic)
      expect(requestUrl).toBe('/api/anthropic/v1/models?limit=1000')
      expect(requestUrl).not.toContain(credential)
      expect(apiKeyHeader).toBe(credential)
      expect(versionHeader).toBe('2023-06-01')
      expect(values(generation)).toEqual(['claude-opus-4-6', 'glm-4.6'])
      if (!generation.success) throw new Error('Expected discovered models')
      expect(generation.models[0].name).toBe('Claude Opus 4.6')

      const embedding = await new ModelDiscoveryService().discoverModels(
        profile({ provider: 'bigmodel-anthropic', protocol: 'anthropic', apiKey: credential, baseUrl: `${baseUrl}/api/anthropic`, purposes: ['embedding'] }))
      expect(embedding).toEqual({ success: false, errorCode: 'no_suitable_models' })
    })

    it('Anthropic 协议的网关只认 Bearer 时，模型列表与生成用同一套鉴权', async () => {
      const credential = crypto.randomUUID()
      const baseUrl = await listen(createServer((request, response) => {
        if (request.headers.authorization !== `Bearer ${credential}`) {
          response.writeHead(401).end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'glm-5' }], has_more: false }))
      }))

      const result = await new ModelDiscoveryService().discoverModels(profile({
        provider: 'bigmodel-anthropic', protocol: 'anthropic', apiKey: credential, baseUrl,
      }))
      expect(values(result)).toEqual(['glm-5'])
    })
  })

  it('refuses an endpoint that would place the saved credential in the request URL', async () => {
    const credential = crypto.randomUUID()
    let requestCount = 0
    const baseUrl = await listen(createServer((_request, response) => {
      requestCount += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'must-not-be-returned' }] }))
    }))
    const saved = profile({
      apiKey: credential,
      baseUrl: `${baseUrl}/v1/${encodeURIComponent(credential)}`,
    })

    const result = await new ModelDiscoveryService().discoverModels(saved)

    expect(result).toEqual({ success: false, errorCode: 'invalid_response' })
    expect(requestCount).toBe(0)
    expect(JSON.stringify(result)).not.toContain(credential)
  })
})
