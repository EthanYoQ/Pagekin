import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => {
  const transaction = (fn: (...args: unknown[]) => unknown) => Object.assign((...args: unknown[]) => fn(...args), { immediate: (...args: unknown[]) => fn(...args) })
  return {
    handlers: new Map<string, IpcHandler>(),
    projectPath: 'C:/projects/A',
    accessError: undefined as Error | undefined,
    db: { transaction, prepare: () => ({ run: () => undefined, all: () => [] }) },
    postProcess: { createRun: vi.fn(), getLatestRun: vi.fn(), getSteps: vi.fn(), markStepOk: vi.fn(), markStepFailed: vi.fn(), isAllCriticalPassed: vi.fn() },
    finalization: { linkKnowledgeDocument: vi.fn() },
    reviews: { create: vi.fn(), listByDraft: vi.fn(), getLatestByDraft: vi.fn(), getFull: vi.fn(), getNextIndex: vi.fn() },
    reviewCycles: { commitAuthorConfirmation: vi.fn(), getByReviewId: vi.fn() },
    revisions: { create: vi.fn(), replacePending: vi.fn(), listByDraft: vi.fn(), getPending: vi.fn(), getFull: vi.fn(), getNextIndex: vi.fn(), mergeIntoDraft: vi.fn(), markMerged: vi.fn(), markDiscarded: vi.fn() },
    drafts: { getMeta: vi.fn(), getFull: vi.fn(), updateContent: vi.fn() },
  }
})

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) } },
}))
vi.mock('../../database', () => ({
  closeProjectDatabase: vi.fn(),
  getCurrentProjectPath: () => mocks.projectPath,
  getProjectDb: () => mocks.db,
}))
vi.mock('../../services/project-access', () => ({
  projectAccess: {
    assertCurrentProjectContext: () => {
      if (mocks.accessError) throw mocks.accessError
    },
    captureCurrentSession: () => ({ projectId: 'project-A', rootPath: mocks.projectPath }),
  },
}))
vi.mock('../../services/editor-inline-generation', () => ({ validateEditorInlineInput: () => undefined }))
vi.mock('../../repositories/post-process-repository', () => ({ PostProcessRepository: mocks.postProcess }))
vi.mock('../../repositories/finalization-repository', () => ({ FinalizationRepository: mocks.finalization }))
vi.mock('../../repositories/review-repository', () => ({ ReviewRepository: mocks.reviews }))
vi.mock('../../repositories/review-cycle-repository', () => ({ ReviewCycleRepository: mocks.reviewCycles }))
vi.mock('../../repositories/revision-repository', () => ({ RevisionRepository: mocks.revisions }))
vi.mock('../../repositories/draft-repository', () => ({ DraftRepository: mocks.drafts }))

import { registerDatabaseController } from '../db-controller'
import { failureText, receivedIpcResult, resultFailure } from '../../../src/i18n/app-errors'
import { shown } from '../../../src/i18n/__tests__/shown-locale'
import { requireIpcSuccess } from '../../../src/services/ipc-result'
import { planFinalizationRetry } from '../../../src/shared/finalization-step-error'

const session = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args, session)

const sqliteFailure = () => Object.assign(new Error('database disk image is malformed'), { name: 'SqliteError', code: 'SQLITE_CORRUPT' })
const RAW = /SqliteError|malformed|SQLITE_/u
const PATH = 'C:/projects/A'
const SOURCE = { id: 7, chapterNumber: 3, version: 1, status: 'draft', content: '正文' }
const REVISION = { baseDraftId: 7, revisionType: 'review-fix', content: '修稿', wordCount: 2, expectedSource: SOURCE }

const POST_PROCESS_WRITES = [
  ['db:finalization-link-knowledge-document', [7, 'doc-1', PATH], mocks.finalization.linkKnowledgeDocument],
  ['db:post-process-create-run', [{ triggerSourceType: 'chapter_finalize', triggerSourceId: '3', sourceLabel: '第3章定稿', steps: [] }, PATH], mocks.postProcess.createRun],
  ['db:post-process-mark-step-ok', ['run-1', 'kb_import', PATH], mocks.postProcess.markStepOk],
  ['db:post-process-mark-step-failed', ['run-1', 'kb_import', 'POST_PROCESS_INTERRUPTED', PATH], mocks.postProcess.markStepFailed],
] as const

const REVIEW_WRITES = [
  ['db:review-create', [{ baseDraftId: 7, content: '审稿', expectedSource: SOURCE }, PATH], mocks.reviews.create],
  ['db:annotation-commit', [{ draftId: 7, expectedSaved: '正文', before: '正文', after: '改后', annotations: [] }, PATH], mocks.drafts.getFull],
] as const

const REVISION_WRITES = [
  ['db:revision-create', [REVISION, PATH], mocks.revisions.create],
  ['db:revision-replace-pending', [REVISION, PATH], mocks.revisions.replacePending],
  ['db:revision-merge', [{ revisionId: 1, targetDraftId: 7, expectedDraftContent: '正文', mergedContent: '修稿', wordCount: 2 }, PATH], mocks.revisions.mergeIntoDraft],
  ['db:revision-mark-merged', [1, 8, PATH], mocks.revisions.markMerged],
  ['db:revision-mark-discarded', [1, PATH], mocks.revisions.markDiscarded],
] as const

const WRITES = [...POST_PROCESS_WRITES, ...REVIEW_WRITES, ...REVISION_WRITES]

const READS = [
  ['db:post-process-get-latest-run', ['chapter_finalize', '3', PATH], mocks.postProcess.getLatestRun],
  ['db:post-process-get-steps', ['run-1', PATH], mocks.postProcess.getSteps],
  ['db:post-process-is-all-passed', ['chapter_finalize', '3', PATH], mocks.postProcess.isAllCriticalPassed],
  ['db:review-list', [7, PATH], mocks.reviews.listByDraft],
  ['db:review-get-latest', [7, PATH], mocks.reviews.getLatestByDraft],
  ['db:review-get-full', [1, PATH], mocks.reviews.getFull],
  ['db:review-next-index', [7, PATH], mocks.reviews.getNextIndex],
  ['db:review-cycle-get', [1, PATH], mocks.reviewCycles.getByReviewId],
  ['db:annotation-history-list', [7, PATH], mocks.drafts.getMeta],
  ['db:revision-list', [7, PATH], mocks.revisions.listByDraft],
  ['db:revision-get-pending', [7, PATH], mocks.revisions.getPending],
  ['db:revision-get-full', [1, PATH], mocks.revisions.getFull],
  ['db:revision-next-index', [7, PATH], mocks.revisions.getNextIndex],
] as const

type Received = Parameters<typeof resultFailure>[0] & { success: boolean }

async function received(channel: string, args: readonly unknown[]): Promise<Received> {
  return receivedIpcResult(await invoke(channel, ...args)) as Received
}

const text = (locale: 'zh-CN' | 'en-US', result: Received) => failureText(shown(locale), resultFailure(result))
/** master 上 revision-merge 不在写通道集合里，会话门禁的码随抛出过来；作者看到的说明按同一个码查。 */
const zhShown = async (channel: string, args: readonly unknown[]) => text('zh-CN', await received(channel, args).catch((error: Error) => ({ success: false, error: error.message })))
const STALE = '项目已切换或重新打开，这次操作属于之前打开的项目，已拒绝执行。请在当前打开的项目里重新操作。'

beforeAll(() => registerDatabaseController())

beforeEach(() => {
  mocks.projectPath = PATH
  mocks.accessError = undefined
  for (const group of [mocks.postProcess, mocks.finalization, mocks.reviews, mocks.reviewCycles, mocks.revisions, mocks.drafts]) {
    for (const fn of Object.values(group)) fn.mockReset()
  }
  mocks.drafts.getFull.mockReturnValue({ id: 7, status: 'draft', content: '正文' })
  mocks.drafts.getMeta.mockReturnValue({ id: 7 })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('定稿后处理、审稿与修订失败时作者看不到主进程原文', () => {
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

  it.each([
    [POST_PROCESS_WRITES, '正文定稿已保存。定稿后处理的进度没能写进作品，请再试一次。'],
    [REVIEW_WRITES, '正文没有改动。这次审稿或批注没能写进作品，请再试一次。'],
    [REVISION_WRITES, '草稿正文没有改动。这次修稿没能写进作品，请再试一次。'],
  ] as const)('每组的写失败说明先写保住了什么', async (writes, expected) => {
    for (const [channel, args, repository] of writes) {
      repository.mockImplementation(() => { throw sqliteFailure() })
      expect(text('zh-CN', await received(channel, args)), channel).toBe(expected)
    }
  })
})

describe('审稿与修订失败的说明与 master 逐字相同', () => {
  it('会话已换', async () => {
    mocks.accessError = new Error('PROJECT_SESSION_STALE')
    for (const [channel, args] of WRITES) expect(await zhShown(channel, args), channel).toBe(STALE)
  })

  it('作品路径对不上', async () => {
    mocks.projectPath = 'C:/projects/B'
    for (const [channel, args] of WRITES) expect(await zhShown(channel, args), channel).toBe(STALE)
  })

  it('修订稿已处理过', async () => {
    mocks.revisions.markDiscarded.mockImplementation(() => { throw new Error('REVISION_NOT_PENDING') })
    expect(text('zh-CN', await received('db:revision-mark-discarded', [1, PATH]))).toBe('这份修订稿已经处理过（已合并或已丢弃），请刷新后再看。')
  })

  it('审稿确认期间源草稿变了，调用点仍认得出这个码', async () => {
    mocks.reviews.create.mockImplementation(() => { throw new Error('SOURCE_DRAFT_CHANGED') })
    expect(resultFailure(await received(...REVIEW_WRITES[0].slice(0, 2) as [string, readonly unknown[]]))?.code).toBe('SOURCE_DRAFT_CHANGED')
  })

  it('批注保存时稿已定稿，调用点仍认得出这个码', async () => {
    mocks.drafts.getFull.mockReturnValue({ id: 7, status: 'final', content: '正文' })
    expect(resultFailure(await received(...REVIEW_WRITES[1].slice(0, 2) as [string, readonly unknown[]]))?.code).toBe('DRAFT_NOT_WRITABLE')
  })

  it('读通道照旧抛出已登记的码', async () => {
    mocks.projectPath = 'C:/projects/B'
    for (const [channel, args] of READS) {
      const rejection = await invoke(channel, ...args).then(() => undefined, (error: Error) => error)
      expect(rejection?.message, channel).toMatch(/^PROJECT_/u)
    }
  })
})

describe('定稿后处理的重试规则不变', () => {
  const plan = (error: string) => {
    const { rows, card } = planFinalizationRetry({ kb_import: { ok: false, error }, chapter_notes: { ok: true } })
    return { rows: [...rows], card }
  }
  const storedStepError = async (failure: () => never) => {
    mocks.finalization.linkKnowledgeDocument.mockImplementation(failure)
    try {
      requireIpcSuccess(await received('db:finalization-link-knowledge-document', [7, 'doc-1', PATH]) as Received & { success: boolean }, '登记定稿知识文档身份')
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    throw new Error('登记应当失败')
  }

  it.each([
    ['SQLite 原文', () => { throw sqliteFailure() }],
    ['定稿记录不在了', () => { throw new Error('FINALIZATION_COMMIT_NOT_FOUND') }],
  ] as const)('登记知识文档失败（%s）后，存下的步骤原因仍按可重试处理', async (_name, failure) => {
    expect(plan(await storedStepError(failure as () => never))).toEqual({ rows: [['kb_import', ['kb_import']]], card: ['kb_import'] })
  })
})
