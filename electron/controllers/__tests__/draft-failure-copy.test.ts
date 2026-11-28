import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  projectPath: 'C:/projects/A',
  accessError: undefined as Error | undefined,
  drafts: {
    create: vi.fn(), listByChapter: vi.fn(), listAll: vi.fn(), getMeta: vi.fn(), getFull: vi.fn(),
    getLatestByChapter: vi.fn(), getFinalizedByChapter: vi.fn(), getMaxFinalizedChapter: vi.fn(),
    getNextVersion: vi.fn(), updateStatus: vi.fn(), updateContent: vi.fn(), delete: vi.fn(),
  },
  imports: { commit: vi.fn(), authoritySequence: vi.fn() },
  finalization: { listAuthoritativeForExport: vi.fn(), matchesAuthoritativeExportReceipt: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn() },
  finalizedDeletion: vi.fn(),
  loadChapterDrafts: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) } },
}))
vi.mock('../../database', () => ({
  closeProjectDatabase: vi.fn(),
  getCurrentProjectPath: () => mocks.projectPath,
  getProjectDb: () => ({}),
}))
vi.mock('../../services/project-access', () => ({
  projectAccess: {
    assertCurrentProjectContext: () => {
      if (mocks.accessError) throw mocks.accessError
    },
    assertCurrentSession: () => undefined,
    captureCurrentSession: () => ({ projectId: 'project-A', leaseId: 'lease-A', rootPath: mocks.projectPath }),
  },
}))
vi.mock('../../repositories/draft-repository', () => ({ DraftRepository: mocks.drafts }))
vi.mock('../../repositories/finalized-draft-import-repository', () => ({ FinalizedDraftImportRepository: mocks.imports }))
vi.mock('../../repositories/finalization-repository', () => ({ FinalizationRepository: mocks.finalization }))
vi.mock('../../../src/services/ipc-client', () => ({
  ipc: {
    invokeWithProjectSession: async (session: unknown, channel: string, ...args: unknown[]) =>
      receivedIpcResult(await mocks.handlers.get(channel)!({}, ...args, session)),
  },
}))
vi.mock('../../../src/components/ui/Toast', () => ({ toast: mocks.toast }))
vi.mock('../../../src/components/project-session-gate', () => ({
  captureProjectSession: () => ({ projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }),
  isProjectSessionCurrent: () => true,
  isProjectSessionPath: () => true,
}))
vi.mock('../../../src/components/panels/sidebar/finalized-chapter-deletion', () => ({ deleteFinalizedChapter: mocks.finalizedDeletion }))
vi.mock('../../../src/stores/draft-store', () => ({ useDraftStore: { getState: () => ({ loadChapterDrafts: mocks.loadChapterDrafts }) } }))

import { registerDatabaseController } from '../db-controller'
import { failureText, receivedIpcResult, resultFailure } from '../../../src/i18n/app-errors'
import { shown } from '../../../src/i18n/__tests__/shown-locale'
import { deleteDraftVersion } from '../../../src/components/panels/sidebar/draft-deletion'
import { useLocaleStore } from '../../../src/stores/locale-store'

const session = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args, session)

const sqliteFailure = () => Object.assign(new Error('database disk image is malformed'), { name: 'SqliteError', code: 'SQLITE_CORRUPT' })
const RAW = /SqliteError|malformed|SQLITE_/u
const PATH = 'C:/projects/A'
const DRAFT = { id: 7, chapterNumber: 3, version: 2, status: 'draft' }
const CREATE = { chapterNumber: 3, version: 2, source: 'write', content: '雾钟响了三声。', wordCount: 7 }
const IMPORT = { operationId: 'op-1', chapters: [{ chapterNumber: 1, title: '潮门', content: '正文', wordCount: 2 }] }

const AUTHOR_WRITES = [
  ['db:draft-create', [CREATE, PATH], mocks.drafts.create],
  ['db:draft-update-status', [7, 'reviewed', undefined, PATH], mocks.drafts.updateStatus],
  ['db:draft-update-content', [7, '作者改的字', 5, PATH], mocks.drafts.updateContent],
  ['db:draft-delete', [7, PATH], mocks.drafts.delete],
] as const

const WRITES = [...AUTHOR_WRITES, ['db:draft-import-finalized-batch', [IMPORT, PATH], mocks.imports.commit]] as const

const READS = [
  ['db:draft-list', [3, PATH], mocks.drafts.listByChapter],
  ['db:draft-list-all', [PATH], mocks.drafts.listAll],
  ['db:draft-get-meta', [7, PATH], mocks.drafts.getMeta],
  ['db:draft-get-full', [7, PATH], mocks.drafts.getFull],
  ['db:draft-get-latest', [3, PATH], mocks.drafts.getLatestByChapter],
  ['db:draft-get-finalized', [3, PATH], mocks.drafts.getFinalizedByChapter],
  ['db:draft-get-max-finalized-chapter', [PATH], mocks.drafts.getMaxFinalizedChapter],
  ['db:draft-authority-sequence', [PATH], mocks.imports.authoritySequence],
  ['db:draft-export-snapshot', [PATH], mocks.finalization.listAuthoritativeForExport],
  ['db:draft-export-authority-current', [{ receiptId: 'r-1' }, PATH], mocks.finalization.matchesAuthoritativeExportReceipt],
  ['db:draft-next-version', [3, PATH], mocks.drafts.getNextVersion],
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
  for (const group of [mocks.drafts, mocks.imports, mocks.finalization, mocks.toast]) {
    for (const fn of Object.values(group)) fn.mockReset()
  }
  mocks.finalizedDeletion.mockReset()
  mocks.loadChapterDrafts.mockReset()
  mocks.drafts.getMeta.mockReturnValue(DRAFT)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('草稿通道失败时作者看不到主进程原文', () => {
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

  it('作者能走到的写失败，说明先写保住了什么', async () => {
    for (const [channel, args, repository] of AUTHOR_WRITES) {
      repository.mockImplementation(() => { throw sqliteFailure() })
      expect(text('zh-CN', await received(channel, args)), channel).toBe('已存的稿件都还在。这次改动没有保存成功，请再试一次。')
    }
  })

  it('删除这一稿失败时，提示里没有原文', async () => {
    mocks.drafts.delete.mockImplementation(() => { throw sqliteFailure() })
    useLocaleStore.setState({ locale: 'en-US' })
    try {
      expect(await deleteDraftVersion({ draft: DRAFT as never, displayName: 'Chapter 3 v2', projectKey: PATH, project: null })).toBe(false)
    } finally {
      useLocaleStore.setState({ locale: 'zh-CN' })
    }
    expect(mocks.toast.error).toHaveBeenCalledTimes(1)
    expect(String(mocks.toast.error.mock.calls[0][0])).not.toMatch(RAW)
  })
})

describe('草稿失败的说明与 master 逐字相同', () => {
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

  it('这份草稿已经不在了', async () => {
    mocks.drafts.getMeta.mockReturnValue(null)
    expect(await zhShown('db:draft-update-content', [7, '作者改的字', 5, PATH])).toBe('这份草稿已经不在了（可能已被删除），本次修改没有保存。')
  })

  it('这一章已经定稿', async () => {
    mocks.drafts.updateContent.mockImplementation(() => { throw new Error('DRAFT_FINALIZED_READ_ONLY') })
    expect(await zhShown('db:draft-update-content', [7, '作者改的字', 5, PATH])).toBe('这一章已经定稿，定稿正文是只读的，本次修改没有保存。')
  })

  it('依赖的前文变了', async () => {
    mocks.drafts.create.mockImplementation(() => { throw new Error('GENERATION_DRAFT_DEPENDENCY_STALE') })
    expect(resultFailure(await received('db:draft-create', [CREATE, PATH]))?.code).toBe('GENERATION_DRAFT_DEPENDENCY_STALE')
  })

  it('读通道照旧抛出已登记的码', async () => {
    mocks.projectPath = 'C:/projects/B'
    for (const [channel, args] of READS) {
      const rejection = await invoke(channel, ...args).then(() => undefined, (error: Error) => error)
      expect(rejection?.message, channel).toMatch(/^PROJECT_/u)
    }
  })
})

describe('草稿写入、版本与定稿权威判定不变', () => {
  it('写通道成功时原样回结果', async () => {
    mocks.drafts.create.mockReturnValue(41)
    mocks.imports.commit.mockReturnValue({ operationId: 'op-1', drafts: [] })
    expect(await received('db:draft-create', [CREATE, PATH])).toEqual({ success: true, id: 41 })
    expect(mocks.drafts.create).toHaveBeenCalledWith(CREATE)
    expect(await received('db:draft-update-status', [7, 'reviewed', 9, PATH])).toEqual({ success: true })
    expect(mocks.drafts.updateStatus).toHaveBeenCalledWith(7, 'reviewed', 9)
    expect(await received('db:draft-update-content', [7, '作者改的字', 5, PATH])).toEqual({ success: true })
    expect(mocks.drafts.updateContent).toHaveBeenCalledWith(7, '作者改的字', 5)
    expect(await received('db:draft-delete', [7, PATH])).toEqual({ success: true })
    expect(mocks.drafts.delete).toHaveBeenCalledWith(7)
    expect(await received('db:draft-import-finalized-batch', [IMPORT, PATH])).toEqual({ success: true, receipt: { operationId: 'op-1', drafts: [] } })
    expect(mocks.imports.commit).toHaveBeenCalledWith(PATH, IMPORT)
  })

  it('读通道原样回版本号与定稿权威', async () => {
    const authority = { status: 'contiguous', authorityFingerprint: 'fp-1', chapters: [] }
    mocks.drafts.getNextVersion.mockReturnValue(3)
    mocks.imports.authoritySequence.mockReturnValue(authority)
    mocks.finalization.matchesAuthoritativeExportReceipt.mockReturnValue(true)
    expect(await invoke('db:draft-next-version', 3, PATH)).toBe(3)
    expect(await invoke('db:draft-authority-sequence', PATH)).toEqual(authority)
    expect(await invoke('db:draft-export-authority-current', { receiptId: 'r-1' }, PATH)).toBe(true)
  })

  it('这一稿其实已定稿时，删除转交定稿删除流程', async () => {
    mocks.drafts.delete.mockImplementation(() => {
      throw Object.assign(new Error('FINALIZED_DRAFT_DELETE_REQUIRED'), { code: 'FINALIZED_DRAFT_DELETE_REQUIRED' })
    })
    expect(await deleteDraftVersion({ draft: DRAFT as never, displayName: '第 3 章 v2', projectKey: PATH, project: null })).toBe(false)
    expect(mocks.loadChapterDrafts).toHaveBeenCalledWith(3, PATH, expect.anything())
    expect(mocks.finalizedDeletion).toHaveBeenCalledTimes(1)
    expect(mocks.toast.error).not.toHaveBeenCalled()
  })
})
