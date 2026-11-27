import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  projectPath: 'C:/projects/A',
  runs: {
    get: vi.fn((): { locale: 'zh-CN' | 'en-US' } | undefined => undefined),
    listResumable: vi.fn(),
    listChapterBatch: vi.fn(),
    getEffectReceipt: vi.fn(),
    prepareEffectReceipt: vi.fn(),
    commitEffectReceipt: vi.fn(),
    finalizeParsing: vi.fn(),
    startOrResume: vi.fn(),
    renewExecution: vi.fn(),
    restart: vi.fn(),
    requestCancel: vi.fn(),
    cancelAtBoundary: vi.fn(),
    completeBatch: vi.fn(),
    advanceStage: vi.fn(),
    fail: vi.fn(),
    complete: vi.fn(),
    prepare: vi.fn(),
    beginParsing: vi.fn(),
  },
  globalFacts: { commit: vi.fn() },
  inspection: { peek: vi.fn(), consume: vi.fn() },
  preview: vi.fn(),
  resolveSources: vi.fn(),
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
    assertCurrentProjectContext: () => undefined,
    captureCurrentSession: () => ({ projectId: 'project-A', rootPath: mocks.projectPath }),
  },
}))
vi.mock('../../repositories/import-run-repository', () => ({ ImportRunRepository: mocks.runs }))
vi.mock('../../repositories/import-global-facts-repository', () => ({ ImportGlobalFactsRepository: mocks.globalFacts }))
vi.mock('../../repositories/finalized-draft-import-repository', () => ({ FinalizedDraftImportRepository: { preview: mocks.preview } }))
vi.mock('../../repositories/import-source-identity-repository', () => ({ ImportSourceIdentityRepository: { resolveEncodedSources: mocks.resolveSources } }))
vi.mock('../../services/import-inspection-store', () => ({ importInspectionStore: mocks.inspection }))
vi.mock('../../services/import-source-identity-secret', () => ({ loadApplicationImportSourceSecret: () => 'secret' }))

import { registerDatabaseController } from '../db-controller'
import { persistedImportRunFailure } from '../import-run-failure'
import { writtenImportFailure } from '../../../src/shared/import-run'
import { failureText, receivedIpcResult, resultFailure } from '../../../src/i18n/app-errors'
import { errorLocaleForRun } from '../../../src/i18n/core'
import type { Locale } from '../../../src/i18n/types'
import { shown } from '../../../src/i18n/__tests__/shown-locale'

const session = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
const PATH = 'C:/projects/A'
const EXEC = { owner: 'renderer', epoch: 1, expiresAt: 1 }
const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({ sender: { id: 7 } }, ...args, session)

const sqliteFailure = () => Object.assign(new Error('database disk image is malformed'), { name: 'SqliteError', code: 'SQLITE_CORRUPT' })
const RAW = /SqliteError|malformed|SQLITE_/u
const CHECK_FAILED = {
  'zh-CN': '已经导入的内容没有受影响。导入没能继续：校验没有通过。请重试；如果仍然出现，请把这段说明反馈给我们。',
  'en-US': 'Content already imported is unaffected. The import could not continue because a check failed. Try again; if it keeps happening, send us this message.',
}

const WRITES = [
  ['db:import-global-facts-commit', [{ operationId: 'import-global-A' }, PATH], mocks.globalFacts.commit],
  ['db:import-run-prepare-inspection', [{ inspectionId: 'inspection', runId: 'run', purpose: 'reference', locale: 'zh-CN' }, PATH], mocks.inspection.consume],
  ['db:import-run-finalize-parsing', ['run', PATH], mocks.runs.finalizeParsing],
  ['db:import-run-effect-receipt-prepare', [{ runId: 'run', stage: 'style', batchId: 'done' }, EXEC, PATH], mocks.runs.prepareEffectReceipt],
  ['db:import-run-effect-receipt-commit', ['run', 'style', 'done', EXEC, PATH], mocks.runs.commitEffectReceipt],
  ['db:import-run-start-resume', ['run', 'owner', PATH], mocks.runs.startOrResume],
  ['db:import-run-renew-execution', ['run', EXEC, PATH], mocks.runs.renewExecution],
  ['db:import-run-restart', ['run', 'next-run', PATH], mocks.runs.restart],
  ['db:import-run-request-cancel', ['run', EXEC, PATH], mocks.runs.requestCancel],
  ['db:import-run-cancel-at-boundary', ['run', EXEC, PATH], mocks.runs.cancelAtBoundary],
  ['db:import-run-complete-batch', ['run', 'knowledge', '1', EXEC, PATH], mocks.runs.completeBatch],
  ['db:import-run-advance-stage', ['run', 'knowledge', 'global', EXEC, PATH], mocks.runs.advanceStage],
  ['db:import-run-fail', ['run', 'knowledge', '第 1 章没能写进知识库。', EXEC, PATH], mocks.runs.fail],
  ['db:import-run-complete', ['run', EXEC, PATH], mocks.runs.complete],
] as const

const READS = [
  ['db:import-run-author-preview', ['inspection', PATH], mocks.inspection.peek],
  ['db:import-run-get', ['run', PATH], mocks.runs.get],
  ['db:import-run-list-resumable', [PATH], mocks.runs.listResumable],
  ['db:import-run-list-chapters', ['run', 0, 10, PATH], mocks.runs.listChapterBatch],
  ['db:import-run-effect-receipt-get', ['run', 'style', 'done', PATH], mocks.runs.getEffectReceipt],
] as const

type Received = Parameters<typeof resultFailure>[0] & { success: boolean }

async function received(channel: string, args: readonly unknown[]): Promise<Received> {
  return receivedIpcResult(await invoke(channel, ...args)) as Received
}

const shownFor = (result: Received, runLocale: Locale) => failureText(errorLocaleForRun(runLocale, shown('zh-CN')), resultFailure(result))

beforeAll(() => registerDatabaseController())

beforeEach(() => {
  mocks.projectPath = PATH
  for (const fn of [...Object.values(mocks.runs), ...Object.values(mocks.globalFacts), ...Object.values(mocks.inspection), mocks.preview, mocks.resolveSources]) fn.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('导入运行失败时作者看不到主进程原文', () => {
  it.each(WRITES)('%s 遇到 SQLite 原文', async (channel, args, repository) => {
    repository.mockImplementation(() => { throw sqliteFailure() })
    const result = await received(channel, args)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toMatch(RAW)
    expect(shownFor(result, 'zh-CN')).toBe(CHECK_FAILED['zh-CN'])
  })

  it.each(WRITES)('%s 遇到没登记的校验码', async (channel, args, repository) => {
    repository.mockImplementation(() => { throw new Error('IMPORT_RUN_ID_CONFLICT') })
    mocks.runs.get.mockReturnValue({ locale: 'en-US' })
    const result = await received(channel, args)
    expect(JSON.stringify(result)).not.toContain('IMPORT_RUN_ID_CONFLICT')
    expect(shownFor(result, 'en-US')).toBe(CHECK_FAILED['en-US'])
  })

  it.each(READS)('%s 遇到 SQLite 原文', async (channel, args, repository) => {
    repository.mockImplementation(() => { throw sqliteFailure() })
    const rejection = await invoke(channel, ...args).then(() => undefined, (error: Error) => error)
    expect(rejection).toBeInstanceOf(Error)
    expect(rejection?.message).not.toMatch(RAW)
  })
})

describe('导入运行失败的说明与 master 逐字相同且随导入运行语言', () => {
  it('作者原稿导入不能重新开始', async () => {
    mocks.runs.restart.mockImplementation(() => { throw new Error('IMPORT_RUN_AUTHOR_RESTART_FORBIDDEN') })
    mocks.runs.get.mockReturnValue({ locale: 'en-US' })
    expect(shownFor(await received('db:import-run-restart', ['run', 'next-run', PATH]), 'en-US'))
      .toBe('An author-manuscript import cannot be restarted. Resume the original import to finish publishing and post-processing.')
    mocks.runs.get.mockReturnValue({ locale: 'zh-CN' })
    expect(shownFor(await received('db:import-run-restart', ['run', 'next-run', PATH]), 'zh-CN'))
      .toBe('作者原稿导入不能重新开始。请继续原来的这次导入，完成发布和后处理。')
  })

  it('文件检查过期', async () => {
    mocks.inspection.consume.mockImplementation(() => { throw new Error('IMPORT_INSPECTION_EXPIRED') })
    expect(shownFor(await received(...WRITES[1].slice(0, 2) as [string, readonly unknown[]]), 'en-US'))
      .toBe('The file check has expired. Choose the files again.')
  })

  it('作品已切换', async () => {
    mocks.projectPath = 'C:/projects/B'
    mocks.runs.get.mockReturnValue({ locale: 'en-US' })
    for (const [channel, args, repository] of WRITES) {
      expect(shownFor(await received(channel, args), 'en-US'), channel)
        .toBe('The project was switched or reopened, and this action belonged to the earlier session, so it was rejected. Repeat it in the project that is open now.')
      expect(repository, channel).not.toHaveBeenCalled()
    }
  })
})

describe('仓储写好的导入说明登记成目录文案后逐字不变', () => {
  it.each([
    ['IMPORT_RUN_SOURCE_OVERLAP', '另一个可恢复导入已包含相同来源，请先完成或取消该导入后重试', 'Another resumable import already contains the same source. Complete or cancel that import, then try again.'],
    ['IMPORT_RUN_AUTHOR_PREVIOUS_RUNNING', '之前的作者原稿导入仍在运行，请等待其停止后重新确认最新预览', 'The previous author import is still running. Wait for it to stop, then confirm the latest preview again.'],
    ['IMPORT_RUN_AUTHOR_STATE_CHANGED', '作者原稿导入状态已变化，请重新确认最新预览', 'The author import state changed. Confirm the latest preview again.'],
  ] as const)('%s', async (code, zh, en) => {
    mocks.runs.finalizeParsing.mockImplementation(() => { throw new Error(code) })
    const result = await received('db:import-run-finalize-parsing', ['run', PATH])
    expect(result.failure?.code).toBe(code)
    expect(shownFor(result, 'zh-CN')).toBe(zh)
    expect(shownFor(result, 'en-US')).toBe(en)
  })

  it('作者原稿预览过期时回登记码，说明是对话框原来那句', async () => {
    mocks.inspection.peek.mockReturnValue({ chapters: [] })
    mocks.preview.mockReturnValue({ authorityFingerprint: 'b'.repeat(64), manifestFingerprint: 'c'.repeat(64) })
    const result = await received('db:import-run-prepare-inspection', [{
      inspectionId: 'inspection', runId: 'run', purpose: 'author-manuscript', locale: 'zh-CN',
      authorityFingerprint: 'd'.repeat(64), manifestFingerprint: 'c'.repeat(64),
    }, PATH])
    expect(result.failure?.code).toBe('AUTHOR_IMPORT_PREVIEW_STALE')
    expect(shownFor(result, 'zh-CN')).toBe('项目或作者原稿清单已变化，请重新选择文件并确认预览。')
    expect(shownFor(result, 'en-US')).toBe('The project or author manuscript changed. Select the files again and confirm the preview.')
    expect(mocks.inspection.consume).not.toHaveBeenCalled()
  })
})

describe('主进程存进导入运行的失败原因', () => {
  it('SQLite 原文换成通用说明', () => {
    const stored = persistedImportRunFailure(sqliteFailure(), 'en-US')
    expect(stored).not.toMatch(RAW)
    expect(writtenImportFailure(stored, 'en-US')).toBe(failureText(shown('en-US'), undefined))
  })

  it('认得出的码存登记的说明', () => {
    const stored = persistedImportRunFailure(new Error('IMPORT_RUN_EXECUTION_STALE'), 'zh-CN')
    expect(writtenImportFailure(stored, 'zh-CN')).toBe(failureText(shown('zh-CN'), { code: 'IMPORT_RUN_EXECUTION_STALE' }))
  })
})
