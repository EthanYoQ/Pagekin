import { beforeEach, describe, expect, it, vi } from 'vitest'

import { receivedIpcResult } from '../../i18n/app-errors'
import type { InterfaceLocale } from '../../i18n/types'
import { useLocaleStore } from '../locale-store'
import { useProjectStore } from '../project-store'

const { invoke, alertError } = vi.hoisted(() => ({ invoke: vi.fn(), alertError: vi.fn() }))

vi.mock('../../services/ipc-client', () => ({
  ipc: { invoke: async (...args: unknown[]) => receivedIpcResult(await invoke(...args)) },
}))
vi.mock('../../components/ui/AlertDialog', () => ({ alertError }))
vi.mock('../../services/project-service', () => ({
  onProjectOpening: vi.fn(),
  onProjectOpened: vi.fn(async () => undefined),
  onProjectClosed: vi.fn(),
}))

const pathTooDeep = (requestToken: string) => ({
  success: false, project: null, projectId: '', requestToken, activeProjectPath: null, databaseRestored: true, dbReady: true,
  errorCode: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
  error: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
  failure: { code: 'PROJECT_STORAGE_PATH_UNSUPPORTED', note: { key: 'error.projectPathTooDeepForDatabase', params: { max: 85 } } },
})

beforeEach(() => {
  invoke.mockReset(); alertError.mockReset()
  useProjectStore.setState({ currentProject: null, loading: false, recentProjects: [] })
})

describe('打开作品被路径限制拦下时显示主进程给的具体说明（#899）', () => {
  it.each([
    ['zh-CN', '打不开项目数据库'],
    ['en-US', 'too deep to open the project database'],
    ['ja-JP', 'プロジェクトのデータベースを開けません'],
  ] as const)('%s', async (locale: InterfaceLocale, specific) => {
    useLocaleStore.setState({ locale: locale === 'ja-JP' ? 'en-US' : locale, interfaceLocale: locale, initialized: true })
    invoke.mockImplementation(async (channel: string, _target: unknown, requestToken: string) => (
      channel === 'project:open' ? pathTooDeep(requestToken) : undefined
    ))

    await expect(useProjectStore.getState().openProject('C:\\very\\deep\\novel')).resolves.toBe(false)

    const message = alertError.mock.calls[0]![0] as string
    expect(message).toContain(specific)
    expect(message).toContain('85')
    expect(message).not.toMatch(/PROJECT_/u)
  })
})
