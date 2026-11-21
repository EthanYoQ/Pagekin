import { beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  locale: 'zh-CN',
}))

vi.mock('electron', () => ({
  app: { getLocale: () => mocks.locale },
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)) },
}))

vi.mock('../../utils/config-utils', async importOriginal => ({
  ...await importOriginal<typeof import('../../utils/config-utils')>(),
  readJsonFile: (_path: string, fallback: unknown) => fallback,
  updateGlobalConfig: () => {
    throw Object.assign(new Error("EPERM: operation not permitted, open 'C:\\Users\\a\\AppData\\Roaming\\ai-novel-writer\\config.json'"), { code: 'EPERM' })
  },
}))

beforeEach(async () => {
  vi.resetModules()
  mocks.handlers.clear()
  const { registerConfigController } = await import('../config-controller')
  registerConfigController()
})

describe('全局设置写盘失败时的说明（#702）', () => {
  it('中文界面：说中文，不露系统原文', async () => {
    const result = await mocks.handlers.get('config:set')!({}, { locale: 'en-US' }) as { success: boolean; error?: string }
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/\p{Script=Han}/u)
    expect(result.error).not.toMatch(/EPERM|operation not permitted|config\.json/u)
  })

  it('英文界面：说英文', async () => {
    mocks.locale = 'en-US'
    const result = await mocks.handlers.get('config:set')!({}, { locale: 'zh-CN' }) as { success: boolean; error?: string }
    expect(result.error).not.toMatch(/\p{Script=Han}|EPERM/u)
  })
})
