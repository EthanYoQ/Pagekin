import { beforeAll, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  discovery: { success: false, errorCode: 'invalid_response' } as unknown,
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) }) },
}))

vi.mock('../../utils/config-utils', () => ({
  MODELS_CONFIG_PATH: 'models.json',
  GLOBAL_CONFIG_PATH: 'config.json',
  DEFAULT_GLOBAL_CONFIG: {},
  readJsonFile: vi.fn((_path: string, fallback: unknown) => fallback),
  tryReadJsonFile: vi.fn(() => ({ status: 'missing' })),
  writeJsonFile: vi.fn(),
}))

// 代理一直连不上；只有请求真的经这条代理发出（拿到了 activeProxy）才能归咎代理。
const route = vi.hoisted(() => ({ id: 'proxy' }))
vi.mock('../../network-proxy', () => ({
  activeProxy: vi.fn(() => route),
  proxyUnreachable: vi.fn(async (_target: string, sentThrough: unknown) => sentThrough === route),
}))

vi.mock('../../rerank', () => ({ rankPassages: vi.fn(async () => ({ ranking: { method: 'fallback', reason: 'request-failed' } })) }))

vi.mock('../../services/model-discovery-service', () => ({
  ModelDiscoveryService: class { async discoverModels() { return mocks.discovery } },
}))

import { registerLLMController } from '../llm-controller'

const discover = () => mocks.handlers.get('llm:discover-models')!({}, {
  provider: 'custom', protocol: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'key', purposes: ['generation'],
})

describe('代理连不上时拉模型列表', () => {
  beforeAll(() => { registerLLMController() })

  it('服务返回了无法识别的列表：照原样报，不归咎代理', async () => {
    mocks.discovery = { success: false, errorCode: 'invalid_response' }
    await expect(discover()).resolves.toEqual({ success: false, errorCode: 'invalid_response' })
  })

  it('网络失败：说明是代理连不上', async () => {
    mocks.discovery = { success: false, errorCode: 'network' }
    await expect(discover()).resolves.toEqual({ success: false, errorCode: 'proxy' })
  })
})

describe('代理连不上时测试连接', () => {
  beforeAll(() => { if (!mocks.handlers.size) registerLLMController() })

  it('Anthropic 协议的检索模型没发请求就失败：照原样说明协议，不归咎代理', async () => {
    const result = await mocks.handlers.get('llm:test-connection')!({}, {
      id: 'embed', name: 'embed', provider: 'custom', protocol: 'anthropic', modelName: 'm', apiKey: 'key',
      baseUrl: 'https://api.example.com/v1', temperature: 0.7, maxTokens: 256, purposes: ['embedding'],
    }) as { error: string }
    expect(result.error).toContain('Anthropic')
  })
})

describe('代理连不上时，发请求前就被拒的设置', () => {
  beforeAll(() => { if (!mocks.handlers.size) registerLLMController() })

  it('Kimi 官方接口温度超范围：照原样说明温度，不归咎代理', async () => {
    const result = await mocks.handlers.get('llm:test-connection')!({}, {
      id: 'kimi', name: 'kimi', provider: 'moonshot', protocol: 'openai', modelName: 'moonshot-v1-8k', apiKey: 'key',
      baseUrl: 'https://api.moonshot.cn/v1', temperature: 1.5, maxTokens: 256, purposes: ['generation'],
    }) as { error: string }
    expect(result.error).not.toContain('网络代理')
  })
})

describe('代理连不上时测试同时能检索和重排的档案', () => {
  beforeAll(() => { if (!mocks.handlers.size) registerLLMController() })
  it('Anthropic 档案先真发了重排请求：说明是代理连不上', async () => {
    const result = await mocks.handlers.get('llm:test-connection')!({}, {
      id: 'both', name: 'both', provider: 'custom', protocol: 'anthropic', modelName: 'm', apiKey: 'key',
      baseUrl: 'https://api.example.com/v1', temperature: 0.7, maxTokens: 256, purposes: ['embedding', 'rerank'],
    }) as { error: string }
    expect(result.error).toContain('网络代理')
  })
})
