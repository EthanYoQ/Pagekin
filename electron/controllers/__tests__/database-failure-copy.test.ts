import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  projectPath: 'C:/projects/A',
  accessError: undefined as Error | undefined,
  record: vi.fn(),
  listPending: vi.fn(),
  updatePending: vi.fn(),
  resolve: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) } },
}))
vi.mock('../../database', () => ({
  closeProjectDatabase: vi.fn(),
  getCurrentProjectPath: () => mocks.projectPath,
  getProjectDb: () => null,
}))
vi.mock('../../services/project-access', () => ({
  projectAccess: {
    assertCurrentProjectContext: () => {
      if (mocks.accessError) throw mocks.accessError
    },
    captureCurrentSession: () => ({ projectId: 'project-A', rootPath: mocks.projectPath }),
  },
}))
vi.mock('../../repositories/recovery-candidate-repository', () => ({
  RecoveryCandidateRepository: {
    record: mocks.record,
    listPending: mocks.listPending,
    updatePending: mocks.updatePending,
    resolve: mocks.resolve,
  },
}))

import { registerDatabaseController } from '../db-controller'
import { failureText, receivedIpcResult, resultFailure } from '../../../src/i18n/app-errors'
import { shown } from '../../../src/i18n/__tests__/shown-locale'

const session = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args, session)

const sqliteFailure = () => Object.assign(new Error('database disk image is malformed'), { name: 'SqliteError', code: 'SQLITE_CORRUPT' })

const WRITES = [
  ['db:recovery-candidate-record', [{ runId: 'run-1' }, 'C:/projects/A'], mocks.record],
  ['db:recovery-candidate-update', ['candidate-1', '恢复稿正文', 'C:/projects/A'], mocks.updatePending],
  ['db:recovery-candidate-resolve', ['candidate-1', 'discarded', 'C:/projects/A'], mocks.resolve],
] as const

type Received = Parameters<typeof resultFailure>[0] & { success: boolean }

async function received(channel: string, args: readonly unknown[]): Promise<Received> {
  return receivedIpcResult(await invoke(channel, ...args)) as Received
}

const zhText = (result: Received) => failureText(shown('zh-CN'), resultFailure(result))

beforeAll(() => registerDatabaseController())

beforeEach(() => {
  mocks.projectPath = 'C:/projects/A'
  mocks.accessError = undefined
  for (const fn of [mocks.record, mocks.listPending, mocks.updatePending, mocks.resolve]) fn.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('数据库读写失败时作者看不到主进程原文', () => {
  it.each(WRITES)('%s 遇到 SQLite 原文', async (channel, args, repository) => {
    repository.mockImplementation(() => { throw sqliteFailure() })
    const result = await received(channel, args)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toMatch(/SqliteError|malformed|SQLITE_/u)
    expect(zhText(result)).toBe('恢复稿没能写进作品，原来的内容没有改动。请再试一次。')
  })

  it('db:recovery-candidate-list 遇到 SQLite 原文', async () => {
    mocks.listPending.mockImplementation(() => { throw sqliteFailure() })
    const rejection = await invoke('db:recovery-candidate-list', 'C:/projects/A').then(() => undefined, (error: Error) => error)
    expect(rejection?.message).not.toMatch(/SqliteError|malformed|SQLITE_/u)
  })
})

describe('数据库读写失败的说明与 master 逐字相同', () => {
  it.each([
    ['RECOVERY_CANDIDATE_NOT_PENDING', '这份恢复稿已经处理过（已采用或已丢弃），请刷新后再看。'],
    ['RECOVERY_CANDIDATE_SOURCE_CHANGED', '这一章的蓝图或草稿在恢复稿生成后有了变化，已拒绝使用这份恢复稿。请重新生成这一章。'],
    ['RECOVERY_CANDIDATE_TEXT_EMPTY', '恢复稿没有可见正文，没有保存。请写入正文后再保存。'],
  ])('仓储拒绝 %s', async (code, expected) => {
    for (const [channel, args, repository] of WRITES) {
      repository.mockImplementation(() => { throw new Error(code) })
      expect(zhText(await received(channel, args)), channel).toBe(expected)
    }
  })

  it('会话已换', async () => {
    mocks.accessError = new Error('PROJECT_SESSION_STALE')
    for (const [channel, args] of WRITES) {
      expect(zhText(await received(channel, args)), channel)
        .toBe('项目已切换或重新打开，这次操作属于之前打开的项目，已拒绝执行。请在当前打开的项目里重新操作。')
    }
  })

  it('作品路径对不上', async () => {
    mocks.projectPath = 'C:/projects/B'
    for (const [channel, args] of WRITES) {
      expect(zhText(await received(channel, args)), channel)
        .toBe('项目已切换或重新打开，这次操作属于之前打开的项目，已拒绝执行。请在当前打开的项目里重新操作。')
    }
  })
})
