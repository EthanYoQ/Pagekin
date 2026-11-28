import { afterEach, expect, it, vi } from 'vitest'

import { refused, refusedLocalhost } from '../../__tests__/proxy-failure-fixture'
import type { GenerationTransportDiagnostics } from '../../../src/shared/generation-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import('node:http') }>()
  const { setGlobalProxyFromEnv } = await import('../../__tests__/proxy-failure-fixture')
  return { ...actual, default: { ...actual.default, setGlobalProxyFromEnv } }
})
vi.mock('../../utils/config-utils', () => ({ GLOBAL_CONFIG_PATH: 'config.json', DEFAULT_GLOBAL_CONFIG: {}, readJsonFile: vi.fn() }))

import { applyNetworkProxy } from '../../network-proxy'
import { OpenAIProvider } from '../openai-provider'

const model: ModelProfile = { id: 'm', name: 'M', provider: 'custom', protocol: 'openai', modelName: 'm', apiKey: 'k',
  baseUrl: 'https://api.example.com/v1', temperature: 0.7, maxTokens: 512, purposes: ['generation'] }

async function streamFailingWith(error: unknown) {
  const snapshots: GenerationTransportDiagnostics[] = [], onError = vi.fn()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error))
  await new OpenAIProvider().generateStream(model, [], { temperature: 0, maxTokens: 512, signal: new AbortController().signal,
    visibleOnly: true, onChunk: vi.fn(), onDone: vi.fn(), onError, onDiagnostics: value => snapshots.push(value) })
  return { last: snapshots.at(-1), onError }
}

afterEach(() => {
  applyNetworkProxy({ enabled: false, type: 'http', host: '', port: 0 })
  vi.unstubAllGlobals()
})

it('#702：生成请求连不上设置的代理时，传输诊断记下代理连不上，失败仍按网络失败交出', async () => {
  applyNetworkProxy({ enabled: true, type: 'http', host: '127.0.0.1', port: 7890 })
  const { last, onError } = await streamFailingWith(refused('127.0.0.1', 7890))
  expect(last).toMatchObject({ phase: 'request', endReason: 'failed', errorName: 'TypeError', errorCode: 'PROXY_UNREACHABLE', causeCode: 'ECONNREFUSED' })
  expect(onError).toHaveBeenCalledExactlyOnceWith('LLM_STREAM_NETWORK_FAILED', undefined, undefined)
})

it('#702：连不上的是模型服务而不是代理时，不记代理连不上', async () => {
  applyNetworkProxy({ enabled: true, type: 'http', host: '127.0.0.1', port: 7890 })
  const { last, onError } = await streamFailingWith(refused('127.0.0.1', 11434))
  expect(last).toMatchObject({ phase: 'request', endReason: 'failed' })
  expect(last?.errorCode).toBeUndefined()
  expect(onError).toHaveBeenCalledExactlyOnceWith('LLM_STREAM_NETWORK_FAILED', undefined, undefined)
})

it('#702：代理主机写成大写 LOCALHOST 时，连不上照样记成代理连不上', async () => {
  applyNetworkProxy({ enabled: true, type: 'http', host: 'LOCALHOST', port: 7890 })
  const { last } = await streamFailingWith(refusedLocalhost(7890))
  expect(last).toMatchObject({ phase: 'request', errorCode: 'PROXY_UNREACHABLE' })
})
