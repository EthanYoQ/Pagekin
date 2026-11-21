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

vi.mock('../../network-proxy', () => ({ proxyUnreachable: vi.fn(async () => true) }))

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
