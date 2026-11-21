import net from 'node:net'

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { refused } from '../../__tests__/proxy-failure-fixture'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({ handlers: new Map<string, IpcHandler>() }))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) }) },
}))

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import('node:http') }>()
  const { setGlobalProxyFromEnv } = await import('../../__tests__/proxy-failure-fixture')
  return { ...actual, default: { ...actual.default, setGlobalProxyFromEnv } }
})

vi.mock('../../utils/config-utils', () => ({
  MODELS_CONFIG_PATH: 'models.json',
  GLOBAL_CONFIG_PATH: 'config.json',
  DEFAULT_GLOBAL_CONFIG: {},
  readJsonFile: vi.fn((_path: string, fallback: unknown) => fallback),
  tryReadJsonFile: vi.fn(() => ({ status: 'missing' })),
  writeJsonFile: vi.fn(),
}))

import { applyNetworkProxy } from '../../network-proxy'
import { registerLLMController } from '../llm-controller'

const PROXY_DOWN = '连不上「网络代理」里设置的代理'

async function closedPort() {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise(resolve => server.close(resolve))
  return port
}

let proxyPort = 0
const fetchMock = vi.fn<typeof fetch>()

const profile = (overrides: Record<string, unknown>) => ({
  id: 'm', name: 'm', provider: 'custom', protocol: 'openai', modelName: 'm', apiKey: 'key',
  baseUrl: 'https://api.example.com/v1', temperature: 0.7, maxTokens: 256, purposes: ['generation'], ...overrides,
})
const testConnection = async (overrides: Record<string, unknown> = {}) =>
  (await mocks.handlers.get('llm:test-connection')!({}, profile(overrides)) as { success: boolean; error?: string })
const discover = () => mocks.handlers.get('llm:discover-models')!({}, {
  provider: 'custom', protocol: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'key', purposes: ['generation'],
})

beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock)
  registerLLMController()
})

// 代理端口真的没人听：旧做法的连通探测会说「代理连不上」，所以这些用例能分辨是看失败本身还是看代理此刻通不通。
beforeEach(async () => {
  proxyPort = await closedPort()
  applyNetworkProxy({ enabled: true, type: 'http', host: '127.0.0.1', port: proxyPort })
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => { throw refused('127.0.0.1', proxyPort) })
})

describe('请求连不上代理：说明是代理', () => {
  it('测试生成模型', async () => {
    expect((await testConnection()).error).toMatch(new RegExp(`^${PROXY_DOWN}`))
  })

  it('测试检索模型', async () => {
    expect((await testConnection({ purposes: ['embedding'] })).error).toMatch(new RegExp(`^${PROXY_DOWN}`))
  })

  it('测试重排模型', async () => {
    expect((await testConnection({ purposes: ['rerank'] })).error).toMatch(new RegExp(`^${PROXY_DOWN}`))
  })

  it('Anthropic 档案同时能检索和重排，先测重排', async () => {
    expect((await testConnection({ protocol: 'anthropic', purposes: ['embedding', 'rerank'] })).error).toMatch(new RegExp(`^${PROXY_DOWN}`))
  })

  it('拉模型列表', async () => {
    await expect(discover()).resolves.toEqual({ success: false, errorCode: 'proxy' })
  })
})

describe('代理也连不上，但这次失败另有原因：照原样说明', () => {
  it('Base URL 格式不对，没发请求', async () => {
    const result = await testConnection({ baseUrl: 'api.example.com/v1' })
    expect(result.success).toBe(false)
    expect(result.error).not.toContain('网络代理')
  })

  it('服务回了 HTTP 401', async () => {
    fetchMock.mockImplementation(async () => new Response('{"error":"bad key"}', { status: 401 }))
    expect((await testConnection()).error).toContain('HTTP 401')
  })

  it('请求经代理 A 失败，此时作者已换成代理 B', async () => {
    const proxyA = proxyPort
    fetchMock.mockImplementation(async () => {
      applyNetworkProxy({ enabled: true, type: 'http', host: '127.0.0.1', port: await closedPort() })
      throw refused('127.0.0.1', proxyA)
    })
    expect((await testConnection()).error).not.toContain('网络代理')
  })

  it('拉模型列表时服务回 503', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 503 }))
    await expect(discover()).resolves.toEqual({ success: false, errorCode: 'network' })
  })

  it('Anthropic 协议的检索模型没发请求', async () => {
    expect((await testConnection({ protocol: 'anthropic', purposes: ['embedding'] })).error).toContain('Anthropic')
  })

  it('Kimi 官方接口温度超范围，没发请求', async () => {
    expect((await testConnection({ modelName: 'moonshot-v1-8k', baseUrl: 'https://api.moonshot.cn/v1', temperature: 1.5 })).error)
      .toContain('温度必须在 0 到 1 之间')
  })
})
