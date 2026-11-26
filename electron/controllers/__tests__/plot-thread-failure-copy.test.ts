import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  projectPath: 'C:/projects/A',
  accessError: undefined as Error | undefined,
  threads: {
    list: vi.fn(),
    listRelevantActive: vi.fn(),
    listReviewCandidates: vi.fn(),
    createPlan: vi.fn(),
    updatePlan: vi.fn(),
    deletePlan: vi.fn(),
    confirmEvent: vi.fn(),
    setAssignment: vi.fn(),
    removeAssignment: vi.fn(),
  },
  plotTree: { read: vi.fn(), clear: vi.fn() },
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
vi.mock('../../repositories/narrative-thread-repository', () => ({ NarrativeThreadRepository: mocks.threads }))
vi.mock('../../repositories/plot-tree-repository', () => ({ PlotTreeRepository: mocks.plotTree }))

import { registerDatabaseController } from '../db-controller'
import { failureText, receivedIpcResult, resultFailure } from '../../../src/i18n/app-errors'
import { shown } from '../../../src/i18n/__tests__/shown-locale'

const session = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args, session)

const sqliteFailure = () => Object.assign(new Error('database disk image is malformed'), { name: 'SqliteError', code: 'SQLITE_CORRUPT' })
const RAW = /SqliteError|malformed|SQLITE_/u
const PLAN = { title: '灰色的信', type: '伏笔', targetStartChapter: 1, targetEndChapter: 3, authorIntent: '谁寄的' }
const PATH = 'C:/projects/A'

const WRITES = [
  ['db:narrative-thread-plan-create', [PLAN, PATH], mocks.threads.createPlan],
  ['db:narrative-thread-plan-update', [1, PLAN, PATH], mocks.threads.updatePlan],
  ['db:narrative-thread-plan-delete', [1, PATH], mocks.threads.deletePlan],
  ['db:narrative-thread-event-confirm', [{ planId: 1, draftId: 7, type: 'planted', evidence: '信', reason: '作者确认' }, PATH], mocks.threads.confirmEvent],
  ['db:narrative-thread-assignment-set', [{ planId: 1, chapterNumber: 6, writingChapter: 5, kind: 'resolve', note: '' }, PATH], mocks.threads.setAssignment],
  ['db:narrative-thread-assignment-remove', [1, 6, 5, PATH], mocks.threads.removeAssignment],
  ['db:plot-tree-clear', [PATH], mocks.plotTree.clear],
] as const

const READS = [
  ['db:narrative-thread-list', [PATH], mocks.threads.list],
  ['db:narrative-thread-list-relevant', [{ chapterNumber: 5, title: '', keyEvents: '', characters: [] }, PATH], mocks.threads.listRelevantActive],
  ['db:narrative-thread-review-candidates', [PATH], mocks.threads.listReviewCandidates],
  ['db:plot-tree-read', [PATH], mocks.plotTree.read],
] as const

type Received = Parameters<typeof resultFailure>[0] & { success: boolean }

async function received(channel: string, args: readonly unknown[]): Promise<Received> {
  return receivedIpcResult(await invoke(channel, ...args)) as Received
}

const zhText = (result: Received) => failureText(shown('zh-CN'), resultFailure(result))
const STALE = '项目已切换或重新打开，这次操作属于之前打开的项目，已拒绝执行。请在当前打开的项目里重新操作。'

beforeAll(() => registerDatabaseController())

beforeEach(() => {
  mocks.projectPath = PATH
  mocks.accessError = undefined
  for (const fn of [...Object.values(mocks.threads), ...Object.values(mocks.plotTree)]) fn.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('叙事线写入失败时作者看不到主进程原文', () => {
  it.each(WRITES)('%s 遇到 SQLite 原文', async (channel, args, repository) => {
    repository.mockImplementation(() => { throw sqliteFailure() })
    const result = await received(channel, args)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toMatch(RAW)
    expect(zhText(result)).toBe('这次修改没能写进作品。请刷新后再试一次。')
  })

  it('写进去了、回读线索时失败，也不露原文', async () => {
    mocks.threads.list.mockImplementation(() => { throw sqliteFailure() })
    const result = await received('db:narrative-thread-assignment-set', WRITES[4][1])
    expect(JSON.stringify(result)).not.toMatch(RAW)
    expect(resultFailure(result)?.code).toBe('PLOT_THREAD_WRITE_FAILED')
  })

  it.each(READS)('%s 遇到 SQLite 原文', async (channel, args, repository) => {
    repository.mockImplementation(() => { throw sqliteFailure() })
    const rejection = await invoke(channel, ...args).then(() => undefined, (error: Error) => error)
    expect(rejection).toBeInstanceOf(Error)
    expect(rejection?.message).not.toMatch(RAW)
  })
})

describe('叙事线与情节树失败的说明与 master 逐字相同', () => {
  it('短证据不在定稿正文里', async () => {
    mocks.threads.confirmEvent.mockImplementation(() => { throw new Error('NARRATIVE_THREAD_EVIDENCE_NOT_IN_SOURCE') })
    expect(zhText(await received(...WRITES[3].slice(0, 2) as [string, readonly unknown[]]))).toBe('请粘贴所选定稿章节中实际出现的短原文。')
  })

  it('作品没打开', async () => {
    for (const [channel, args, repository] of WRITES) {
      repository.mockImplementation(() => { throw new Error('PROJECT_NOT_OPEN') })
      expect(zhText(await received(channel, args)), channel).toBe('请先打开项目。')
    }
  })

  it('会话已换', async () => {
    mocks.accessError = new Error('PROJECT_SESSION_STALE')
    for (const [channel, args] of WRITES) expect(zhText(await received(channel, args)), channel).toBe(STALE)
  })

  it('作品路径对不上', async () => {
    mocks.projectPath = 'C:/projects/B'
    for (const [channel, args] of WRITES) expect(zhText(await received(channel, args)), channel).toBe(STALE)
  })

  it('读通道照旧抛出已登记的码', async () => {
    mocks.projectPath = 'C:/projects/B'
    for (const [channel, args] of READS) {
      const rejection = await invoke(channel, ...args).then(() => undefined, (error: Error) => error)
      expect(rejection?.message, channel).toMatch(/^PROJECT_/u)
    }
  })
})
