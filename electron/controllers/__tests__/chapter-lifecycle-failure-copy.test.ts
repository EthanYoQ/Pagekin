import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  accessError: undefined as Error | undefined,
  reopen: vi.fn(),
  removeKnowledge: vi.fn(),
  removeManuscripts: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) } },
}))
vi.mock('../../database', () => ({
  getCurrentProjectPath: () => 'C:/projects/A',
  getProjectDb: () => null,
}))
vi.mock('../../services/project-access', () => ({
  projectAccess: {
    assertCurrentProjectContext: () => {
      if (mocks.accessError) throw mocks.accessError
      return { rootPath: 'C:/projects/A', projectId: 'project-A' }
    },
  },
}))
vi.mock('../../services/chapter-reopen-service', () => ({ reopenFinalizedChapter: mocks.reopen }))
vi.mock('../../services/replaced-final-cleanup', () => ({
  removeReplacedKnowledge: mocks.removeKnowledge,
  removeReplacedManuscripts: mocks.removeManuscripts,
}))

import { registerChapterLifecycleController } from '../chapter-lifecycle-controller'
import type { ChapterDeletionService } from '../../services/chapter-deletion-service'
import { displayedErrorMessage, failureText, receivedIpcResult } from '../../../src/i18n/app-errors'
import type { Failure } from '../../../src/shared/failure'
import type { InterfaceLocale } from '../../../src/i18n/types'
import { shown } from '../../../src/i18n/__tests__/shown-locale'
import type { WorkflowContext } from '../../../src/stores/workflow-store'
import { buildFinalizePostProcessSteps } from '../../../src/services/workflows/commands/finalize-chapter.command'

const PATH = 'C:/projects/A'
const session = { projectId: 'project-A', leaseId: 'lease-A', projectPath: PATH }
const service = {
  delete: vi.fn(),
  retry: vi.fn(),
  confirmLegacyKnowledgeAbsent: vi.fn(),
  restore: vi.fn(),
  purge: vi.fn(),
  listTrash: vi.fn(),
  listIncomplete: vi.fn(),
}
const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args, PATH, session)

/** 有 failure 按 failureText 说明，没有就像侧栏删除、重试清理与重开那样把 error 交给 displayedErrorMessage，同一断言在 master 上才会红。 */
async function shownToAuthor(raw: unknown, locale: InterfaceLocale): Promise<string> {
  const result = receivedIpcResult(await raw) as { success: boolean; failure?: Failure; error?: string }
  expect(result.success).toBe(false)
  return result.failure ? failureText(shown(locale), result.failure) : displayedErrorMessage(shown(locale), result.error)
}

const sqliteFailure = () => Object.assign(new Error('database disk image is malformed'), { name: 'SqliteError', code: 'SQLITE_CORRUPT' })
const RAW = /SqliteError|malformed|SQLITE_/u

const thrownBy = (method: keyof typeof service, channel: string, ...args: unknown[]) => (error: Error) => {
  service[method].mockRejectedValue(error)
  return invoke(channel, ...args)
}
const reopenThrows = (error: Error) => {
  mocks.reopen.mockImplementation(() => { throw error })
  return invoke('chapter:reopen', { chapterNumber: 3 })
}

const AUTHOR_ACTIONS: ReadonlyArray<readonly [string, (error: Error) => unknown]> = [
  ['删除正文', thrownBy('delete', 'chapter:delete-finalized', { draftId: 7, chapterNumber: 3 })],
  ['确认人工核对后继续删除', thrownBy('confirmLegacyKnowledgeAbsent', 'chapter:confirm-legacy-knowledge-absent', 'operation-1')],
  ['重试清理', thrownBy('retry', 'chapter:retry-deletion', 'operation-1')],
  ['重新打开修改', reopenThrows],
]

beforeAll(() => {
  registerChapterLifecycleController(service as unknown as ChapterDeletionService)
})

beforeEach(() => {
  mocks.accessError = undefined
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('章节生命周期失败时作者看不到主进程原文', () => {
  it.each(AUTHOR_ACTIONS.flatMap(([name, fail]) => (['zh-CN', 'en-US'] as const).map(locale => [name, locale, fail] as const)))(
    '%s（%s）遇到 SQLite 原文', async (_name, locale, fail) => {
      const text = await shownToAuthor(fail(sqliteFailure()), locale)
      expect(text).not.toMatch(RAW)
      expect(text.trim()).not.toBe('')
    },
  )
})

const VERBATIM: ReadonlyArray<readonly [string, () => unknown, string]> = [
  ['作品已切换', () => { mocks.accessError = new Error('PROJECT_SESSION_STALE'); return invoke('chapter:delete-finalized', { draftId: 7, chapterNumber: 3 }) },
    '项目已切换或重新打开，这次操作属于之前打开的项目，已拒绝执行。请在当前打开的项目里重新操作。'],
  ['删除记录已不在', () => thrownBy('retry', 'chapter:retry-deletion', 'operation-1')(new Error('CHAPTER_DELETE_OPERATION_NOT_FOUND')),
    '这次删除的记录已经不在了（可能已经完成或被清理），请刷新后再看。'],
  ['旧项目的删除记录', () => thrownBy('confirmLegacyKnowledgeAbsent', 'chapter:confirm-legacy-knowledge-absent', 'operation-1')(new Error('CHAPTER_DELETE_LEGACY_CONFIRMATION_CONSUMED')),
    '这次删除的人工核对已经确认过，不能再确认一次。请刷新后查看删除进度。'],
  ['知识库组件不可用', () => thrownBy('delete', 'chapter:delete-finalized', { draftId: 7, chapterNumber: 3 })(new Error('KNOWLEDGE_BASE_NATIVE_UNAVAILABLE')),
    '知识库不可用：Windows 原生组件加载失败。请重新安装或下载完整发布包。'],
  ['重开稿已经开着', () => reopenThrows(new Error('CHAPTER_REOPEN_ALREADY_OPEN')),
    '这一章已有一份正在修改的重开稿。请先定稿或放弃它，再回退到别的版本。'],
  ['批量写作没写完', () => reopenThrows(new Error('CHAPTER_REOPEN_BATCH_UNFINISHED')),
    '这一章属于一次还没写完的批量写作，现在重开会让它无法继续。请先在运行侧页写完批量写作，再重开。'],
]

describe('章节生命周期失败的说明与 master 逐字相同', () => {
  it.each(VERBATIM)('%s', async (_name, fail, expected) => {
    expect(await shownToAuthor(fail(), 'zh-CN')).toBe(expected)
  })
})

function cleanupContext(): WorkflowContext {
  return { runId: 'cleanup', projectPath: PATH, projectSession: session, uiLocale: 'zh-CN', interfaceLocale: shown('zh-CN'), writingLanguage: 'zh-CN', data: {}, cancelled: false }
}

const STEP_CODES = [
  ['remove_replaced_knowledge', mocks.removeKnowledge, 'FINALIZATION_REPLACED_KNOWLEDGE_IMPORT_REQUIRED'],
  ['remove_replaced_knowledge', mocks.removeKnowledge, 'FINALIZATION_REPLACED_KNOWLEDGE_EDITED'],
  ['remove_replaced_knowledge', mocks.removeKnowledge, 'FINALIZATION_REPLACED_KNOWLEDGE_NOT_REMOVED'],
  ['remove_replaced_knowledge', mocks.removeKnowledge, 'KNOWLEDGE_BASE_VOLUME_UNSUPPORTED'],
  ['remove_replaced_manuscripts', mocks.removeManuscripts, 'FINALIZATION_REPLACED_MANUSCRIPT_PUBLICATION_REQUIRED'],
  ['remove_replaced_manuscripts', mocks.removeManuscripts, 'FINALIZATION_REPLACED_MANUSCRIPT_KEPT:["第1章 雾钟.txt"]'],
  ['remove_replaced_manuscripts', mocks.removeManuscripts, 'FINALIZATION_REPLACED_MANUSCRIPT_BUSY:["第1章 雾钟.txt","第1章 雾钟 (2).txt"]'],
] as const

describe('被替换旧定稿的清理步骤记下的码与 master 相同', () => {
  it.each(STEP_CODES)('%s：%s', async (key, remove, code) => {
    remove.mockRejectedValue(new Error(code))
    vi.stubGlobal('window', { aiNovelAPI: { invoke: (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args) } })
    const step = buildFinalizePostProcessSteps({ path: PATH }, 1, '雾钟', '正文', { complete: async () => { throw new Error('unused') } }, 42, [], 'zh-CN',
      undefined, undefined, undefined, true).find(candidate => candidate.key === key)!
    const recorded = await step.executor({ log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }, cleanupContext()).then(() => '', (error: Error) => error.message)
    expect(recorded).toBe(code)
  })
})
