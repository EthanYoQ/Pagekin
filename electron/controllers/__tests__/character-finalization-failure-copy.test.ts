import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>
type Fail = ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>

const PATH = 'C:/projects/A'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  owner: {} as Record<string, unknown>,
  finalize: undefined as unknown as Fail,
  retry: undefined as unknown as Fail,
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) } },
}))
vi.mock('../../database', () => ({
  getProjectDb: () => ({}),
  getCurrentProjectPath: () => 'C:/projects/A',
  onProjectDatabaseBeforeClose: () => undefined,
}))
vi.mock('../../services/project-access', async importOriginal => ({
  ...await importOriginal<object>(),
  projectAccess: { assertCurrentProjectContext: () => ({ rootPath: 'C:/projects/A', projectId: 'project-A' }) },
}))
vi.mock('../../services/main-generation-owner', () => ({ createMainGenerationOwner: () => mocks.owner }))
vi.mock('../../services/finalization-service', () => ({
  FinalizationService: class {
    finalize = (...args: unknown[]) => mocks.finalize(...args)
    retry = (...args: unknown[]) => mocks.retry(...args)
  },
}))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => 'C:/global' }))
vi.mock('../../services/project-data-locator', () => ({ getProjectDataRoot: () => 'C:/projects/A/.data' }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => null, getRerankConfig: () => ({ kind: 'none', reason: 'not-configured' }) }))

import { registerGenerationController } from '../generation-controller'
import { registerFinalizationController } from '../finalization-controller'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { appErrorMessage, displayedErrorMessage, receivedIpcResult } from '../../../src/i18n/app-errors'
import { workflowMainProcessError } from '../../../src/services/workflows/workflow-project-session'
import type { Failure } from '../../../src/shared/failure'
import type { InterfaceLocale } from '../../../src/i18n/types'
import { shown } from '../../../src/i18n/__tests__/shown-locale'

const session = { projectId: 'project-A', leaseId: 'lease-A', projectPath: PATH }
const event = { sender: { isDestroyed: () => false, send: vi.fn() } }
const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!(event, ...args, session)
const snapshot = { tabId: 'tab-3', projectPath: PATH, projectSession: session, draftId: 7, chapterNumber: 3, chapterTitle: '雾钟', content: '正文', contentRevision: 0 }

const sqliteFailure = () => Object.assign(new Error('database disk image is malformed'), { name: 'SqliteError', code: 'SQLITE_CORRUPT' })
const RAW = /SqliteError|malformed|SQLITE_|EBUSY|C:[\\/]|CHARACTER_APPROVAL_INVALID/u

async function thrownText(pending: Promise<unknown>, locale: InterfaceLocale, show: typeof appErrorMessage = appErrorMessage): Promise<string> {
  const error = await pending.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(Error)
  return show(shown(locale), error)
}

/** 定稿结果有 failure 时按定稿命令的显法（通用码让给概述），没有就像 master 那样把 error 当原因。 */
async function finalizationText(pending: Promise<unknown>, locale: InterfaceLocale, summary: readonly [string, string]): Promise<string> {
  const result = receivedIpcResult(await pending) as { success: boolean; failure?: Failure; error?: string }
  expect(result.success).toBe(false)
  const reason = 'failure' in result
    ? (await import('../../../src/services/finalization-client')).finalizationFailure(result as never)
    : result.error
  return workflowMainProcessError(shown(locale), reason, summary[0] as '定稿事务未提交', summary[1] as 'The finalization transaction was not committed.').message
}

const NOT_COMMITTED = ['定稿事务未提交', 'The finalization transaction was not committed.'] as const
const PUBLICATION_PENDING = ['定稿已提交、实体稿待发布', 'Finalization was committed, but manuscript publication is still pending.'] as const
const NOT_REPUBLISHED = ['实体稿没有重新发布', 'The manuscript was not published again.'] as const

const ownerFails = (method: string, error: Error) => { mocks.owner[method] = vi.fn(() => { throw error }) }

beforeAll(() => {
  registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => null }), loadModel: () => null, rememberContextWindow: () => {} })
  registerFinalizationController()
})

beforeEach(() => {
  mocks.owner = { suspendForProjectClose: vi.fn(), characterProposals: {} }
  mocks.finalize = vi.fn()
  mocks.retry = vi.fn()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => { vi.restoreAllMocks() })

const AUTHOR_ACTIONS: ReadonlyArray<readonly [string, (locale: InterfaceLocale) => Promise<string>]> = [
  ['定稿时作品库写坏', locale => { mocks.finalize.mockRejectedValue(sqliteFailure()); return finalizationText(invoke('finalization:commit', snapshot), locale, NOT_COMMITTED) }],
  ['定稿服务回 SQLite 原文', locale => {
    mocks.finalize.mockResolvedValue({ success: false, committed: false, draftId: 7, error: String(sqliteFailure()) })
    return finalizationText(invoke('finalization:commit', snapshot), locale, NOT_COMMITTED)
  }],
  ['实体稿写不进去', locale => {
    mocks.finalize.mockResolvedValue({ success: false, committed: true, finalizationId: 'f-3', contentHash: 'h', draftId: 7, publicationStatus: 'pending',
      error: "Error: EBUSY: resource busy or locked, open 'C:\\projects\\A\\正文\\第3章 雾钟.txt'" })
    return finalizationText(invoke('finalization:commit', snapshot), locale, PUBLICATION_PENDING)
  }],
  ['重试实体稿时读不出定稿记录', locale => {
    mocks.retry.mockResolvedValue({ success: false, committed: false, error: String(sqliteFailure()) })
    return finalizationText(invoke('finalization:retry', 'f-3'), locale, NOT_REPUBLISHED)
  }],
  ['采纳角色提议时作品库写坏', locale => { ownerFails('approveCharacterProposal', sqliteFailure()); return thrownText(invoke('character-proposal:approve', {}), locale) }],
  ['采纳角色提议遇到内部校验码', locale => { ownerFails('approveCharacterProposal', new Error('CHARACTER_APPROVAL_INVALID')); return thrownText(invoke('character-proposal:approve', {}), locale) }],
  ['采纳角色状态建议时作品库写坏', locale => { ownerFails('decideFinalizedCharacterStateCandidate', sqliteFailure()); return thrownText(invoke('finalized-character:decide-state-candidate', {}), locale) }],
  ['保存审稿时作品库写坏', locale => { ownerFails('commitReview', sqliteFailure()); return thrownText(invoke('review-revision:commit-review', {}), locale, displayedErrorMessage) }],
  ['沿用旧角色卡时作品库写坏', locale => { ownerFails('adoptLegacyCards', sqliteFailure()); return thrownText(invoke('legacy-roster:adopt-existing', {}), locale, displayedErrorMessage) }],
]

describe('角色、审稿修订与定稿通道失败时作者看不到主进程原文', () => {
  it.each(AUTHOR_ACTIONS.flatMap(([name, shownText]) => (['zh-CN', 'en-US'] as const).map(locale => [name, locale, shownText] as const)))(
    '%s（%s）', async (_name, locale, shownText) => {
      const text = await shownText(locale)
      expect(text).not.toMatch(RAW)
      expect(text.trim()).not.toBe('')
    },
  )
})

const VERBATIM: ReadonlyArray<readonly [string, () => Promise<string>, string]> = [
  ['角色提议依据的设定变了', () => { ownerFails('approveCharacterProposal', new Error('CHARACTER_PROPOSAL_SOURCE_CHANGED')); return thrownText(invoke('character-proposal:approve', {}), 'zh-CN') },
    '生成期间，它依据的设定、蓝图或前文有了变化，结果没有保存。请重新生成。'],
  ['角色状态在建议后被改过', () => { ownerFails('decideFinalizedCharacterStateCandidate', new Error('FINALIZED_CHARACTER_STATE_FIELD_CONFLICT')); return thrownText(invoke('finalized-character:decide-state-candidate', {}), 'zh-CN') },
    '这个角色的这项状态在建议生成后被改过，本次没有采用。刷新后重新判断。'],
  ['审稿期间原稿被改', () => { ownerFails('commitReview', new Error('SOURCE_DRAFT_CHANGED')); return thrownText(invoke('review-revision:commit-review', {}), 'zh-CN', displayedErrorMessage) },
    '原稿在 AI 处理期间被改动，结果没有保存。请重新打开当前稿后再试。'],
  ['沿用旧角色卡时来源变了', () => { ownerFails('adoptLegacyCards', new Error('LEGACY_ROSTER_ADOPTION_SOURCE_CHANGED')); return thrownText(invoke('legacy-roster:adopt-existing', {}), 'zh-CN', displayedErrorMessage) },
    '生成期间，它依据的设定、蓝图或前文有了变化，结果没有保存。请重新生成。'],
  ['生成请求没有码的失败', () => { ownerFails('approveCharacterProposal', new RangeError('Invalid array length')); return thrownText(invoke('character-proposal:approve', {}), 'zh-CN') },
    '生成请求在保存结果前出错，本次结果没有保存。请重试；如果反复出现，请把这条提示和出错时间反馈给我们。'],
  ['这一稿已用不同内容定稿', () => {
    mocks.finalize.mockResolvedValue({ success: false, committed: false, error: 'FINALIZATION_COMMIT_CONFLICT' })
    return finalizationText(invoke('finalization:commit', snapshot), 'zh-CN', NOT_COMMITTED)
  }, '定稿事务未提交：这一稿已经用不同的内容定稿过，已拒绝覆盖。请刷新后查看已定稿的正文。'],
  ['重试时定稿记录已不在', () => {
    mocks.retry.mockResolvedValue({ success: false, committed: false, finalizationId: 'f-3', error: 'FINALIZATION_COMMIT_NOT_FOUND' })
    return finalizationText(invoke('finalization:retry', 'f-3'), 'zh-CN', NOT_REPUBLISHED)
  }, '实体稿没有重新发布：这一章的定稿记录已经不在了（可能已被删除），请刷新后再看。'],
  ['英文界面定稿失败只说概述', () => {
    mocks.finalize.mockRejectedValue(sqliteFailure())
    return finalizationText(invoke('finalization:commit', snapshot), 'en-US', NOT_COMMITTED)
  }, 'The finalization transaction was not committed.'],
]

describe('角色提议、定稿角色与审稿修订失败的说明与 master 逐字相同', () => {
  it.each(VERBATIM)('%s', async (_name, shownText, expected) => {
    expect(await shownText()).toBe(expected)
  })
})
