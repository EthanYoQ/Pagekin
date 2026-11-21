import net from 'node:net'
import { describe, expect, it, vi } from 'vitest'

// Node 22 没有 setGlobalProxyFromEnv（Electron 主进程才有）；这里只验证判定逻辑。
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>()
  return { ...actual, default: { ...actual.default, setGlobalProxyFromEnv: () => () => {} } }
})
vi.mock('../utils/config-utils', () => ({ GLOBAL_CONFIG_PATH: 'config.json', DEFAULT_GLOBAL_CONFIG: {}, readJsonFile: vi.fn() }))

import { activeProxy, applyNetworkProxy, proxyUnreachable } from '../network-proxy'

async function closedPort() {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise(resolve => server.close(resolve))
  return port
}

describe('请求失败后判断是不是代理连不上', () => {
  it('请求发出时没开代理，之后才保存了连不上的代理：不归咎代理', async () => {
    applyNetworkProxy({ enabled: false, type: 'http', host: '', port: 0 })
    const sentThrough = activeProxy()
    applyNetworkProxy({ enabled: true, type: 'http', host: '127.0.0.1', port: await closedPort() })
    await expect(proxyUnreachable('https://api.example.com/v1', sentThrough)).resolves.toBe(false)
  })

  it('请求经这条代理发出，代理连不上：归咎代理', async () => {
    applyNetworkProxy({ enabled: true, type: 'http', host: '127.0.0.1', port: await closedPort() })
    await expect(proxyUnreachable('https://api.example.com/v1', activeProxy())).resolves.toBe(true)
  })
})
