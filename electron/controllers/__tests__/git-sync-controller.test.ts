import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { registerGitSyncController, type GitSyncControllerDependencies } from '../git-sync-controller'

/**
 * 控制器自己的责任：书库定位、关库与快照的顺序、失败码映射、并发防护。
 * 真正的 git 行为在 git-sync-service.test.ts 里用真实仓库验证。
 */

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const REMOTE = 'https://github.com/me/library.git'
const TOKEN = 'token-abc'
const roots: string[] = []

type Handler = (event: unknown, argument: unknown) => Promise<unknown>

function temporaryLibrary(bookNames: readonly string[]): { library: string; book: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pagekin-git-ctl-'))
  roots.push(workspace)
  const library = path.join(workspace, 'library')
  for (const name of bookNames) {
    const storage = path.join(library, name, '.ai-novel')
    fs.mkdirSync(storage, { recursive: true })
    fs.writeFileSync(path.join(storage, 'project.json'), '{}')
    fs.writeFileSync(path.join(storage, 'project.db'), 'db')
  }
  return { library, book: path.join(library, bookNames[0]!) }
}

interface HarnessOptions {
  openedRoot?: string
  libraryRoot?: string
  overrides?: Partial<GitSyncControllerDependencies>
}

function harness(options: HarnessOptions = {}) {
  const { openedRoot, libraryRoot, overrides = {} } = options
  const handlers = new Map<string, Handler>()
  const events: string[] = []
  let databaseOpen = true

  const service = {
    status: vi.fn(async () => ({
      initialized: true, hasRemote: true, remoteUrl: REMOTE, branch: 'main',
      pendingFiles: 0, ahead: 0, behind: 0, diverged: false, lastCommit: null,
    })),
    initialize: vi.fn(async () => ({ created: false })),
    push: vi.fn(async (input: { books: Array<{ relativePath: string }>; snapshot: (book: unknown) => Promise<void> }) => {
      events.push('push')
      for (const book of input.books) await input.snapshot(book)
      return {
        committed: true,
        commit: { sha: 'b'.repeat(40), subject: 'sync', committedAt: '2026-01-01T00:00:00.000Z' },
        uploaded: input.books.map(book => ({ relativePath: book.relativePath, committed: true })),
      }
    }),
    pull: vi.fn(async (input: { afterCheckout: (books: string[]) => Promise<void> }) => {
      events.push('pull')
      await input.afterCheckout(['书甲'])
      return { updated: true, commit: null, changedBooks: ['书甲'] }
    }),
    bookChanges: vi.fn(),
  }

  const dependencies = {
    ipc: { handle(channel: string, handler: Handler) { handlers.set(channel, handler) } },
    credentials: {
      save: vi.fn(() => ({ projectId: PROJECT_ID, username: 'writer', persistence: 'os-backed' as const })),
      resolve: vi.fn(() => ({
        metadata: { projectId: PROJECT_ID, username: 'writer', persistence: 'os-backed' as const },
        token: TOKEN,
      })),
      forget: vi.fn(() => true),
    },
    service: service as unknown as GitSyncControllerDependencies['service'],
    assertCurrentProjectContext: () => ({ projectId: PROJECT_ID, rootPath: openedRoot ?? '/library/书甲' }),
    getCurrentProjectPath: () => (databaseOpen ? (openedRoot ?? '/library/书甲') : null),
    closeProjectDatabase: () => { events.push('close-db'); databaseOpen = false },
    isProjectDatabaseOpen: () => databaseOpen,
    snapshotDatabase: async (_databasePath: string, opened: boolean) => { events.push(opened ? 'snapshot-opened' : 'snapshot-other') },
    verifyDatabase: () => { events.push('verify') },
    removeRuntimeFiles: () => { events.push('clean-wal') },
    findLibraryRoot: () => libraryRoot ?? '/library',
    listLibraryBooks: () => [
      { relativePath: '书甲', rootPath: path.join(libraryRoot ?? '/library', '书甲'), name: '书甲' },
      { relativePath: '书乙', rootPath: path.join(libraryRoot ?? '/library', '书乙'), name: '书乙' },
    ],
    inspectPull: async () => ({ incoming: [], dirty: [], conflicts: [] }),
    hosts: {
      identify: async () => 'writer',
      createRepositoryWithFallback: async () => ({ cloneUrl: 'https://github.com/writer/new.git', fullName: 'writer/new', defaultBranch: 'main' }),
      listRepositories: async () => [],
      looksLikeBookLibrary: async () => false,
    },
    changedBooks: async () => [
      { relativePath: '书甲', rootPath: '/library/书甲', name: '书甲', changed: true, current: true },
      { relativePath: '书乙', rootPath: '/library/书乙', name: '书乙', changed: false, current: false },
    ],
    ...overrides,
  } as GitSyncControllerDependencies

  registerGitSyncController(dependencies)
  const invoke = async (channel: string, argument: unknown) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`handler missing: ${channel}`)
    return await handler({ sender: { id: 1 } }, argument) as Record<string, unknown>
  }
  return { invoke, service, events }
}

const SESSION = { projectId: PROJECT_ID, leaseId: 'lease-1', projectPath: '/library/书甲' }

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('git 同步控制器（书库）', () => {
  it('上传前先关库，再逐本快照；当前打开的那本单独标记', async () => {
    const { library, book } = temporaryLibrary(['书甲', '书乙'])
    const { invoke, events } = harness({ openedRoot: book, libraryRoot: library })
    const result = await invoke('git-sync:upload', { projectSession: { ...SESSION, projectPath: book } })
    expect(result.success).toBe(true)
    expect(events.slice(0, 3)).toEqual(['close-db', 'push', 'snapshot-opened'])
    expect(events).toContain('snapshot-other')
    const books = result.books as Array<{ relativePath: string; uploaded: boolean }>
    expect(books.map(entry => entry.relativePath)).toEqual(['书甲', '书乙'])
  })

  it('拉取只清理这次真正变过的书', async () => {
    const { library, book } = temporaryLibrary(['书甲', '书乙'])
    const { invoke, events } = harness({ openedRoot: book, libraryRoot: library })
    const result = await invoke('git-sync:download', { projectSession: { ...SESSION, projectPath: book } })
    expect(result).toMatchObject({ success: true, state: 'updated', changedBooks: ['书甲'] })
    expect(events).toEqual(['close-db', 'pull', 'clean-wal', 'verify'])
  })

  it('远端要改的那本本机也没上传时，拒绝拉取且不关库', async () => {
    const conflicting = harness({ overrides: {
      inspectPull: async () => ({ incoming: ['书甲'], dirty: ['书甲'], conflicts: ['书甲'] }),
    } })
    const result = await conflicting.invoke('git-sync:download', { projectSession: SESSION })
    expect(result).toMatchObject({ success: false, errorCode: 'GIT_SYNC_LOCAL_CHANGES', detail: '书甲' })
    expect(conflicting.events).toEqual([])
  })

  it('本机有本地改动、但远端要改的是另一本时，照常拉取', async () => {
    const otherBookDirty = harness({ overrides: {
      inspectPull: async () => ({ incoming: ['书甲'], dirty: ['书乙'], conflicts: [] }),
    } })
    const result = await otherBookDirty.invoke('git-sync:download', { projectSession: SESSION })
    expect(result).toMatchObject({ success: true, state: 'updated' })
    expect(otherBookDirty.events).toContain('close-db')
  })

  it('没有书库时报错，不瞎猜目录', async () => {
    const { invoke } = harness({ overrides: { findLibraryRoot: () => null } })
    const result = await invoke('git-sync:upload', { projectSession: SESSION })
    expect(result).toMatchObject({ success: false, errorCode: 'GIT_SYNC_LIBRARY_MISSING' })
  })

  it('没有令牌时给出凭据码，不触达 git', async () => {
    const { invoke } = harness({ overrides: {
      credentials: { save: vi.fn(), resolve: vi.fn(() => null), forget: vi.fn() } as unknown as GitSyncControllerDependencies['credentials'],
    } })
    const result = await invoke('git-sync:upload', { projectSession: SESSION })
    expect(result).toMatchObject({ success: false, errorCode: 'GIT_SYNC_CREDENTIAL_UNAVAILABLE' })
  })

  it('两个动作并发时第二个直接拒绝', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const { invoke } = harness({ overrides: {
      service: {
        status: vi.fn(async () => ({
          initialized: true, hasRemote: true, remoteUrl: REMOTE, branch: 'main',
          pendingFiles: 0, ahead: 0, behind: 0, diverged: false, lastCommit: null,
        })),
        initialize: vi.fn(),
        push: vi.fn(async () => { await gate; return { committed: true, commit: null, uploaded: [] } }),
        pull: vi.fn(async () => ({
          updated: false, commit: null, changedBooks: [], keptLocal: [], tookRemote: [], backupRef: null,
        })),
        followRemote: vi.fn(),
        refreshRemoteRefs: vi.fn(async () => true),
        bookChanges: vi.fn(),
      } as unknown as GitSyncControllerDependencies['service'],
      inspectPull: async () => ({ incoming: [], dirty: [], conflicts: [] }),
    hosts: {
      identify: async () => 'writer',
      createRepositoryWithFallback: async () => ({ cloneUrl: 'https://github.com/writer/new.git', fullName: 'writer/new', defaultBranch: 'main' }),
      listRepositories: async () => [],
      looksLikeBookLibrary: async () => false,
    },
    } })
    const first = invoke('git-sync:upload', { projectSession: SESSION })
    const second = await invoke('git-sync:upload', { projectSession: SESSION })
    expect(second).toMatchObject({ success: false, errorCode: 'GIT_SYNC_BUSY' })
    release()
    await first
  })

  it('会话作废有专门的码，主进程原文不透给界面', async () => {
    const { invoke } = harness({ overrides: {
      assertCurrentProjectContext: () => { throw new Error('PROJECT_SESSION_STALE') },
    } })
    const result = await invoke('git-sync:view', SESSION)
    expect(result).toMatchObject({ success: false, errorCode: 'GIT_SYNC_SESSION_STALE' })
    expect(JSON.stringify(result)).not.toContain('PROJECT_SESSION_STALE')
  })

  it('账号下已有书童备份仓库时直接连上，不再新建', async () => {
    const existing = harness({ overrides: {
      hosts: {
        identify: async () => 'writer',
        createRepositoryWithFallback: vi.fn(async () => { throw new Error('不该新建仓库') }),
        listRepositories: async () => [
          { fullName: 'writer/pagekin-novel', cloneUrl: 'https://github.com/writer/pagekin-novel.git', private: true, updatedAt: '2026-11-08T00:00:00Z' },
        ],
        looksLikeBookLibrary: async () => true,
      },
    } })
    const result = await existing.invoke('git-sync:create-repository', {
      projectSession: SESSION, host: 'github', token: 'tok',
    })
    expect(result).toMatchObject({
      success: true,
      action: 'reused',
      fullName: 'writer/pagekin-novel',
      repositoryUrl: 'https://github.com/writer/pagekin-novel.git',
    })
    expect(existing.service.initialize).toHaveBeenCalledWith(expect.objectContaining({
      remoteUrl: 'https://github.com/writer/pagekin-novel.git',
    }))
  })

  it('没有可用备份仓库时才新建', async () => {
    const created = harness({ overrides: {
      hosts: {
        identify: async () => 'writer',
        createRepositoryWithFallback: async () => ({
          cloneUrl: 'https://github.com/writer/pagekin-library.git',
          fullName: 'writer/pagekin-library',
          defaultBranch: 'main',
        }),
        listRepositories: async () => [],
        looksLikeBookLibrary: async () => false,
      },
    } })
    const result = await created.invoke('git-sync:create-repository', {
      projectSession: SESSION, host: 'github', token: 'tok',
    })
    expect(result).toMatchObject({ success: true, action: 'created', fullName: 'writer/pagekin-library' })
  })

  it('只连接真正的书童备份仓库，普通代码仓库不会被误连', async () => {
    const guarded = harness({ overrides: {
      hosts: {
        identify: async () => 'writer',
        createRepositoryWithFallback: async () => ({
          cloneUrl: 'https://github.com/writer/fresh.git', fullName: 'writer/fresh', defaultBranch: 'main',
        }),
        listRepositories: async () => [
          { fullName: 'writer/pagekin-novel', cloneUrl: 'https://github.com/writer/pagekin-novel.git', private: true, updatedAt: '' },
        ],
        // 名字像、但里面没有 .ai-novel
        looksLikeBookLibrary: async () => false,
      },
    } })
    const result = await guarded.invoke('git-sync:create-repository', {
      projectSession: SESSION, host: 'github', token: 'tok',
    })
    expect(result).toMatchObject({ success: true, action: 'created' })
  })

  it('私有的非书童仓库不会被当成备份', async () => {
    const publicOne = harness({ overrides: {
      hosts: {
        identify: async () => 'writer',
        createRepositoryWithFallback: async () => ({
          cloneUrl: 'https://github.com/writer/fresh.git', fullName: 'writer/fresh', defaultBranch: 'main',
        }),
        listRepositories: async () => [
          { fullName: 'writer/pagekin-novel', cloneUrl: 'https://github.com/writer/pagekin-novel.git', private: false, updatedAt: '' },
        ],
        looksLikeBookLibrary: async () => true,
      },
    } })
    const result = await publicOne.invoke('git-sync:create-repository', {
      projectSession: SESSION, host: 'github', token: 'tok',
    })
    expect(result).toMatchObject({ success: true, action: 'created' })
  })

  it('还没接入书库时给出空状态而不是报错', async () => {
    const { invoke } = harness({ overrides: { findLibraryRoot: () => null } })
    const result = await invoke('git-sync:view', SESSION)
    expect(result.success).toBe(true)
    const status = result.status as { bookCount: number; initialized: boolean }
    expect(status.bookCount).toBe(0)
    expect(status.initialized).toBe(false)
  })
})

describe('强制对齐的两个回归点', () => {
  const divergedStatus = {
    initialized: true, hasRemote: true, remoteUrl: REMOTE, branch: 'main',
    pendingFiles: 3, ahead: 1, behind: 1, diverged: true, lastCommit: null,
  }
  const stubs = {
    initialize: async () => ({ created: false }),
    push: async () => { throw new Error('不该直接调 push') },
    pull: async () => { throw new Error('以本机为准绝不能走 pull') },
    followRemote: async () => { throw new Error('不该走 followRemote') },
    bookChanges: async () => [],
  }

  it('以本机为准走 push 而不是 pull：本机有未上传改动也要成功', async () => {
    const pushed: unknown[] = []
    const { invoke } = harness({
      overrides: {
        service: {
          ...stubs,
          status: async () => divergedStatus,
          forceUpload: async (input: unknown) => {
            pushed.push(input)
            return { committed: true, commit: null, keptLocal: ['书甲'], tookRemote: ['书乙'] }
          },
          refreshRemoteRefs: async () => true,
        } as never,
      },
    })
    const result = await invoke('git-sync:resolve-diverged', { projectSession: SESSION, strategy: 'local' })
    expect(result).toMatchObject({ success: true, state: 'aligned', keptLocal: ['书甲'], tookRemote: ['书乙'] })
    expect(pushed).toHaveLength(1)
  })

  it('失败发生在关库之后时，必须告诉界面「库关过了」，否则蓝图会是空的', async () => {
    const { invoke } = harness({
      overrides: {
        service: {
          ...stubs,
          status: async () => divergedStatus,
          forceUpload: async () => { throw Object.assign(new Error('boom'), { code: 'GIT_SYNC_FAILED' }) },
          refreshRemoteRefs: async () => true,
        } as never,
      },
    })
    const result = await invoke('git-sync:resolve-diverged', { projectSession: SESSION, strategy: 'local' })
    expect(result).toMatchObject({ success: false, databaseClosed: true })
  })

  it('没关过库就失败时，不要误报「库关过了」', async () => {
    const { invoke } = harness({
      overrides: {
        service: {
          ...stubs,
          status: async () => { throw Object.assign(new Error('net'), { code: 'GIT_SYNC_NETWORK_FAILED' }) },
          forceUpload: async () => { throw new Error('x') },
          refreshRemoteRefs: async () => true,
        } as never,
      },
    })
    const result = await invoke('git-sync:resolve-diverged', { projectSession: SESSION, strategy: 'local' })
    expect(result.success).toBe(false)
    expect(result.databaseClosed).toBeUndefined()
  })
})

describe('拉取删掉了书时不应当成失败', () => {
  it('变化的书被远端删除后，拉取仍然成功（不再因校验缺失的库而报错）', async () => {
    const { invoke, events } = harness({
      overrides: {
        service: {
          status: async () => ({
            initialized: true, hasRemote: true, remoteUrl: REMOTE, branch: 'main',
            pendingFiles: 0, ahead: 0, behind: 1, diverged: false, lastCommit: null,
          }),
          initialize: async () => ({ created: false }),
          push: async () => { throw new Error('不该推') },
          // 拉取后报告「书甲」变了，但它的目录其实已经被删掉。
          pull: vi.fn(async (input: { afterCheckout: (books: string[]) => Promise<void> }) => {
            events.push('pull')
            await input.afterCheckout(['已删除的书'])
            return { updated: true, commit: null, changedBooks: ['已删除的书'], keptLocal: [], tookRemote: ['已删除的书'], backupRef: null }
          }),
          followRemote: async () => { throw new Error('x') },
          forceUpload: async () => { throw new Error('x') },
          refreshRemoteRefs: async () => true,
        } as never,
      },
    })
    const result = await invoke('git-sync:download', { projectSession: SESSION })
    // 目录不存在就必须跳过校验，而不是抛 GIT_SYNC_SNAPSHOT_FAILED。
    expect(result).toMatchObject({ success: true, state: 'updated' })
    expect(events).not.toContain('verify')
  })
})
