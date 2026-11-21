import { describe, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({ duringProbe: () => {} }))

vi.mock('../../network-proxy', () => ({
  activeProxy: vi.fn(() => null),
  proxyUnreachable: vi.fn(async () => { probe.duringProbe(); return true }),
}))

import { WebDavBackupService } from '../webdav-backup-service'

describe('WebDAV 请求失败后检查代理', () => {
  it('检查代理期间作者取消，结果是已取消', async () => {
    const controller = new AbortController()
    probe.duringProbe = () => controller.abort()
    const service = new WebDavBackupService({ fetchImpl: async () => { throw new TypeError('fetch failed') } })

    await expect(service.checkConnection(
      { endpoint: 'https://dav.example.com/dav/', username: 'author', secret: 'secret' }, controller.signal,
    )).rejects.toThrow('WEBDAV_CANCELLED')
  })
})
