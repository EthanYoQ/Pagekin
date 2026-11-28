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

import { readFileSync } from 'node:fs'
import { registerDatabaseController } from '../db-controller'
import { failureText, receivedIpcResult, resultFailure } from '../../../src/i18n/app-errors'
import { shown } from '../../../src/i18n/__tests__/shown-locale'
import { plotWriteFailureText } from '../../../src/components/stage/plot/plot-write-failure'
import { note } from '../../../src/shared/failure'
import { useLocaleStore } from '../../../src/stores/locale-store'

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
    expect(zhText(result)).toBe('已有的线索和剧情树都还在。这次修改没能写进作品，请刷新后再试一次。')
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

const REPOSITORY_CODES = [...new Set([...readFileSync(new URL('../../repositories/narrative-thread-repository.ts', import.meta.url), 'utf8')
  .matchAll(/new Error\('([A-Z][A-Z0-9_]+)'\)/gu)].map(match => match[1]!))]
const WRITE_FAILED = '已有的线索和剧情树都还在。这次修改没能写进作品，请刷新后再试一次。'
const ENTRY_FALLBACK = '保存叙事线索失败'
const CODE_SHAPE = /[A-Z][A-Z0-9]*_[A-Z0-9_]+/u

async function shownAtEntry(code: string, locale: 'zh-CN' | 'en-US' | 'ja-JP'): Promise<string> {
  mocks.threads.createPlan.mockImplementation(() => { throw new Error(code) })
  const result = await received(...WRITES[0].slice(0, 2) as [string, readonly unknown[]])
  const original = useLocaleStore.getState()
  useLocaleStore.setState({ interfaceLocale: locale, locale: locale === 'zh-CN' ? 'zh-CN' : 'en-US' })
  try {
    return plotWriteFailureText(result, note(ENTRY_FALLBACK, 'Could not save narrative thread'))
  } finally {
    useLocaleStore.setState(original, true)
  }
}

describe('叙事线仓储拒绝写入时说明具体原因（#909）', () => {
  it('仓储能抛出的每个码在入口处都有自己的说明，不落到写失败句或入口兜底句', async () => {
    expect(REPOSITORY_CODES).toEqual(expect.arrayContaining(['NARRATIVE_THREAD_PLAN_INVALID', 'NARRATIVE_THREAD_RANGE_INVALID']))
    for (const code of REPOSITORY_CODES) {
      const shownText = await shownAtEntry(code, 'zh-CN')
      expect(shownText, code).not.toBe(WRITE_FAILED)
      expect(shownText, code).not.toBe(ENTRY_FALLBACK)
      expect(shownText, code).not.toBe('出了意外问题，暂时说不清原因。请再试一次。')
    }
  })

  it.each([
    ['NARRATIVE_THREAD_PLAN_INVALID', {
      'zh-CN': '这条线索没有保存。名称、类型和「你的打算」都要填，名称最多 120 字，类型最多 60 字，「你的打算」最多 1000 字。',
      'en-US': 'This thread was not saved. Fill in the name, kind and intent. The name can be up to 120 characters, the kind up to 60, and the intent up to 1000.',
      'ja-JP': 'この伏線は保存されませんでした。名前・種類・意図をすべて入力してください。名前は 120 字、種類は 60 字、意図は 1000 字までです。',
    }],
    ['NARRATIVE_THREAD_RANGE_INVALID', {
      'zh-CN': '章节号不对，这次修改没有保存。章节号要是从 1 开始的整数，回收章不能早于埋设章。',
      'en-US': 'A chapter number is not valid, so this change was not saved. Use whole numbers from 1, and the payoff chapter cannot come before the planted chapter.',
      'ja-JP': '章番号が正しくないため、この変更は保存されませんでした。章番号は 1 以上の整数にし、回収章を設置章より前にしないでください。',
    }],
  ] as const)('%s 说明哪里不对、怎么改', async (code, expected) => {
    for (const locale of ['zh-CN', 'en-US', 'ja-JP'] as const) {
      const shownText = await shownAtEntry(code, locale)
      expect(shownText, locale).toBe(expected[locale])
      expect(shownText, locale).not.toMatch(CODE_SHAPE)
    }
    expect(await shownAtEntry(code, 'ja-JP')).not.toMatch(/[A-Za-z]/u)
  })
})
