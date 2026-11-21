import { beforeEach, describe, expect, it, vi } from 'vitest'

import { dispatcher, hostNotFound, refused, refusedLocalhost, tunnelRefused } from './proxy-failure-fixture'

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import('node:http') }>()
  const { setGlobalProxyFromEnv } = await import('./proxy-failure-fixture')
  return { ...actual, default: { ...actual.default, setGlobalProxyFromEnv } }
})
vi.mock('../utils/config-utils', () => ({ GLOBAL_CONFIG_PATH: 'config.json', DEFAULT_GLOBAL_CONFIG: {}, readJsonFile: vi.fn() }))

import { applyNetworkProxy, failedAtProxy } from '../network-proxy'

const proxy = (host: string, port = 7890) => ({ enabled: true, type: 'http' as const, host, port })

beforeEach(() => { applyNetworkProxy({ enabled: false, type: 'http', host: '', port: 0 }) })

describe('这次请求是不是连不上代理', () => {
  it('连向代理的端口被拒：是', () => {
    applyNetworkProxy(proxy('127.0.0.1'))
    expect(failedAtProxy(refused('127.0.0.1', 7890))).toBe(true)
  })

  it('代理写成 localhost，两个回环地址都被拒：是', () => {
    applyNetworkProxy(proxy('localhost'))
    expect(failedAtProxy(refusedLocalhost(7890))).toBe(true)
  })

  it('代理主机名解析不出：是', () => {
    applyNetworkProxy(proxy('badproxyhost'))
    expect(failedAtProxy(hostNotFound('badproxyhost'))).toBe(true)
  })

  it('解析不出的是别的主机名：不是', () => {
    applyNetworkProxy(proxy('badproxyhost'))
    expect(failedAtProxy(hostNotFound('api.example.com'))).toBe(false)
  })

  it('没开代理：不是', () => {
    expect(failedAtProxy(refused('127.0.0.1', 7890))).toBe(false)
  })

  it('本机模型直连被拒（端口不是代理的）：不是', () => {
    applyNetworkProxy(proxy('127.0.0.1'))
    expect(failedAtProxy(refused('127.0.0.1', 11434))).toBe(false)
  })

  it('代理在，回 502 说目标不通：不是', () => {
    applyNetworkProxy(proxy('127.0.0.1'))
    expect(failedAtProxy(tunnelRefused())).toBe(false)
  })

  it('请求经代理 A 失败，判定时已换成代理 B：不归咎 B', () => {
    applyNetworkProxy(proxy('127.0.0.1', 7890))
    applyNetworkProxy(proxy('127.0.0.1', 7891))
    expect(failedAtProxy(refused('127.0.0.1', 7890))).toBe(false)
  })
})

describe('IPv6 代理地址', () => {
  for (const host of ['::1', '[::1]']) {
    it(`填 ${host}：装上 http://[::1]:7890，连不上时认得出`, () => {
      applyNetworkProxy(proxy(host))
      expect(dispatcher.proxy).toBe('http://[::1]:7890')
      expect(failedAtProxy(refused('::1', 7890))).toBe(true)
    })
  }
})

describe('换代理失败时保住原来的代理', () => {
  it('新地址非法：抛 NETWORK_PROXY_INVALID，原来的代理仍在用', () => {
    applyNetworkProxy(proxy('127.0.0.1', 7890))
    expect(() => applyNetworkProxy(proxy('http://127.0.0.1'))).toThrow('NETWORK_PROXY_INVALID')
    expect(dispatcher.proxy).toBe('http://127.0.0.1:7890')
  })

  it('撤销换上的代理：装回原来的', () => {
    applyNetworkProxy(proxy('127.0.0.1', 7890))
    const undo = applyNetworkProxy(proxy('127.0.0.1', 7891))
    undo()
    expect(dispatcher.proxy).toBe('http://127.0.0.1:7890')
  })
})
