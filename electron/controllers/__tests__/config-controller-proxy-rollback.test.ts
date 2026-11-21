import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { dispatcher } from '../../__tests__/proxy-failure-fixture'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({ handlers: new Map<string, IpcHandler>(), writeFails: false }))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) }) },
}))

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import('node:http') }>()
  const { setGlobalProxyFromEnv } = await import('../../__tests__/proxy-failure-fixture')
  return { ...actual, default: { ...actual.default, setGlobalProxyFromEnv } }
})

vi.mock('../../utils/config-utils', async importOriginal => {
  const actual = await importOriginal<typeof import('../../utils/config-utils')>()
  return {
    ...actual,
    updateGlobalConfig: (...args: Parameters<typeof actual.updateGlobalConfig>) => {
      if (mocks.writeFails) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      return actual.updateGlobalConfig(...args)
    },
  }
})

const A = { enabled: true, type: 'http' as const, host: '127.0.0.1', port: 7890 }
const B = { enabled: true, type: 'http' as const, host: '127.0.0.1', port: 7891 }

let root = ''
let configPath = ''
const save = (config: Record<string, unknown>) => mocks.handlers.get('config:set')!({}, config) as Promise<{ success: boolean }>

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-proxy-rollback-'))
  const dataRoot = await (await import('../../services/__tests__/global-data-fixture')).prepareGlobalDataFixture(root)
  configPath = path.join(dataRoot, 'config.json')
  const { registerConfigController } = await import('../config-controller')
  registerConfigController()
})

beforeEach(async () => {
  mocks.writeFails = false
  fs.rmSync(configPath, { force: true })
  await expect(save({ proxy: A })).resolves.toEqual({ success: true })
  expect(dispatcher.proxy).toBe('http://127.0.0.1:7890')
})

afterAll(() => {
  delete process.env.AI_NOVEL_VELA_HOME
  delete process.env.AI_NOVEL_APP_DATA_HOME
  fs.rmSync(root, { recursive: true, force: true })
})

describe('保存设置失败时，正在用的代理 A 不被卸掉', () => {
  it('config.json 损坏时保存代理 B', async () => {
    fs.writeFileSync(configPath, '{broken')
    await expect(save({ proxy: B })).resolves.toMatchObject({ success: false })
    expect(dispatcher.proxy).toBe('http://127.0.0.1:7890')
  })

  it('config.json 损坏时保存别的设置', async () => {
    fs.writeFileSync(configPath, '{broken')
    await expect(save({ theme: 'light' })).resolves.toMatchObject({ success: false })
    expect(dispatcher.proxy).toBe('http://127.0.0.1:7890')
  })

  it('写入配置时抛错', async () => {
    mocks.writeFails = true
    await expect(save({ proxy: B })).resolves.toMatchObject({ success: false })
    expect(dispatcher.proxy).toBe('http://127.0.0.1:7890')
  })

  it('代理 B 的地址非法', async () => {
    fs.writeFileSync(configPath, '{broken')
    await expect(save({ proxy: { ...B, host: 'http://127.0.0.1' } })).resolves.toEqual({ success: false, error: 'NETWORK_PROXY_INVALID' })
    expect(dispatcher.proxy).toBe('http://127.0.0.1:7890')
  })
})
