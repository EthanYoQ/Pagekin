import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  projectPath: 'C:/projects/A',
  accessError: undefined as Error | undefined,
  blueprints: {
    getAll: vi.fn(), getByChapter: vi.fn(), upsert: vi.fn(), upsertMany: vi.fn(), commitRange: vi.fn(),
    getCommittedRangeOperation: vi.fn(), delete: vi.fn(), clearAll: vi.fn(),
  },
  core: { get: vi.fn(), update: vi.fn(), setAiSources: vi.fn(), commitSynopsis: vi.fn() },
  clear: { clearGeneratedData: vi.fn() },
  stopExports: vi.fn(),
  closeDatabase: vi.fn(),
  invalidate: vi.fn(),
  sourcesCurrent: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) } },
}))
vi.mock('../../database', () => ({
  closeProjectDatabase: mocks.closeDatabase,
  getCurrentProjectPath: () => mocks.projectPath,
  getProjectDb: () => ({ transaction: (fn: () => unknown) => Object.assign(() => fn(), { immediate: () => fn() }) }),
}))
vi.mock('../../services/project-access', () => ({
  projectAccess: {
    assertCurrentProjectContext: () => {
      if (mocks.accessError) throw mocks.accessError
    },
    assertCurrentSession: () => undefined,
    captureCurrentSession: () => ({ projectId: 'project-A', leaseId: 'lease-A', rootPath: mocks.projectPath }),
    invalidateCurrentSession: mocks.invalidate,
  },
}))
vi.mock('../../services/portable-export-host', () => ({ stopPortableExports: mocks.stopExports }))
vi.mock('../../repositories/blueprint-repository', () => ({ BlueprintRepository: mocks.blueprints }))
vi.mock('../../repositories/project-core-repository', () => ({ ProjectCoreRepository: mocks.core }))
vi.mock('../../repositories/project-clear-repository', () => ({ ProjectClearRepository: mocks.clear }))
vi.mock('../generation-controller', () => ({
  assertGenerationSourcesCurrent: mocks.sourcesCurrent,
  assertGenerationSynopsisCommit: vi.fn(),
  assertImportGenerationSourcesCurrent: vi.fn(),
  commitGenerationBlueprintAuthorEdit: vi.fn(),
  commitGenerationPlotOutlineAuthorEdit: vi.fn(),
  recordGenerationDirectoryCommit: vi.fn(),
  recordGenerationPlotOutlineCommit: vi.fn(),
  withGenerationAgentChildEffect: (_handle: unknown, effect: () => unknown) => effect(),
}))
vi.mock('../../../src/services/ipc-client', () => ({
  ipc: {
    invokeWithProjectSession: async (session: unknown, channel: string, ...args: unknown[]) =>
      receivedIpcResult(await mocks.handlers.get(channel)!({}, ...args, session)),
  },
}))

import { registerDatabaseController } from '../db-controller'
import { failureText, receivedIpcResult, resultFailure } from '../../../src/i18n/app-errors'
import { shown } from '../../../src/i18n/__tests__/shown-locale'
import { saveChapterBlueprint } from '../../../src/services/workflows/directory-workflow'

const session = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args, session)

const sqliteFailure = () => Object.assign(new Error('database disk image is malformed'), { name: 'SqliteError', code: 'SQLITE_CORRUPT' })
const RAW = /SqliteError|malformed|SQLITE_/u
const PATH = 'C:/projects/A'
const BLUEPRINT = { chapterNumber: 3, title: '雾钟', role: '', purpose: '', keyEvents: '', characters: [], suspenseHook: '', userGuidance: '', notes: '' }
const RANGE = { mode: 'replace-range', operationId: 'op-1', startChapter: 3, endChapter: 3, blueprints: [BLUEPRINT] }
const HANDLE = { runId: 'run-1' }
const SYNOPSIS = { synopsis: '新大纲', expected: { synopsis: '旧大纲' } }

const BLUEPRINT_WRITES = [
  ['db:blueprint-upsert', [BLUEPRINT, PATH], mocks.blueprints.upsert],
  ['db:blueprint-upsert-many', [[BLUEPRINT], PATH], mocks.blueprints.upsertMany],
  ['db:blueprint-commit-range', [RANGE, PATH], mocks.blueprints.commitRange],
  ['db:blueprint-delete', [3, PATH], mocks.blueprints.delete],
  ['db:blueprint-clear-all', [PATH], mocks.blueprints.clearAll],
] as const

const CORE_WRITES = [
  ['db:project-core-update', [{ premise: '雾港' }, PATH], mocks.core.update],
  ['db:project-core-commit-generated', [{ data: { premise: '雾港' }, generationRunHandle: HANDLE }, PATH], mocks.core.update],
  ['db:project-core-synopsis-commit', [SYNOPSIS, PATH], mocks.core.commitSynopsis],
] as const

const WRITES = [
  ...BLUEPRINT_WRITES,
  ...CORE_WRITES,
  ['db:project-clear-generated-data', [{ blueprints: true }, PATH], mocks.clear.clearGeneratedData],
  ['db:close', [PATH], mocks.stopExports],
] as const

const READS = [
  ['db:blueprint-get-all', [PATH], mocks.blueprints.getAll],
  ['db:blueprint-get', [3, PATH], mocks.blueprints.getByChapter],
  ['db:project-core-get', [PATH], mocks.core.get],
] as const

type Received = Parameters<typeof resultFailure>[0] & { success: boolean }

async function received(channel: string, args: readonly unknown[]): Promise<Received> {
  return receivedIpcResult(await invoke(channel, ...args)) as Received
}

const text = (locale: 'zh-CN' | 'en-US', result: Received) => failureText(shown(locale), resultFailure(result))
const STALE = '项目已切换或重新打开，这次操作属于之前打开的项目，已拒绝执行。请在当前打开的项目里重新操作。'

beforeAll(() => registerDatabaseController())

beforeEach(() => {
  mocks.projectPath = PATH
  mocks.accessError = undefined
  for (const group of [mocks.blueprints, mocks.core, mocks.clear]) {
    for (const fn of Object.values(group)) fn.mockReset()
  }
  for (const fn of [mocks.stopExports, mocks.closeDatabase, mocks.invalidate, mocks.sourcesCurrent]) fn.mockReset()
  mocks.core.commitSynopsis.mockReturnValue(true)
  mocks.blueprints.commitRange.mockReturnValue({ operationId: 'op-1', snapshot: [] })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('蓝图与作品台账失败时作者看不到主进程原文', () => {
  it.each(WRITES)('%s 遇到 SQLite 原文', async (channel, args, repository) => {
    repository.mockImplementation(() => { throw sqliteFailure() })
    const result = await received(channel, args)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toMatch(RAW)
    for (const locale of ['zh-CN', 'en-US'] as const) expect(text(locale, result), locale).not.toMatch(RAW)
  })

  it.each(READS)('%s 遇到 SQLite 原文', async (channel, args, repository) => {
    repository.mockImplementation(() => { throw sqliteFailure() })
    const rejection = await invoke(channel, ...args).then(() => undefined, (error: Error) => error)
    expect(rejection).toBeInstanceOf(Error)
    expect(rejection?.message).not.toMatch(RAW)
  })

  it('目录工作流保存蓝图失败，中文提示里没有原文', async () => {
    mocks.blueprints.upsert.mockImplementation(() => { throw sqliteFailure() })
    const error = await saveChapterBlueprint(BLUEPRINT as never, PATH, session, shown('zh-CN')).then(() => undefined, (reason: Error) => reason)
    expect(error?.message).toBe('保存章节蓝图失败')
  })

  it('蓝图与作品设定的写失败，说明先写保住了什么', async () => {
    for (const [channel, args, repository] of BLUEPRINT_WRITES) {
      repository.mockImplementation(() => { throw sqliteFailure() })
      expect(text('zh-CN', await received(channel, args)), channel).toBe('已有的章节蓝图都还在。这次修改没能写进作品，请再试一次。')
    }
    for (const [channel, args, repository] of CORE_WRITES) {
      repository.mockImplementation(() => { throw sqliteFailure() })
      expect(text('zh-CN', await received(channel, args)), channel).toBe('故事设定与架构没有改动。这次修改没能写进作品，请再试一次。')
    }
    mocks.clear.clearGeneratedData.mockImplementation(() => { throw sqliteFailure() })
    expect(text('zh-CN', await received('db:project-clear-generated-data', [{ blueprints: true }, PATH])))
      .toBe('作品内容没有被清除。这次清除没能完成，请再试一次。')
  })

  it('章节文件挪不回原处时，不说「没有被清除」，说清文件在哪', async () => {
    mocks.clear.clearGeneratedData.mockImplementation(() => { throw new Error('PROJECT_CLEAR_RESTORE_FAILED') })
    const result = await received('db:project-clear-generated-data', [{ generatedText: true }, PATH])
    expect(resultFailure(result)?.code).toBe('PROJECT_CLEAR_RESTORE_FAILED')
    expect(text('zh-CN', result)).toBe('作品库里的内容没有被清除，但有章节正文文件没能挪回作品文件夹，暂存在作品数据的 trash 文件夹里。请把它们挪回作品文件夹后再试。')
  })
})

describe('蓝图与作品台账失败的说明与 master 逐字相同', () => {
  const zhShown = async (channel: string, args: readonly unknown[]) =>
    text('zh-CN', await received(channel, args).catch((error: Error) => ({ success: false, error: error.message })))

  it('会话已换', async () => {
    mocks.accessError = new Error('PROJECT_SESSION_STALE')
    for (const [channel, args] of WRITES) expect(await zhShown(channel, args), channel).toBe(STALE)
  })

  it('作品路径对不上', async () => {
    mocks.projectPath = 'C:/projects/B'
    for (const [channel, args] of WRITES) expect(await zhShown(channel, args), channel).toBe(STALE)
  })

  it('目录工作流保存蓝图失败，英文提示与 master 相同', async () => {
    mocks.blueprints.upsert.mockImplementation(() => { throw sqliteFailure() })
    const error = await saveChapterBlueprint(BLUEPRINT as never, PATH, session, shown('en-US')).then(() => undefined, (reason: Error) => reason)
    expect(error?.message).toBe('Could not save the chapter blueprint.')
  })

  it('读通道照旧抛出已登记的码', async () => {
    mocks.projectPath = 'C:/projects/B'
    for (const [channel, args] of READS) {
      const rejection = await invoke(channel, ...args).then(() => undefined, (error: Error) => error)
      expect(rejection?.message, channel).toMatch(/^PROJECT_/u)
    }
  })
})

describe('蓝图恢复、作品台账写入与关闭的判定不变', () => {
  it('写通道成功时原样回结果', async () => {
    mocks.clear.clearGeneratedData.mockReturnValue({ cleared: ['blueprints'], physicalFilesDeleted: 0 })
    expect(await received('db:blueprint-upsert', [BLUEPRINT, PATH])).toEqual({ success: true })
    expect(mocks.blueprints.upsert).toHaveBeenCalledWith(BLUEPRINT)
    expect(await received('db:blueprint-commit-range', [RANGE, PATH])).toEqual({ success: true, receipt: { operationId: 'op-1', snapshot: [] } })
    expect(await received('db:blueprint-delete', [3, PATH])).toEqual({ success: true })
    expect(mocks.blueprints.delete).toHaveBeenCalledWith(3)
    expect(await received('db:project-core-update', [{ premise: '雾港' }, PATH])).toEqual({ success: true })
    expect(mocks.core.update).toHaveBeenCalledWith({ premise: '雾港' })
    expect(await received('db:project-core-synopsis-commit', [SYNOPSIS, PATH])).toEqual({ success: true })
    expect(await received('db:project-clear-generated-data', [{ blueprints: true }, PATH])).toEqual({ success: true, cleared: ['blueprints'], physicalFilesDeleted: 0 })
  })

  it('大纲被并发改动时回登记码，渲染端按码判定', async () => {
    mocks.core.commitSynopsis.mockReturnValue(false)
    expect(resultFailure(await received('db:project-core-synopsis-commit', [SYNOPSIS, PATH]))?.code).toBe('PROJECT_CORE_SYNOPSIS_CHANGED')
  })

  it('生成来源变了时回登记码，不换成通用写失败', async () => {
    mocks.sourcesCurrent.mockImplementation(() => { throw new Error('GENERATION_SOURCE_CHANGED') })
    expect(resultFailure(await received('db:project-core-commit-generated', CORE_WRITES[1][1]))?.code).toBe('GENERATION_SOURCE_CHANGED')
    expect(mocks.core.update).not.toHaveBeenCalled()
  })

  it('关闭成功时关库并作废会话，失败时都不做', async () => {
    expect(await received('db:close', [PATH])).toEqual({ success: true })
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1)
    expect(mocks.invalidate).toHaveBeenCalledTimes(1)
    mocks.closeDatabase.mockReset()
    mocks.invalidate.mockReset()
    mocks.stopExports.mockImplementation(() => { throw sqliteFailure() })
    expect((await received('db:close', [PATH])).success).toBe(false)
    expect(mocks.closeDatabase).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })
})
