import { beforeEach, describe, expect, it, vi } from 'vitest'
import { failureText, receivedIpcResult, resultFailure } from '../../../src/i18n/app-errors'
import { shown } from '../../../src/i18n/__tests__/shown-locale'

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
  const shownText = async (locale: 'zh-CN' | 'en-US') => {
    const raw = await mocks.handlers.get('config:set')!({}, { locale: 'en-US' })
    expect(JSON.stringify(raw)).not.toMatch(/EPERM|operation not permitted/u)
    return failureText(shown(locale), resultFailure(receivedIpcResult(raw) as { success: boolean }))
  }

  it('中文界面：说中文，不露系统原文', async () => {
    expect(await shownText('zh-CN')).toBe('设置没能写进配置文件。请确认磁盘还有空间、应用数据目录可写，再重试。')
  })

  it('英文界面：说英文', async () => {
    expect(await shownText('en-US')).not.toMatch(/\p{Script=Han}|EPERM/u)
  })
})
