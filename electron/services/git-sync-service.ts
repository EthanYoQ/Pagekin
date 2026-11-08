/**
 * Git 作品同步：把作品文件夹当作一个 git 工作副本，用「上传 / 拉取」两个动作在
 * 两台电脑之间交接进度。
 *
 * 为什么不是实时同步：书童的作品是 SQLite(WAL) + LanceDB 目录，没有跨机锁，
 * 两个写入者会互相破坏。这里刻意做成「单写者 + 显式交接」：
 *   - 上传前必须已经关闭作品数据库（调用方负责快照）；
 *   - 拉取前本地必须干净；
 *   - 两边各自都写过时直接拒绝，绝不自动合并数据库。
 *
 * 凭据只存在于单次 git 进程的环境里（临时 GIT_ASKPASS），
 * 不写进 .git/config，不拼进 remote URL。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { CANONICAL_PROJECT_DATABASE, CANONICAL_PROJECT_DIRECTORY } from '../../src/shared/project-format'
import type { GitSyncErrorCode } from '../../src/shared/git-sync'

const GIT_TIMEOUT_MS = 180_000
const GIT_MAX_BUFFER = 8 * 1024 * 1024
const REMOTE_NAME = 'origin'
const SEP = '\x1f'

/** 每台机器各自生成、绝不能进仓库的文件。 */
export const GIT_SYNC_IGNORE_ENTRIES: readonly string[] = [
  '*.db-journal',
  '*.db-shm',
  '*.db-wal',
  '.DS_Store',
  '._*',
  'Thumbs.db',
  'git-sync.conf',
]

export class GitSyncError extends Error {
  constructor(readonly code: GitSyncErrorCode, readonly detail?: string) {
    super(code)
    this.name = 'GitSyncError'
  }
}

export interface GitCommandResult {
  stdout: string
  stderr: string
  code: number
}

export interface GitRunOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
}

export interface GitRunner {
  run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult>
}

/**
 * 直接调用系统 git。用 spawn + 数组参数、不经过 shell：
 * 路径里的空格、中文、引号都不会被解释成命令。
 */
export class SystemGitRunner implements GitRunner {
  constructor(private readonly timeoutMs: number = GIT_TIMEOUT_MS) {}

  run(args: readonly string[], options: GitRunOptions): Promise<GitCommandResult> {
    return new Promise<GitCommandResult>((resolvePromise, reject) => {
      const child = spawn('git', args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          // 不让 git 弹任何交互式提示；凭据只走 GIT_ASKPASS。
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
          ...options.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new GitSyncError('GIT_SYNC_TIMEOUT'))
      }, this.timeoutMs)

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        if (stdout.length < GIT_MAX_BUFFER) stdout += chunk
      })
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < GIT_MAX_BUFFER) stderr += chunk
      })
      child.on('error', error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const code = (error as NodeJS.ErrnoException).code
        reject(new GitSyncError(code === 'ENOENT' ? 'GIT_SYNC_GIT_MISSING' : 'GIT_SYNC_FAILED', String(code ?? '')))
      })
      child.on('close', code => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), code: code ?? -1 })
      })
    })
  }
}

export interface GitSyncPaths {
  /** 作品根目录（git 工作副本） */
  workTree: string
  /** 作品存储目录 .ai-novel */
  storageRoot: string
  databasePath: string
}

export function resolveGitSyncPaths(projectRoot: string): GitSyncPaths {
  const root = path.resolve(projectRoot)
  const storageRoot = path.join(root, CANONICAL_PROJECT_DIRECTORY)
  return { workTree: root, storageRoot, databasePath: path.join(storageRoot, CANONICAL_PROJECT_DATABASE) }
}

export interface GitCommitView {
  sha: string
  subject: string
  committedAt: string
}

export interface GitSyncStatus {
  initialized: boolean
  hasRemote: boolean
  remoteUrl: string | null
  branch: string
  /** 未提交的文件数 */
  pendingFiles: number
  /** 本机领先/落后远端；远端不可达时为 null */
  ahead: number | null
  behind: number | null
  /** 两边都有对方没有的提交 */
  diverged: boolean
  lastCommit: GitCommitView | null
}

export interface GitSyncCredentials {
  username: string
  token: string
}

const HTTPS_URL = /^https:\/\/[^\s]+$/u

/** 只接受干净的 https 地址；不接受把账号密码塞进 URL。 */
export function normalizeGitRemoteUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!HTTPS_URL.test(trimmed)) throw new GitSyncError('GIT_SYNC_URL_INVALID')
  let parsed: URL
  try { parsed = new URL(trimmed) } catch { throw new GitSyncError('GIT_SYNC_URL_INVALID') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new GitSyncError('GIT_SYNC_URL_INVALID')
  }
  const withoutTrailing = parsed.toString().replace(/\/+$/u, '')
  return withoutTrailing.endsWith('.git') ? withoutTrailing : `${withoutTrailing}.git`
}

function escapeShellSingle(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/** 临时 askpass 脚本：git 只在进程内通过它取一次用户名/口令。 */
function writeAskpassScript(directory: string, credentials: GitSyncCredentials): string {
  const file = path.join(directory, 'askpass.sh')
  const body = [
    '#!/bin/sh',
    'case "$1" in',
    `  *sername*) printf '%s\\n' ${escapeShellSingle(credentials.username)} ;;`,
    `  *) printf '%s\\n' ${escapeShellSingle(credentials.token)} ;;`,
    'esac',
    '',
  ].join('\n')
  fs.writeFileSync(file, body, { mode: 0o700 })
  try { fs.chmodSync(file, 0o700) } catch { /* Windows 上无 POSIX 模式 */ }
  return file
}

export interface GitSyncServiceOptions {
  runner?: GitRunner
  now?: () => Date
  /**
   * 代理地址（http://host:port）。git 走 libcurl，只认环境变量里的代理；
   * 应用自己的「网络代理」设置只改了主进程环境，这里显式传给它，两类请求才一致。
   */
  proxyUrl?: () => string | null
}

// ---------- 书库：一个仓库管多本书 ----------

/** 作品根目录的标志：.ai-novel/project.json */
export function isProjectRoot(directory: string): boolean {
  try {
    return fs.statSync(path.join(directory, CANONICAL_PROJECT_DIRECTORY, 'project.json')).isFile()
  } catch {
    return false
  }
}

/** 从作品根往上找书库根：最近的一个「自己就是 git 仓库」的祖先（不含作品根本身）。 */
export function findLibraryRoot(projectRoot: string): string | null {
  let cursor = path.dirname(path.resolve(projectRoot))
  const stop = path.parse(cursor).root
  while (cursor && cursor !== stop) {
    if (fs.existsSync(path.join(cursor, '.git'))) return cursor
    cursor = path.dirname(cursor)
  }
  return null
}

export interface GitBookStatus {
  relativePath: string
  name: string
  rootPath: string
  changed: boolean
  current: boolean
}

export interface LibraryBook {
  /** 书库根下的相对路径，用 / 分隔 */
  relativePath: string
  /** 作品根绝对路径 */
  rootPath: string
  name: string
}

/**
 * 枚举书库里的作品：只看书库根下第一层子目录，避免把嵌套的备份副本也算进去。
 * 排序稳定，界面和提交内容都可复现。
 */
export function listLibraryBooks(libraryRoot: string): LibraryBook[] {
  const root = path.resolve(libraryRoot)
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch {
    return []
  }
  const books: LibraryBook[] = []
  for (const name of entries.sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))) {
    if (name.startsWith('.') || name === 'node_modules') continue
    const candidate = path.join(root, name)
    let isDirectory = false
    try { isDirectory = fs.statSync(candidate).isDirectory() } catch { continue }
    if (!isDirectory) continue
    if (!isProjectRoot(candidate)) continue
    books.push({ relativePath: name.split(path.sep).join('/'), rootPath: candidate, name })
  }
  return books
}

/** 把作品根的绝对路径换算成书库内相对路径，并拒绝越界。 */
export function relativeBookPath(libraryRoot: string, projectRoot: string): string {
  const relative = path.relative(path.resolve(libraryRoot), path.resolve(projectRoot))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new GitSyncError('GIT_SYNC_LIBRARY_MISSING')
  }
  return relative.split(path.sep).join('/')
}

export class GitSyncService {
  private readonly runner: GitRunner
  private readonly now: () => Date
  private readonly proxyUrl: () => string | null

  constructor(options: GitSyncServiceOptions = {}) {
    this.runner = options.runner ?? new SystemGitRunner()
    this.now = options.now ?? (() => new Date())
    this.proxyUrl = options.proxyUrl ?? (() => null)
  }

  /**
   * git 子进程的代理环境：应用里配了代理就用它，没配就沿用进程环境里已有的
   * （用户可能在终端里设过 HTTPS_PROXY）。
   */
  private proxyEnv(): Record<string, string> {
    const configured = this.proxyUrl()
    if (configured) {
      return {
        HTTP_PROXY: configured,
        HTTPS_PROXY: configured,
        http_proxy: configured,
        https_proxy: configured,
        ALL_PROXY: configured,
        all_proxy: configured,
      }
    }
    const inherited: Record<string, string> = {}
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'] as const) {
      const value = process.env[key]
      if (value) inherited[key] = value
    }
    return inherited
  }

  // ---------- git 基础调用 ----------

  private run(workTree: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<GitCommandResult> {
    // core.quotePath=false：中文书名不能被转义成八进制，否则按书拆分的路径对不上。
    return this.runner.run(['-c', 'core.quotePath=false', ...args], {
      cwd: workTree,
      env: { ...process.env, ...this.proxyEnv(), ...env },
    })
  }

  private async mustRun(workTree: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const result = await this.run(workTree, args, env)
    if (result.code !== 0) throw this.failure(result)
    return result.stdout
  }

  private failure(result: GitCommandResult): GitSyncError {
    const text = `${result.stderr}\n${result.stdout}`
    if (/not a git repository/iu.test(text)) return new GitSyncError('GIT_SYNC_NOT_INITIALIZED')
    if (/Authentication failed|could not read Username|terminal prompts disabled|HTTP 401|Invalid username or password/iu.test(text)) {
      return new GitSyncError('GIT_SYNC_AUTH_FAILED')
    }
    if (/Repository not found|does not appear to be a git repository|remote ref.*not found/iu.test(text)) {
      return new GitSyncError('GIT_SYNC_REMOTE_INVALID')
    }
    if (/CONFLICT|would be overwritten|Not possible to fast-forward|non-fast-forward/iu.test(text)) {
      return new GitSyncError('GIT_SYNC_DIVERGED')
    }
    if (/Could not resolve host|unable to access|Connection (timed out|refused)|failed to connect|network is unreachable/iu.test(text)) {
      return new GitSyncError('GIT_SYNC_NETWORK_FAILED')
    }
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
    // 跳过 "To <路径>" / "hint:" 这类噪声，留一条能说明问题的。
    const summary = lines.find(line => !/^To /u.test(line) && !/^hint:/u.test(line)) ?? lines[0] ?? ''
    return new GitSyncError('GIT_SYNC_FAILED', summary.slice(0, 200))
  }

  // ---------- 凭据 ----------

  /**
   * 在单次调用里注入凭据：临时目录 + 单次进程环境，调用结束立刻删除。
   * 并发调用之间不共享任何进程级状态。
   */
  private async withCredentials<T>(
    workTree: string,
    credentials: GitSyncCredentials,
    action: (env: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> {
    const gitDir = path.join(workTree, '.git')
    if (!fs.existsSync(gitDir)) throw new GitSyncError('GIT_SYNC_NOT_INITIALIZED')
    const secretDir = fs.mkdtempSync(path.join(fs.realpathSync(gitDir), 'pagekin-askpass-'))
    try {
      const script = writeAskpassScript(secretDir, credentials)
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_ASKPASS: script,
        GIT_ASKPASS_REQUIRE: 'force',
        SSH_ASKPASS: script,
        GIT_TERMINAL_PROMPT: '0',
      }
      return await action(env)
    } finally {
      try { fs.rmSync(secretDir, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
    }
  }

  // ---------- 读写状态 ----------

  async isInitialized(workTree: string): Promise<boolean> {
    const result = await this.run(workTree, ['rev-parse', '--is-inside-work-tree'])
    return result.code === 0 && result.stdout.trim() === 'true'
  }

  async readRemoteUrl(workTree: string): Promise<string | null> {
    const result = await this.run(workTree, ['remote', 'get-url', REMOTE_NAME])
    const value = result.code === 0 ? result.stdout.trim() : ''
    if (!value) return null
    // 万一历史配置里带了凭据，回给界面之前先剥掉。
    try {
      const parsed = new URL(value)
      parsed.username = ''
      parsed.password = ''
      return parsed.toString().replace(/\/+$/u, '')
    } catch {
      return value
    }
  }

  async status(workTree: string): Promise<GitSyncStatus> {
    const empty: GitSyncStatus = {
      initialized: false, hasRemote: false, remoteUrl: null, branch: 'main',
      pendingFiles: 0, ahead: null, behind: null, diverged: false, lastCommit: null,
    }
    if (!(await this.isInitialized(workTree))) return empty

    const branchResult = await this.run(workTree, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = branchResult.code === 0 && branchResult.stdout.trim() !== 'HEAD'
      ? branchResult.stdout.trim() : 'main'
    const remoteUrl = await this.readRemoteUrl(workTree)
    const porcelain = await this.run(workTree, ['status', '--porcelain'])
    const pendingFiles = porcelain.code === 0
      ? porcelain.stdout.split('\n').filter(line => line.trim()).length
      : 0
    const log = await this.run(workTree, ['log', '-1', `--format=%H${SEP}%s${SEP}%cI`])
    let lastCommit: GitCommitView | null = null
    if (log.code === 0 && log.stdout.trim()) {
      const [sha, subject, committedAt] = log.stdout.trim().split(SEP)
      if (sha && committedAt) lastCommit = { sha, subject: subject ?? '', committedAt }
    }
    let ahead: number | null = null
    let behind: number | null = null
    let diverged = false
    if (remoteUrl && lastCommit) {
      const counts = await this.run(workTree, ['rev-list', '--left-right', '--count', `HEAD...${REMOTE_NAME}/${branch}`])
      if (counts.code === 0) {
        const [left, right] = counts.stdout.trim().split(/\s+/u).map(value => Number(value))
        if (Number.isFinite(left) && Number.isFinite(right)) {
          ahead = left
          behind = right
          diverged = left > 0 && right > 0
        }
      }
    }
    return { initialized: true, hasRemote: Boolean(remoteUrl), remoteUrl, branch, pendingFiles, ahead, behind, diverged, lastCommit }
  }

  // ---------- 初始化 ----------

  async initialize(input: {
    workTree: string
    remoteUrl?: string | null
    branch?: string
    authorName: string
    authorEmail: string
  }): Promise<{ created: boolean }> {
    const created = !(await this.isInitialized(input.workTree))
    if (created) await this.mustRun(input.workTree, ['init', '-b', input.branch?.trim() || 'main'])
    this.ensureIgnoreFile(input.workTree)
    if (input.remoteUrl) {
      const url = normalizeGitRemoteUrl(input.remoteUrl)
      const current = await this.run(input.workTree, ['remote', 'get-url', REMOTE_NAME])
      if (current.code !== 0) await this.mustRun(input.workTree, ['remote', 'add', REMOTE_NAME, url])
      else if (current.stdout.trim() !== url) await this.mustRun(input.workTree, ['remote', 'set-url', REMOTE_NAME, url])
    }
    await this.ensureIdentity(input.workTree, input.authorName, input.authorEmail)
    // 生成的 .gitignore 要立刻进仓库：否则它永远是一条「未提交改动」，
    // 让「本地必须干净」的检查永远失败，拉取就永远被拒。
    const tracked = await this.run(input.workTree, ['ls-files', '--error-unmatch', '.gitignore'])
    if (tracked.code !== 0) {
      await this.mustRun(input.workTree, ['add', '--', '.gitignore'])
      const head = await this.run(input.workTree, ['rev-parse', '--verify', 'HEAD'])
      // 仓库里还没有任何提交时不能 commit；此时 .gitignore 留在暂存区，由首次上传一起提交。
      if (head.code === 0) {
        await this.mustRun(input.workTree, ['commit', '-q', '-m', 'chore: 忽略每台机器各自的运行时文件', '--', '.gitignore'])
      }
    }
    return { created }
  }

  private ensureIgnoreFile(workTree: string): void {
    const ignorePath = path.join(workTree, '.gitignore')
    const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : ''
    const lines = new Set(existing.split(/\r?\n/u).map(line => line.trim()).filter(Boolean))
    let changed = false
    for (const entry of GIT_SYNC_IGNORE_ENTRIES) {
      if (!lines.has(entry)) { lines.add(entry); changed = true }
    }
    if (changed || !fs.existsSync(ignorePath)) {
      fs.writeFileSync(ignorePath, `${[...lines].join('\n')}\n`, 'utf8')
    }
  }

  /** 没有全局 git 身份时就地补一个，绝不改动用户的全局配置。 */
  private async ensureIdentity(workTree: string, name: string, email: string): Promise<void> {
    const currentName = await this.run(workTree, ['config', 'user.name'])
    if (currentName.code !== 0 || !currentName.stdout.trim()) {
      await this.mustRun(workTree, ['config', 'user.name', name])
    }
    const currentEmail = await this.run(workTree, ['config', 'user.email'])
    if (currentEmail.code !== 0 || !currentEmail.stdout.trim()) {
      await this.mustRun(workTree, ['config', 'user.email', email])
    }
  }

  // ---------- 上传 / 拉取（按书） ----------

  /**
   * 上传：逐本拍快照 → 提交 → 确认远端没被别人动过 → 推送。
   *
   * 只提交真正有改动的书：git add 只按给定路径做，没动过的书连暂存区都不会进，
   * 因此不会产生空提交，也就不会出现「同步了别的书」。
   */
  async push(input: {
    workTree: string
    remoteUrl: string
    branch: string
    credentials: GitSyncCredentials
    authorName: string
    authorEmail: string
    /** 要一起提交的作品（相对书库根的路径）；只传这次允许动的书 */
    books: readonly LibraryBook[]
    /** 主进程已关库的书，逐本做一致快照 */
    snapshot: (book: LibraryBook) => Promise<void>
  }): Promise<{ committed: boolean; commit: GitCommitView | null; uploaded: Array<{ relativePath: string; committed: boolean }> }> {
    await this.initialize({
      workTree: input.workTree,
      branch: input.branch,
      authorName: input.authorName,
      authorEmail: input.authorEmail,
    })
    await this.ensureIdentity(input.workTree, input.authorName, input.authorEmail)

    // .gitignore 可能在首次上传前就进了暂存区（初始化时还没 HEAD），一起带上，
    // 否则它会一直挂着「已暂存未提交」，把「本地必须干净」的检查卡死。
    const ignoreStaged = (await this.run(input.workTree, ['diff', '--cached', '--name-only', '--', '.gitignore'])).stdout.trim()
    const commitPaths = (bookPath: string): string[] => (ignoreStaged ? ['.gitignore', bookPath] : [bookPath])

    const uploaded: Array<{ relativePath: string; committed: boolean }> = []
    for (const book of input.books) {
      // 快照放在 add 之前：先合并 WAL，再让 git 看到最终字节。
      await input.snapshot(book)
      await this.mustRun(input.workTree, ['add', '-A', '--', book.relativePath])
      const staged = await this.run(input.workTree, ['diff', '--cached', '--quiet', '--', book.relativePath])
      const hasChanges = staged.code !== 0
      uploaded.push({ relativePath: book.relativePath, committed: hasChanges })
      if (!hasChanges) continue
      const stamp = this.now().toISOString().replace('T', ' ').slice(0, 16)
      await this.mustRun(input.workTree, [
        'commit', '-q', '-m', `sync: ${book.name} · ${input.authorName} @ ${stamp}`, '--', ...commitPaths(book.relativePath),
      ])
    }

    const committed = uploaded.some(entry => entry.committed)
    await this.withCredentials(input.workTree, input.credentials, async env => {
      // 必须先 fetch：否则 origin/main 是上一次的旧引用，分叉检测会失效。
      const fetched = await this.run(input.workTree, ['fetch', REMOTE_NAME, '--prune'], env)
      if (fetched.code !== 0) throw this.failure(fetched)
      const remoteHead = await this.run(input.workTree, ['rev-parse', '--verify', `${REMOTE_NAME}/${input.branch}`], env)
      const remoteHasBranch = remoteHead.code === 0
      if (remoteHasBranch) {
        const ancestor = await this.run(input.workTree, ['merge-base', '--is-ancestor', `${REMOTE_NAME}/${input.branch}`, 'HEAD'], env)
        if (ancestor.code !== 0) throw new GitSyncError('GIT_SYNC_DIVERGED')
      }
      // 远端还没有这个分支（新电脑第一次上传）时，即使这次没有新提交也要把本地历史推上去。
      const head = await this.run(input.workTree, ['rev-parse', '--verify', 'HEAD'])
      if (!committed && remoteHasBranch) return
      if (!remoteHasBranch && head.code !== 0) return
      const pushed = await this.run(input.workTree, ['push', REMOTE_NAME, `HEAD:${input.branch}`], env)
      if (pushed.code !== 0) throw this.failure(pushed)
    })
    return { committed, commit: committed ? await this.readHead(input.workTree) : null, uploaded }
  }

  /** 拉取：本地必须干净，只允许快进。 */
  async pull(input: {
    workTree: string
    remoteUrl: string
    branch: string
    credentials: GitSyncCredentials
    authorName: string
    authorEmail: string
    /** 书库里的作品，用于按书判断冲突 */
    books?: readonly LibraryBook[]
    /** 检出之后清掉错配的 -wal/-shm，并报告哪些书变了 */
    afterCheckout: (changedBooks: readonly string[]) => Promise<void>
  }): Promise<{ updated: boolean; commit: GitCommitView | null; changedBooks: string[] }> {
    await this.initialize({
      workTree: input.workTree,
      branch: input.branch,
      authorName: input.authorName,
      authorEmail: input.authorEmail,
    })
    return this.withCredentials(input.workTree, input.credentials, async env => {
      const fetched = await this.run(input.workTree, ['fetch', REMOTE_NAME, '--prune'], env)
      if (fetched.code !== 0) throw this.failure(fetched)
      const remoteBranch = await this.run(input.workTree, ['rev-parse', '--verify', `${REMOTE_NAME}/${input.branch}`], env)
      if (remoteBranch.code !== 0) throw new GitSyncError('GIT_SYNC_REMOTE_EMPTY')
      // 只有「远端要更新、本机又没上传」的书才算冲突；没动过的书有本地改动不影响拉取。
      const inspection = await this.inspectPull(input.workTree, input.books ?? [], `${REMOTE_NAME}/${input.branch}`)
      if (inspection.conflicts.length > 0) {
        throw new GitSyncError('GIT_SYNC_LOCAL_CHANGES', inspection.conflicts.join('、'))
      }
      const remoteSha = remoteBranch.stdout.trim()
      const head = await this.run(input.workTree, ['rev-parse', 'HEAD'])
      const headSha = head.code === 0 ? head.stdout.trim() : ''
      if (headSha === remoteSha) return { updated: false, commit: null, changedBooks: [] }
      // 先记下这次会动到哪些书，检出后再交给调用方清理运行时文件。
      const changedBooks = headSha
        ? await this.changedBookPaths(input.workTree, `${headSha}..${remoteSha}`)
        : []
      if (!headSha) {
        await this.mustRun(input.workTree, ['checkout', '-B', input.branch, remoteSha], env)
      } else {
        const merged = await this.run(input.workTree, ['merge', '--ff-only', remoteSha], env)
        if (merged.code !== 0) throw new GitSyncError('GIT_SYNC_DIVERGED')
      }
      await input.afterCheckout(changedBooks)
      return { updated: true, commit: await this.readHead(input.workTree), changedBooks }
    })
  }

  /**
   * 拉取前的体检：远端这次要改哪些书、本机哪些书还有没上传的改动、两者是否撞车。
   * 只读，不关库也不改文件，所以可以在关库之前调用。
   */
  async inspectPull(
    libraryRoot: string,
    books: readonly LibraryBook[],
    remoteRef: string,
  ): Promise<{ incoming: string[]; dirty: string[]; conflicts: string[] }> {
    const incoming = await this.changedBookPaths(libraryRoot, `HEAD..${remoteRef}`)
    const dirty = await this.dirtyBookPaths(libraryRoot, books)
    const conflicts = incoming.filter(name => dirty.includes(name))
    return { incoming, dirty, conflicts }
  }

  /** 带凭据的一次体检（要 fetch，远端才准）。 */
  async inspectPullWithCredentials(
    libraryRoot: string,
    books: readonly LibraryBook[],
    branch: string,
    credentials: GitSyncCredentials,
  ): Promise<{ incoming: string[]; dirty: string[]; conflicts: string[] }> {
    if (!(await this.isInitialized(libraryRoot))) {
      return { incoming: [], dirty: [], conflicts: [] }
    }
    return this.withCredentials(libraryRoot, credentials, async env => {
      const fetched = await this.run(libraryRoot, ['fetch', REMOTE_NAME, '--prune'], env)
      if (fetched.code !== 0) throw this.failure(fetched)
      const remote = await this.run(libraryRoot, ['rev-parse', '--verify', `${REMOTE_NAME}/${branch}`], env)
      if (remote.code !== 0) return { incoming: [], dirty: [], conflicts: [] }
      return this.inspectPull(libraryRoot, books, `${REMOTE_NAME}/${branch}`)
    })
  }

  /** 本机还有没上传内容的书：git 认为是改动，或者还有没合并进库的 -wal。 */
  async dirtyBookPaths(libraryRoot: string, books: readonly LibraryBook[]): Promise<string[]> {
    const dirty = new Set<string>()
    const status = await this.run(libraryRoot, ['status', '--porcelain', '--', ...books.map(book => book.relativePath)])
    if (status.code === 0) {
      for (const line of status.stdout.split('\n')) {
        if (!line.trim()) continue
        const top = line.slice(3).trim().split('/')[0]
        if (top) dirty.add(top)
      }
    }
    // 写作先落 WAL：只看 git status 会漏掉刚写完还没上传的内容。
    for (const book of books) {
      const wal = path.join(book.rootPath, CANONICAL_PROJECT_DIRECTORY, `${CANONICAL_PROJECT_DATABASE}-wal`)
      try {
        if (fs.statSync(wal).size > 0) dirty.add(book.relativePath.split('/')[0] ?? book.relativePath)
      } catch { /* 没有 WAL 就是干净 */ }
    }
    return [...dirty].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
  }

  /** 逐本判断有没有改动（只读 git status，不写任何东西）。 */
  async bookChanges(libraryRoot: string, books: readonly LibraryBook[]): Promise<GitBookStatus[]> {
    const root = path.resolve(libraryRoot)
    const result = await this.run(root, ['status', '--porcelain', '--', ...books.map(book => book.relativePath).filter(Boolean)])
    const changedTops = new Set<string>()
    if (result.code === 0) {
      for (const line of result.stdout.split('\n')) {
        if (!line.trim()) continue
        // porcelain 前两列是状态位，第三列起是路径。
        const entry = line.slice(3).trim()
        const [top] = entry.split('/')
        if (top) changedTops.add(top)
      }
    }
    return books.map(book => ({
      relativePath: book.relativePath,
      name: book.name,
      rootPath: book.rootPath,
      changed: changedTops.has(book.relativePath.split('/')[0] ?? book.relativePath),
      current: false,
    }))
  }

  /** 两次提交之间动到的作品目录（第一层）。 */
  private async changedBookPaths(workTree: string, range: string): Promise<string[]> {
    const names = await this.run(workTree, ['diff', '--name-only', range])
    if (names.code !== 0) return []
    const books = new Set<string>()
    for (const file of names.stdout.split('\n')) {
      const [top] = file.split('/')
      if (top) books.add(top)
    }
    return [...books].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
  }

  private async readHead(workTree: string): Promise<GitCommitView | null> {
    const log = await this.run(workTree, ['log', '-1', `--format=%H${SEP}%s${SEP}%cI`])
    if (log.code !== 0 || !log.stdout.trim()) return null
    const [sha, subject, committedAt] = log.stdout.trim().split(SEP)
    return sha ? { sha, subject: subject ?? '', committedAt: committedAt ?? '' } : null
  }
}
