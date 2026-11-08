/**
 * Git 同步控制器：把「上传 / 拉取」两个动作接到 IPC 上。
 *
 * 关键约束：
 *  - 上传前必须先关掉作品数据库（SQLite 正在写时拍快照会得到半截状态），
 *    关库走主进程自己的关闭路径，关完做 .backup 快照，推完再重开作品。
 *  - 拉取前数据库必须已关；拉完清掉错配的 -wal/-shm 并校验库。
 *  - 同一项目同一时间只允许一个同步动作。
 */

import fs from 'node:fs'
import path from 'node:path'

import { ipcMain, safeStorage } from 'electron'

import type {
  GitSyncCommitView,
  GitSyncConfigView,
  GitSyncConfigureRequest,
  GitSyncCreateRepositoryRequest,
  GitSyncCreateRepositoryResult,
  GitSyncHost,
  GitSyncDownloadRequest,
  GitSyncDownloadResult,
  GitSyncErrorCode,
  GitSyncFailure,
  GitSyncProjectSessionContext,
  GitSyncStatusView,
  GitSyncUploadRequest,
  GitSyncUploadResult,
  GitSyncViewResult,
} from '../../src/shared/git-sync'
import { closeProjectDatabase, getCurrentProjectPath } from '../database'
import { GLOBAL_CONFIG_PATH, readJsonFile } from '../utils/config-utils'
import {
  GitSyncCredentialStore,
} from '../services/git-sync-credential-store'
import { GitHostClient, GitHostError } from '../services/git-host-client'
import {
  GitSyncError,
  GitSyncService,
  findLibraryRoot,
  listLibraryBooks,
  normalizeGitRemoteUrl,
  resolveGitSyncPaths,
  type GitBookStatus,
  type GitSyncStatus,
  type LibraryBook,
} from '../services/git-sync-service'
import { projectAccess } from '../services/project-access'
import { backupProjectSqlite, verifyProjectSqlite } from '../services/sqlite-project-migration'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const DEFAULT_BRANCH = 'main'
const DEFAULT_AUTHOR = '书童作者'
const DEFAULT_EMAIL = 'pagekin@localhost'

interface GitSyncIpcRegistrar {
  handle(channel: string, handler: (_event: unknown, argument: unknown) => unknown): void
}

interface ActiveProject {
  projectId: string
  rootPath: string
}

export interface GitSyncControllerDependencies {
  ipc: GitSyncIpcRegistrar
  credentials: Pick<GitSyncCredentialStore, 'save' | 'resolve' | 'forget'>
  service: Pick<GitSyncService, 'status' | 'initialize' | 'push' | 'pull'>
  assertCurrentProjectContext(
    context: GitSyncProjectSessionContext | undefined,
    currentProjectPath: string | null,
  ): ActiveProject
  getCurrentProjectPath(): string | null
  closeProjectDatabase(): void
  isProjectDatabaseOpen(): boolean
  /** 为一本书的数据库做一致快照；opened 表示它是不是当前打开的那本（决定要不要先移走 -wal） */
  snapshotDatabase(databasePath: string, opened: boolean): Promise<void>
  verifyDatabase(databasePath: string): void
  hosts: Pick<GitHostClient,
    'identify' | 'createRepositoryWithFallback' | 'listRepositories' | 'looksLikeBookLibrary'>
  findLibraryRoot(projectRoot: string): string | null
  listLibraryBooks(libraryRoot: string): LibraryBook[]
  /** 逐本算改动：只读 git status 与 -wal，不改任何文件 */
  changedBooks(libraryRoot: string, books: readonly LibraryBook[], openedRoot: string): Promise<GitBookStatus[]>
  /** 拉取前体检：远端要改哪些书、本机哪些书没上传、哪些撞车 */
  inspectPull(
    libraryRoot: string,
    books: readonly LibraryBook[],
    branch: string,
    credentials: { username: string; token: string },
  ): Promise<{ incoming: string[]; dirty: string[]; conflicts: string[] }>
  removeRuntimeFiles(databasePath: string): void
}

function fail(code: GitSyncErrorCode, detail?: string): never {
  throw new GitSyncError(code, detail)
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('GIT_SYNC_INPUT_INVALID')
  return value as Record<string, unknown>
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) fail('GIT_SYNC_INPUT_INVALID')
  return value.trim()
}

function projectSession(value: unknown): GitSyncProjectSessionContext {
  const source = record(value)
  const projectId = requiredText(source.projectId)
  if (!UUID.test(projectId)) fail('GIT_SYNC_INPUT_INVALID')
  return {
    projectId,
    leaseId: requiredText(source.leaseId),
    projectPath: requiredText(source.projectPath),
  }
}

function failure(error: unknown): GitSyncFailure {
  if (error instanceof GitSyncError) {
    return error.detail
      ? { success: false, errorCode: error.code, detail: error.detail }
      : { success: false, errorCode: error.code }
  }
  if (error instanceof GitHostError) {
    const mapped: GitSyncErrorCode = error.code === 'GIT_HOST_AUTH_FAILED' ? 'GIT_SYNC_HOST_AUTH_FAILED'
      : error.code === 'GIT_HOST_NAME_TAKEN' ? 'GIT_SYNC_HOST_NAME_TAKEN'
        : error.code === 'GIT_HOST_NETWORK_FAILED' ? 'GIT_SYNC_HOST_NETWORK_FAILED'
          : 'GIT_SYNC_HOST_FAILED'
    return error.detail
      ? { success: false, errorCode: mapped, detail: error.detail }
      : { success: false, errorCode: mapped }
  }
  const message = error instanceof Error ? error.message : ''
  if (/^GIT_SYNC_[A-Z_]+$/u.test(message)) return { success: false, errorCode: message as GitSyncErrorCode }
  // 换过作品/重开过同一路径：不是同步失败，是这次请求的会话已经作废。
  if (message === 'PROJECT_SESSION_STALE' || message === 'PROJECT_SESSION_ROOT_MISMATCH'
    || message === 'PROJECT_SESSION_DATABASE_MISMATCH' || message === 'PROJECT_SESSION_REQUIRED') {
    return { success: false, errorCode: 'GIT_SYNC_SESSION_STALE' }
  }
  // 只记录错误类型，不输出路径、URL 或 git 原文。
  console.warn('[git-sync] unmapped failure', { name: error instanceof Error ? error.name : typeof error })
  return { success: false, errorCode: 'GIT_SYNC_FAILED' }
}

/** 从远端地址看出是哪家托管站。 */
export function hostFromRemoteUrl(remoteUrl: string | null): GitSyncHost | null {
  if (!remoteUrl) return null
  try {
    const host = new URL(remoteUrl).hostname.toLowerCase()
    if (host.endsWith('github.com')) return 'github'
    if (host.endsWith('gitee.com')) return 'gitee'
    return null
  } catch {
    return null
  }
}

function commitView(commit: { sha: string; subject: string; committedAt: string } | null): GitSyncCommitView | null {
  return commit ? { sha: commit.sha, subject: commit.subject, committedAt: commit.committedAt } : null
}

export function registerGitSyncController(injected: Partial<GitSyncControllerDependencies> = {}): void {
  const dependencies: GitSyncControllerDependencies = {
    ...productionDependencies(),
    ...injected,
    ipc: injected.ipc ?? {
      handle(channel, handler) { ipcMain.handle(channel, (event, argument) => handler(event, argument)) },
    },
  }

  const inFlight = new Set<string>()
  const guard = async <T>(projectId: string, action: () => Promise<T>): Promise<T> => {
    if (inFlight.has(projectId)) fail('GIT_SYNC_BUSY')
    inFlight.add(projectId)
    try { return await action() } finally { inFlight.delete(projectId) }
  }

  const resolveActive = (rawSession: unknown): { session: GitSyncProjectSessionContext; active: ActiveProject } => {
    const session = projectSession(rawSession)
    return {
      session,
      active: dependencies.assertCurrentProjectContext(session, dependencies.getCurrentProjectPath()),
    }
  }

  const configView = (
    projectId: string,
    status: GitSyncStatus,
    fallbackRemote: string | null,
    authorName: string,
  ): GitSyncConfigView => {
    const credential = dependencies.credentials.resolve(projectId)
    const hasToken = Boolean(credential?.token)
    return {
      remoteUrl: status.remoteUrl ?? fallbackRemote,
      host: hostFromRemoteUrl(status.remoteUrl ?? fallbackRemote),
      branch: status.branch || DEFAULT_BRANCH,
      hasCredential: hasToken,
      credentialPersistence: hasToken && credential ? credential.metadata.persistence : 'none',
      authorName: credential?.metadata.username || authorName,
      libraryPath: null,
    }
  }

  dependencies.ipc.handle('git-sync:view', async (_event, rawSession) => {
    try {
      const { active } = resolveActive(rawSession)
      const libraryRoot = dependencies.findLibraryRoot(active.rootPath)
      if (!libraryRoot) {
        // 还没接入书库：仍然给出空状态，让界面能显示「去配置」。
        return {
          success: true as const,
          config: {
            remoteUrl: null, host: null, branch: DEFAULT_BRANCH, hasCredential: false,
            credentialPersistence: 'none' as const, authorName: DEFAULT_AUTHOR, libraryPath: null,
          },
          status: {
            initialized: false, hasRemote: false, branch: DEFAULT_BRANCH, bookCount: 0, changedBooks: 0,
            pendingFiles: 0, ahead: null, behind: null, diverged: false, lastCommit: null,
            databaseOpen: dependencies.isProjectDatabaseOpen(), books: [],
          } satisfies GitSyncStatusView,
        } satisfies GitSyncViewResult
      }
      const books = dependencies.listLibraryBooks(libraryRoot)
      const status = await dependencies.service.status(libraryRoot)
      const changed = await dependencies.changedBooks(libraryRoot, books, active.rootPath)
      const view: GitSyncViewResult = {
        success: true,
        config: {
          remoteUrl: status.remoteUrl,
          host: hostFromRemoteUrl(status.remoteUrl),
          branch: status.branch || DEFAULT_BRANCH,
          hasCredential: Boolean(dependencies.credentials.resolve(active.projectId)?.token),
          credentialPersistence: credentialPersistence(active.projectId),
          authorName: dependencies.credentials.resolve(active.projectId)?.metadata.username || DEFAULT_AUTHOR,
          libraryPath: libraryRoot,
        },
        status: {
          initialized: status.initialized,
          hasRemote: status.hasRemote,
          branch: status.branch || DEFAULT_BRANCH,
          bookCount: books.length,
          changedBooks: changed.filter(book => book.changed).length,
          pendingFiles: status.pendingFiles,
          ahead: status.ahead,
          behind: status.behind,
          diverged: status.diverged,
          lastCommit: commitView(status.lastCommit),
          databaseOpen: dependencies.isProjectDatabaseOpen(),
          books: changed,
        } satisfies GitSyncStatusView,
      }
      return view
    } catch (error) {
      return failure(error)
    }
  })

  const credentialPersistence = (projectId: string): 'os-backed' | 'session-only' | 'none' => {
    const credential = dependencies.credentials.resolve(projectId)
    if (!credential?.token) return 'none'
    return credential.metadata.persistence
  }

  dependencies.ipc.handle('git-sync:configure', async (_event, rawRequest) => {
    try {
      const request = record(rawRequest) as unknown as GitSyncConfigureRequest
      const { active } = resolveActive(request.projectSession)
      const remoteUrl = normalizeGitRemoteUrl(requiredText(request.remoteUrl))
      const username = requiredText(request.username)
      const token = typeof request.token === 'string' ? request.token.trim() : ''
      if (token) {
        dependencies.credentials.save({ projectId: active.projectId, username, token })
      } else if (!dependencies.credentials.resolve(active.projectId)?.token) {
        fail('GIT_SYNC_CREDENTIAL_UNAVAILABLE')
      }
      const branch = request.branch?.trim() || DEFAULT_BRANCH
      // 书库根 = 当前作品的上一级目录；第一次接入时就地初始化 git 仓库与 .gitignore。
      const libraryRoot = dependencies.findLibraryRoot(active.rootPath)
        ?? path.dirname(path.resolve(active.rootPath))
      await dependencies.service.initialize({
        workTree: libraryRoot, remoteUrl, branch,
        authorName: username || DEFAULT_AUTHOR, authorEmail: DEFAULT_EMAIL,
      })
      const status = await dependencies.service.status(libraryRoot)
      return {
        success: true as const,
        config: {
          remoteUrl: status.remoteUrl ?? remoteUrl,
          host: hostFromRemoteUrl(status.remoteUrl ?? remoteUrl),
          branch: status.branch || branch,
          hasCredential: true,
          credentialPersistence: credentialPersistence(active.projectId),
          authorName: username,
          libraryPath: libraryRoot,
        } satisfies GitSyncConfigView,
      }
    } catch (error) {
      return failure(error)
    }
  })

  /**
   * 新电脑上的「一条龙」：只给 token →
   * 先看这个账号下是不是已经有书童的备份仓库：
   *   有  → 直接接上（不新建，也不动它的内容）
   *   没有 → 建一个私有仓库再接上
   * 之后由界面调用上传/拉取。
   */
  dependencies.ipc.handle('git-sync:create-repository', async (_event, rawRequest) => {
    try {
      const request = record(rawRequest) as unknown as GitSyncCreateRepositoryRequest
      const { active } = resolveActive(request.projectSession)
      const host: GitSyncHost = request.host === 'gitee' ? 'gitee' : 'github'
      const token = requiredText(request.token)
      let username = ''
      try {
        username = await dependencies.hosts.identify(host, token)
      } catch (error) {
        if (error instanceof GitHostError && error.code === 'GIT_HOST_AUTH_FAILED') {
          fail('GIT_SYNC_HOST_AUTH_FAILED')
        }
        throw error
      }

      const libraryRoot = dependencies.findLibraryRoot(active.rootPath)
        ?? path.dirname(path.resolve(active.rootPath))

      // ① 找这个账号下已有的书童备份仓库（私有、且根目录里确实有 .ai-novel）
      const candidates: Array<{ fullName: string; cloneUrl: string; updatedAt: string }> = []
      if (!request.forceCreate) {
        let repositories: Awaited<ReturnType<GitSyncControllerDependencies['hosts']['listRepositories']>> = []
        try {
          repositories = await dependencies.hosts.listRepositories(host, token)
        } catch {
          repositories = []
        }
        for (const repository of repositories) {
          if (!repository.private) continue
          if (!/pagekin|ai-novel|novel|小说/iu.test(repository.fullName)) continue
          if (!(await dependencies.hosts.looksLikeBookLibrary(host, token, repository.fullName))) continue
          candidates.push({
            fullName: repository.fullName,
            cloneUrl: repository.cloneUrl,
            updatedAt: repository.updatedAt,
          })
        }
      }

      const requested = request.existingRepository?.trim()
      const chosen = requested
        ? candidates.find(candidate => candidate.fullName === requested) ?? null
        : candidates[0] ?? null

      let repositoryUrl: string
      let fullName: string
      let action: 'reused' | 'created'
      if (chosen) {
        repositoryUrl = chosen.cloneUrl
        fullName = chosen.fullName
        action = 'reused'
      } else {
        const suggested = request.repositoryName?.trim()
          || path.basename(libraryRoot)
          || 'pagekin-library'
        const repository = await dependencies.hosts.createRepositoryWithFallback({
          host,
          token,
          name: suggested,
          description: '书童 Pagekin 作品同步（私有）',
        })
        repositoryUrl = repository.cloneUrl
        fullName = repository.fullName
        action = 'created'
      }

      dependencies.credentials.save({ projectId: active.projectId, username, token })
      await dependencies.service.initialize({
        workTree: libraryRoot,
        remoteUrl: repositoryUrl,
        branch: 'main',
        authorName: username,
        authorEmail: `${username}@users.noreply.${host === 'gitee' ? 'gitee.com' : 'github.com'}`,
      })
      const status = await dependencies.service.status(libraryRoot)
      const result: GitSyncCreateRepositoryResult = {
        success: true,
        repositoryUrl,
        fullName,
        username,
        // 远端还是空的（没接过任何内容）才适合直接首传
        remoteEmpty: status.ahead === null,
        action,
        otherCandidates: candidates.filter(candidate => candidate.fullName !== fullName),
      }
      return result
    } catch (error) {
      return failure(error)
    }
  })

  dependencies.ipc.handle('git-sync:upload', async (_event, rawRequest) => {
    try {
      const request = record(rawRequest) as unknown as GitSyncUploadRequest
      const resolved = resolveActive(request.projectSession)
      const projectId = resolved.active.projectId
      const libraryRoot = dependencies.findLibraryRoot(resolved.active.rootPath)
      if (!libraryRoot) fail('GIT_SYNC_LIBRARY_MISSING')
      return await guard(projectId, async (): Promise<GitSyncUploadResult | GitSyncFailure> => {
        const credential = dependencies.credentials.resolve(projectId)
        if (!credential?.token) fail('GIT_SYNC_CREDENTIAL_UNAVAILABLE')
        const status = await dependencies.service.status(libraryRoot)
        if (!status.remoteUrl) fail('GIT_SYNC_NOT_CONFIGURED')

        // 关库只影响「当前打开的那本」；其余书根本没开，直接做快照即可。
        const openedRoot = resolved.active.rootPath
        if (dependencies.isProjectDatabaseOpen()) dependencies.closeProjectDatabase()
        if (dependencies.isProjectDatabaseOpen()) fail('GIT_SYNC_SAVE_PENDING')

        const books = dependencies.listLibraryBooks(libraryRoot)
        const push = await dependencies.service.push({
          workTree: libraryRoot,
          remoteUrl: status.remoteUrl,
          branch: status.branch || DEFAULT_BRANCH,
          credentials: { username: credential.metadata.username, token: credential.token },
          authorName: credential.metadata.username || DEFAULT_AUTHOR,
          authorEmail: DEFAULT_EMAIL,
          books,
          // 每本书都做一致快照：合并 WAL 后再让 git 看字节。
          snapshot: async book => {
            const paths = resolveGitSyncPaths(book.rootPath)
            await dependencies.snapshotDatabase(paths.databasePath, book.rootPath === openedRoot)
          },
        })
        const uploaded = push.uploaded.filter(entry => entry.committed)
        return {
          success: true as const,
          state: uploaded.length > 0 ? 'uploaded' as const : 'up-to-date' as const,
          commit: commitView(push.commit),
          books: push.uploaded.map(entry => ({
            relativePath: entry.relativePath,
            committed: entry.committed,
            uploaded: entry.committed,
          })),
          skippedOpen: [],
        }
      })
    } catch (error) {
      return failure(error)
    }
  })

  dependencies.ipc.handle('git-sync:download', async (_event, rawRequest) => {
    try {
      const request = record(rawRequest) as unknown as GitSyncDownloadRequest
      const resolved = resolveActive(request.projectSession)
      const projectId = resolved.active.projectId
      const libraryRoot = dependencies.findLibraryRoot(resolved.active.rootPath)
      if (!libraryRoot) fail('GIT_SYNC_LIBRARY_MISSING')
      return await guard(projectId, async (): Promise<GitSyncDownloadResult | GitSyncFailure> => {
        const credential = dependencies.credentials.resolve(projectId)
        if (!credential?.token) fail('GIT_SYNC_CREDENTIAL_UNAVAILABLE')
        const status = await dependencies.service.status(libraryRoot)
        if (!status.remoteUrl) fail('GIT_SYNC_NOT_CONFIGURED')
        // 关库之前先逐本查冲突：只有「远端要改 + 本机没上传」的书才拦，
        // 别的书有本地改动不该拦住这次拉取，更不该被打断重开。
        const books = dependencies.listLibraryBooks(libraryRoot)
        const inspection = await dependencies.inspectPull(
          libraryRoot, books, status.branch || DEFAULT_BRANCH,
          { username: credential.metadata.username, token: credential.token },
        )
        if (inspection.conflicts.length > 0) {
          fail('GIT_SYNC_LOCAL_CHANGES', inspection.conflicts.join('、'))
        }
        if (dependencies.isProjectDatabaseOpen()) dependencies.closeProjectDatabase()
        if (dependencies.isProjectDatabaseOpen()) fail('GIT_SYNC_SAVE_PENDING')
        const pulled = await dependencies.service.pull({
          workTree: libraryRoot,
          remoteUrl: status.remoteUrl,
          branch: status.branch || DEFAULT_BRANCH,
          credentials: { username: credential.metadata.username, token: credential.token },
          authorName: credential.metadata.username || DEFAULT_AUTHOR,
          authorEmail: DEFAULT_EMAIL,
          books,
          afterCheckout: async changedBooks => {
            // 只清理这次真正变过的书，别去动没变化的库。
            for (const relativePath of changedBooks) {
              const bookRoot = path.join(libraryRoot, ...relativePath.split('/'))
              const paths = resolveGitSyncPaths(bookRoot)
              dependencies.removeRuntimeFiles(paths.databasePath)
              dependencies.verifyDatabase(paths.databasePath)
            }
          },
        })
        return {
          success: true as const,
          state: pulled.updated ? 'updated' as const : 'up-to-date' as const,
          commit: commitView(pulled.commit),
          changedBooks: pulled.changedBooks,
        }
      })
    } catch (error) {
      return failure(error)
    }
  })

  dependencies.ipc.handle('git-sync:forget-credential', async (_event, rawSession) => {
    try {
      const { active } = resolveActive(rawSession)
      dependencies.credentials.forget(active.projectId)
      const paths = resolveGitSyncPaths(active.rootPath)
      const status = await dependencies.service.status(paths.workTree)
      return { success: true as const, config: configView(active.projectId, status, null, DEFAULT_AUTHOR) }
    } catch (error) {
      return failure(error)
    }
  })
}

/** 应用设置里的代理 → git 能用的地址；没启用就返回 null（沿用进程环境）。 */
export function configuredProxyUrl(): string | null {
  try {
    const config = readJsonFile<{ proxy?: { enabled?: boolean; type?: string; host?: string; port?: number } }>(
      GLOBAL_CONFIG_PATH, {},
    )
    const proxy = config.proxy
    if (!proxy?.enabled || !proxy.host) return null
    const scheme = proxy.type === 'socks5' ? 'socks5' : 'http'
    return `${scheme}://${proxy.host}:${proxy.port ?? 7890}`
  } catch {
    return null
  }
}

function productionDependencies(): GitSyncControllerDependencies {
  // 凭据存储要读全局数据根，必须等启动迁移完成后再构造，不能在建模块时就建。
  let credentials: GitSyncCredentialStore | null = null
  const store = (): GitSyncCredentialStore => {
    credentials ??= new GitSyncCredentialStore({ safeStorage })
    return credentials
  }
  return {
    ipc: { handle(channel, handler) { ipcMain.handle(channel, (event, argument) => handler(event, argument)) } },
    credentials: {
      save: input => store().save(input),
      resolve: projectId => store().resolve(projectId),
      forget: projectId => store().forget(projectId),
    },
    // git 是独立进程，不读应用配置；把「网络代理」显式转成代理地址给它。
    service: new GitSyncService({ proxyUrl: configuredProxyUrl }),
    assertCurrentProjectContext: (context, currentPath) => {
      const active = projectAccess.assertCurrentProjectContext(context, currentPath)
      return { projectId: active.projectId, rootPath: active.rootPath }
    },
    getCurrentProjectPath: () => getCurrentProjectPath(),
    closeProjectDatabase: () => {
      closeProjectDatabase()
      projectAccess.invalidateCurrentSession()
    },
    isProjectDatabaseOpen: () => Boolean(getCurrentProjectPath()),
    snapshotDatabase: async (databasePath, opened) => {
      if (!fs.existsSync(databasePath)) return
      const temporary = `${databasePath}.git-sync-tmp`
      fs.rmSync(temporary, { force: true })
      // backupProjectSqlite 会带上 WAL 里已提交的内容：没打开的书也能拿到完整快照。
      await backupProjectSqlite({ sourceDatabasePath: databasePath, targetDatabasePath: temporary })
      fs.renameSync(temporary, databasePath)
      if (opened) {
        for (const suffix of ['-wal', '-shm']) fs.rmSync(`${databasePath}${suffix}`, { force: true })
      }
    },
    hosts: new GitHostClient(),
    findLibraryRoot,
    listLibraryBooks,
    inspectPull: async (libraryRoot, books, branch, credentials) => {
      const service = new GitSyncService({ proxyUrl: configuredProxyUrl })
      return service.inspectPullWithCredentials(libraryRoot, books, branch, credentials)
    },
    changedBooks: async (libraryRoot, books, openedRoot) => {
      const status = await new GitSyncService().bookChanges(libraryRoot, books)
      return status.map(book => ({ ...book, current: path.resolve(book.rootPath) === path.resolve(openedRoot) }))
    },
    verifyDatabase: databasePath => {
      if (!fs.existsSync(databasePath)) fail('GIT_SYNC_SNAPSHOT_FAILED')
      verifyProjectSqlite({ databasePath })
    },
    removeRuntimeFiles: databasePath => {
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try { fs.rmSync(`${databasePath}${suffix}`, { force: true }) } catch { /* 尽力清理 */ }
      }
    },
  }
}
