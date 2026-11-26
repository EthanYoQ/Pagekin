import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import DIRECT_CHANNELS from '../direct-channels.json'

type Listener = (event: unknown, ...args: unknown[]) => unknown

const fake = vi.hoisted(() => ({
  listeners: new Map<string, Listener>(),
  registrations: [] as string[],
  throughHandle: new Set<string>(),
  dataRoot: '',
}))

vi.mock('electron', () => {
  const stub: unknown = new Proxy(function stub() {}, {
    get: (_target, key) => key === 'then' ? undefined : stub,
    apply: () => stub,
    construct: () => stub as object,
  })
  const register = (channel: string, listener: Listener) => {
    if (fake.listeners.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
    fake.listeners.set(channel, listener)
    fake.registrations.push(channel)
  }
  const ipcMain = { handle: register, handleOnce: register, removeHandler: (channel: string) => { fake.listeners.delete(channel) } }
  const names = ['BrowserWindow', 'Notification', 'app', 'contextBridge', 'dialog', 'nativeImage', 'safeStorage', 'shell', 'webFrame', 'ipcRenderer']
  const exports: Record<string, unknown> = Object.fromEntries(names.map(name => [name, stub]))
  exports.ipcMain = ipcMain
  return { ...exports, default: { ...exports } }
})
vi.mock('../handle', async importOriginal => {
  const actual = await importOriginal<typeof import('../handle')>()
  return { ...actual, handle: ((channel, handler) => { fake.throughHandle.add(channel); actual.handle(channel, handler) }) satisfies typeof actual.handle }
})
vi.mock('../../services/app-data-locator', async importOriginal => ({
  ...await importOriginal<object>(),
  assertGlobalDataReady: () => undefined,
  getGlobalDataRoot: () => fake.dataRoot,
}))

import { ipcMain } from 'electron'
import { guardIpcRegistration, rejectUnlistedIpc } from '../handle'
import { directRegistrations, throughHandle } from './fixtures/direct-registration'

beforeAll(() => {
  fake.dataRoot = mkdtempSync(join(tmpdir(), 'ipc-guard-'))
  guardIpcRegistration(ipcMain, rejectUnlistedIpc(false))
})
afterAll(() => rmSync(fake.dataRoot, { recursive: true, force: true }))
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })

describe('应用启动时的整套 IPC 注册经过守卫', () => {
  it('全部注册成功；不经 handle() 直接注册的通道正好是 direct-channels.json', async () => {
    const { registerIPCHandlers } = await import('../../ipc-handlers')
    const { registerMCPHandlers } = await import('../../mcp/mcp-ipc-bridge')
    const { registerStartupController } = await import('../../controllers/startup-controller')
    const { registerUpdateController } = await import('../../controllers/update-controller')
    expect(fake.registrations).toEqual([])

    registerStartupController({ ipc: ipcMain as never, getTrustedSender: () => null, rendererUrl: '',
      getGlobalGeneration: () => null, getBlockedCode: () => undefined })
    registerIPCHandlers()
    registerMCPHandlers()
    registerUpdateController({ subscribe: () => () => undefined } as never, { ipc: ipcMain as never, publish: () => undefined })

    expect(fake.registrations.filter(channel => !fake.throughHandle.has(channel)).sort()).toEqual(DIRECT_CHANNELS)
    expect(fake.throughHandle.size).toBeGreaterThan(0)
  }, 60_000)
})

describe('名单外的通道不经 handle() 注册就抛错', () => {
  it.each(Object.keys(directRegistrations))('%s', name => {
    const channel = `demo:${name}`
    expect(() => directRegistrations[name]!(channel)).toThrow(/没有经 electron\/ipc\/handle\.ts 的 handle\(\) 注册/u)
    expect(fake.listeners.has(channel)).toBe(false)
  })

  it('改走 handle() 就注册成功', () => {
    throughHandle('demo:through-handle')
    expect(fake.listeners.has('demo:through-handle')).toBe(true)
  })
})

describe('打包后名单外的直接注册', () => {
  const packagedIpc = () => {
    const registered = new Map<string, { once: boolean; listener: Listener }>()
    const ipc = {
      handle: (channel: string, listener: Listener) => { registered.set(channel, { once: false, listener }) },
      handleOnce: (channel: string, listener: Listener) => { registered.set(channel, { once: true, listener }) },
    }
    guardIpcRegistration(ipc as never, rejectUnlistedIpc(true))
    return { ipc, registered }
  }
  const raw = () => { throw new Error('SQLITE_CANTOPEN C:\\Users\\writer\\project.db') }

  it.each(['handle', 'handleOnce'] as const)('%s 不抛错，仍用同一种注册方法；未登记的失败只给渲染端通用码', async method => {
    const { ipc, registered } = packagedIpc()

    ipc[method]('demo:packaged', raw)

    expect(registered.get('demo:packaged')?.once).toBe(method === 'handleOnce')
    await expect(Promise.resolve(registered.get('demo:packaged')!.listener({}))).rejects.toThrow(/^IPC_HANDLER_FAILED$/u)
  })
})
