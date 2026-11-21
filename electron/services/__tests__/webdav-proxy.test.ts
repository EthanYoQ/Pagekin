import { beforeEach, describe, expect, it, vi } from 'vitest'

import { refused } from '../../__tests__/proxy-failure-fixture'

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import('node:http') }>()
  const { setGlobalProxyFromEnv } = await import('../../__tests__/proxy-failure-fixture')
  return { ...actual, default: { ...actual.default, setGlobalProxyFromEnv } }
})

import { applyNetworkProxy } from '../../network-proxy'
import { WebDavBackupService } from '../webdav-backup-service'

const account = { endpoint: 'https://dav.example.com/dav/', username: 'author', secret: 'secret' }
const failingWith = (error: unknown) => new WebDavBackupService({ fetchImpl: async () => { throw error } })

beforeEach(() => { applyNetworkProxy({ enabled: true, type: 'http', host: '127.0.0.1', port: 7890 }) })

describe('WebDAV 请求失败时说明原因', () => {
  it('连不上代理：代理连不上', async () => {
    await expect(failingWith(refused('127.0.0.1', 7890)).checkConnection(account)).rejects.toThrow('WEBDAV_PROXY_UNREACHABLE')
  })

  it('本机 WebDAV 直连被拒：网络失败，不归咎代理', async () => {
    await expect(failingWith(refused('127.0.0.1', 5005)).checkConnection(account)).rejects.toThrow('WEBDAV_NETWORK')
  })

  it('作者已取消：已取消', async () => {
    const controller = new AbortController()
    const service = new WebDavBackupService({ fetchImpl: async () => { controller.abort(); throw refused('127.0.0.1', 7890) } })
    await expect(service.checkConnection(account, controller.signal)).rejects.toThrow('WEBDAV_CANCELLED')
  })
})
