import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InterfaceLocale } from '../../../src/i18n/types'

type IpcHandler = (...args: unknown[]) => Promise<unknown> | unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  locale: 'zh-CN',
  showOpenDialog: vi.fn(),
  openExternal: vi.fn(),
  writeConfig: vi.fn(),
  getStats: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => mocks.locale },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  shell: { openExternal: mocks.openExternal },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) } },
}))
vi.mock('../../i18n', async importOriginal => {
  const { selectCopy } = await import('../../../src/i18n/core')
  return {
    ...await importOriginal<object>(),
    mainText: (_system: unknown, zh: string, en: string, ja?: string) => selectCopy(mocks.locale as InterfaceLocale, zh, en, ja),
  }
})
vi.mock('../../utils/config-utils', async importOriginal => ({
  ...await importOriginal<object>(),
  readJsonFile: (_path: string, fallback: unknown) => fallback,
  updateGlobalConfig: mocks.writeConfig,
}))
vi.mock('../../network-proxy', () => ({
  applyNetworkProxy: (proxy: { host: string }) => {
    if (proxy.host === 'bad host') throw new Error('NETWORK_PROXY_INVALID')
    return () => undefined
  },
}))
vi.mock('../../database', () => ({
  closeProjectDatabase: vi.fn(),
  getCurrentProjectPath: () => 'C:/projects/A',
  getProjectDb: () => null,
}))
vi.mock('../../services/project-access', () => ({
  projectAccess: {
    assertCurrentProjectContext: () => undefined,
    captureCurrentSession: () => ({ projectId: 'project-A', rootPath: 'C:/projects/A' }),
  },
}))
vi.mock('../../repositories/llm-repository', () => ({
  LLMHistoryRepository: { getStats: mocks.getStats, getHistory: mocks.getStats, logCall: vi.fn() },
}))

import { registerCharacterAvatarController } from '../character-avatar-controller'
import { registerConfigController } from '../config-controller'
import { registerModelProviderResourceController } from '../model-provider-resource-controller'
import { registerDatabaseController } from '../db-controller'
import type { CharacterAssetService } from '../../services/character-asset-service'
import { displayedErrorMessage, failureText, receivedIpcResult } from '../../../src/i18n/app-errors'
import type { Failure } from '../../../src/shared/failure'
import { shown } from '../../../src/i18n/__tests__/shown-locale'

const event = { sender: { id: 9, isDestroyed: () => false } }
const session = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
const service = {
  hasCharacter: vi.fn(() => true),
  previewFile: vi.fn(),
  commit: vi.fn(),
  remove: vi.fn(),
  readMany: vi.fn(() => []),
  repository: { readMany: vi.fn(() => []) },
}
let resolved: typeof service | null = service

const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!(...args)

/** 迁移后读 failure；master 上头像读 error.message，其余读 error。 */
async function shownToAuthor(raw: unknown): Promise<string> {
  const result = receivedIpcResult(await raw) as { success: boolean; failure?: Failure; error?: unknown }
  expect(result.success).toBe(false)
  const locale = shown(mocks.locale as InterfaceLocale)
  if (result.failure) return failureText(locale, result.failure)
  if (typeof result.error === 'object' && result.error !== null) return (result.error as { message: string }).message
  return displayedErrorMessage(locale, result.error)
}

const sqliteFailure = () => Object.assign(new Error('database disk image is malformed'), { name: 'SqliteError', code: 'SQLITE_CORRUPT' })

const AVATAR_FAILURES: ReadonlyArray<readonly [string, () => unknown, string]> = [
  ['当前窗口不可信', () => invoke('character-avatar:commit', {}, 'stable-a', 'aW1n', session), '当前窗口无权访问角色头像。'],
  ['作品没打开', () => { resolved = null; return invoke('character-avatar:remove', event, 'stable-a', session) }, '尚未打开项目，无法访问头像。'],
  ['角色已不存在', () => { service.hasCharacter.mockReturnValue(false); return invoke('character-avatar:choose', event, 'stable-a', session) }, '该角色已不存在，头像未修改。'],
  ['选图窗口打不开', () => { mocks.showOpenDialog.mockRejectedValue(new Error('dialog failed')); return invoke('character-avatar:choose', event, 'stable-a', session) }, '无法读取所选图片，请重新选择。'],
  ['角色身份无效', () => invoke('character-avatar:read-batch', event, ['bad id'], session), '角色身份无效，头像未修改。'],
  ...([
    ['IMAGE_FORMAT_INVALID', '请选择有效的 PNG、JPEG 或 WebP 图片。'],
    ['IMAGE_TOO_LARGE', '图片超过 4 MB，请换一张更小的。'],
  ] as const).map(([code, copy]) => [code, () => {
    service.commit.mockImplementation(() => { throw new Error(code) })
    return invoke('character-avatar:commit', event, 'stable-a', 'aW1n', session)
  }, copy] as const),
  ['写入时 SQLite 报错', () => {
    service.remove.mockImplementation(() => { throw sqliteFailure() })
    return invoke('character-avatar:remove', event, 'stable-a', session)
  }, '头像保存失败，原头像保持不变。'],
]

const CONFIG_FAILURES: ReadonlyArray<readonly [string, () => unknown, string]> = [
  ['配置文件已损坏', () => { mocks.writeConfig.mockReturnValue(false); return invoke('config:set', {}, { locale: 'en-US' }) },
    '全局配置文件已损坏，已拒绝覆盖。请修复或删除应用数据目录里的 config.json 后重试。'],
  ['写盘失败', () => {
    mocks.writeConfig.mockImplementation(() => { throw Object.assign(new Error("EPERM: operation not permitted, open 'C:\\config.json'"), { code: 'EPERM' }) })
    return invoke('config:set', {}, { locale: 'en-US' })
  }, '设置没能写进配置文件。请确认磁盘还有空间、应用数据目录可写，再重试。'],
  ['代理主机填错', () => invoke('config:set', {}, { proxy: { enabled: true, type: 'http', host: 'bad host', port: 7890 } }),
    '主机地址填得不对。只填 IP 或域名，例如 127.0.0.1。'],
]

beforeAll(() => {
  registerCharacterAvatarController({ resolveService: () => resolved as unknown as CharacterAssetService })
  registerConfigController()
  registerModelProviderResourceController({ openExternal: mocks.openExternal })
  registerDatabaseController()
})

beforeEach(() => {
  mocks.locale = 'zh-CN'
  resolved = service
  service.hasCharacter.mockReturnValue(true)
  for (const fn of [mocks.showOpenDialog, mocks.writeConfig, mocks.getStats, service.commit, service.remove]) fn.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u

describe('小控制器失败时作者看不到主进程原文', () => {
  it.each([...AVATAR_FAILURES, ...CONFIG_FAILURES])('日文界面：%s 说日文', async (_name, fail) => {
    mocks.locale = 'ja-JP'
    expect(await shownToAuthor(fail())).toMatch(JAPANESE)
  })

  it('打不开服务商页面时说中文，不露英文原文', async () => {
    mocks.openExternal.mockRejectedValue(new Error('browser unavailable'))
    const text = await shownToAuthor(invoke('model-provider-resource:open', {}, 'siliconflow-console'))
    expect(text).toMatch(/\p{Script=Han}/u)
    expect(text).not.toMatch(/Unable|browser unavailable/u)
  })

  it.each(['db:get-llm-stats', 'db:get-llm-history'])('%s 遇到 SQLite 原文', async channel => {
    mocks.getStats.mockImplementation(() => { throw sqliteFailure() })
    const args = channel === 'db:get-llm-stats' ? ['C:/projects/A'] : [30, 'C:/projects/A']
    const rejection = await Promise.resolve(invoke(channel, {}, ...args, session)).then(() => undefined, (error: Error) => error)
    expect(rejection?.message).not.toMatch(/SqliteError|malformed|SQLITE_/u)
  })
})

describe('小控制器失败的说明与 master 逐字相同', () => {
  it.each([...AVATAR_FAILURES, ...CONFIG_FAILURES])('%s', async (_name, fail, expected) => {
    expect(await shownToAuthor(fail())).toBe(expected)
  })
})
