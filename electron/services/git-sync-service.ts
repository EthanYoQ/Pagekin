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

import { spawn, spawnSync } from 'node:child_process'
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


/** 同步问 git：路径是否已被跟踪。失败（未初始化、无该文件）都按「没有」处理。 */
function spawnSyncGit(workTree: string, args: readonly string[]): boolean {
  try {
    const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: workTree, stdio: 'ignore' })
    return result.status === 0
  } catch {
    return false
  }
}

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

export interface GitSyncPushInput {
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
  /** 分叉自动合并后，告诉调用方哪些书被远端改回来了，好清 -wal/-shm 并校验库 */
  afterReconcile?: (changedBooks: readonly string[], keptLocal: readonly string[], tookRemote: readonly string[]) => Promise<void>
}

export interface GitSyncPullResult {
  updated: boolean
  commit: GitCommitView | null
  changedBooks: string[]
  /** 按书对齐时：保留本机的作品 / 采用远端的作品 */
  keptLocal: string[]
  tookRemote: string[]
  /** 「以远端为准」时本机原提交存到的备份分支 */
  backupRef: string | null
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

  /**
   * 只刷新远端引用，用于让界面上的 ahead/behind/diverged 反映真实远端。
   * 不关库、不改工作区；失败就静默保留旧读数（离线时界面不该报错）。
   */
  async refreshRemoteRefs(workTree: string, branch: string, credentials: GitSyncCredentials): Promise<boolean> {
    if (!(await this.isInitialized(workTree))) return false
    try {
      return await this.withCredentials(workTree, credentials, async env => {
        const fetched = await this.run(workTree, ['fetch', REMOTE_NAME, '--prune'], env)
        if (fetched.code !== 0) return false
        // fetch 只更新 refs/remotes，本地 HEAD 不动，所以这个操作永远安全。
        const remote = await this.run(workTree, ['rev-parse', '--verify', `${REMOTE_NAME}/${branch}`], env)
        return remote.code === 0
      })
    } catch {
      return false
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
    // 只在仓库里还没有可跟踪的 .gitignore 时才写它；已经跟踪的绝不能改写——
    // 那会让一台本来干净的本机凭空多出「待上传改动」，作者拉取后总看到「有 N 个文件待上传」。
    this.ensureIgnoreFile(input.workTree)
    if (input.remoteUrl) {
      const url = normalizeGitRemoteUrl(input.remoteUrl)
      const current = await this.run(input.workTree, ['remote', 'get-url', REMOTE_NAME])
      if (current.code !== 0) await this.mustRun(input.workTree, ['remote', 'add', REMOTE_NAME, url])
      else if (current.stdout.trim() !== url) await this.mustRun(input.workTree, ['remote', 'set-url', REMOTE_NAME, url])
    }
    await this.ensureIdentity(input.workTree, input.authorName, input.authorEmail)
    // 忽略规则不写进仓库，改写到 .git/info/exclude：
    //   - 它是本机的，不产生提交，也就绝不会让两台电脑各自新增同一个文件而分叉；
    //   - 又确实让运行时文件不进 git status，拉取前的「本地必须干净」检查能通过。
    // 之前这里会 commit 一个 .gitignore，远端本来就有这个文件时，本机就凭空多一个提交，
    // 任何一次拉取都会退化成「分叉」，作者只会看到「打开项目失败」。
    this.ensureExcludeFile(input.workTree)
    return { created }
  }

  /**
   * 生成 .gitignore 仅用于「仓库里还没有这份文件」的初始情形。
   * 文件一旦被 git 跟踪，就绝不能再改写：忽略规则改由 .git/info/exclude 承担，
   * 否则每次同步都会把它变成一条未提交改动。
   */
  private ensureIgnoreFile(workTree: string): void {
    const ignorePath = path.join(workTree, '.gitignore')
    // 已跟踪 → 原样不动。
    const tracked = spawnSyncGit(workTree, ['ls-files', '--error-unmatch', '.gitignore'])
    if (tracked) return
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

  /** 把运行时文件的忽略规则写进 .git/info/exclude：只影响本机，不进仓库。 */
  private ensureExcludeFile(workTree: string): void {
    const gitDir = path.join(workTree, '.git')
    if (!fs.existsSync(gitDir)) return
    const excludePath = path.join(gitDir, 'info', 'exclude')
    try {
      fs.mkdirSync(path.dirname(excludePath), { recursive: true })
      const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : ''
      const lines = new Set(existing.split(/\r?\n/u).map(line => line.trim()).filter(Boolean))
      let changed = false
      for (const entry of GIT_SYNC_IGNORE_ENTRIES) {
        if (!lines.has(entry)) { lines.add(entry); changed = true }
      }
      if (changed) fs.writeFileSync(excludePath, `${[...lines].join('\n')}\n`, 'utf8')
    } catch { /* 忽略规则写不进去不该阻断同步，后面还有 status 检查兜底 */ }
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
  async push(input: GitSyncPushInput): Promise<{ committed: boolean; commit: GitCommitView | null; uploaded: Array<{ relativePath: string; committed: boolean }> }> {
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

    return this.withCredentials(input.workTree, input.credentials, async env => {
      // 先 fetch 再提交：反过来会让「检测到分叉」时本机的提交已经落下，
      // 于是本机凭空多出一个没人推上去的提交，下次拉取就只能走合并。
      const fetched = await this.run(input.workTree, ['fetch', REMOTE_NAME, '--prune'], env)
      if (fetched.code !== 0) throw this.failure(fetched)
      const remoteHead = await this.run(input.workTree, ['rev-parse', '--verify', `${REMOTE_NAME}/${input.branch}`], env)
      const remoteHasBranch = remoteHead.code === 0

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
      let reconciled: { changedBooks: string[]; keptLocal: string[]; tookRemote: string[] } | null = null
      if (remoteHasBranch) {
        const remoteSha = remoteHead.stdout.trim()
        const ancestor = await this.run(input.workTree, ['merge-base', '--is-ancestor', remoteSha, 'HEAD'], env)
        if (ancestor.code !== 0) {
          // 远端在两次同步之间被另一台推过。此时不能硬推：那会删掉对方的章节。
          // 也不能就这么失败：本机提交已经在本地，失败一次就永久卡住。
          // 按书三方合并——每本书整体取一边，数据库字节永不逐行合并。
          reconciled = await this.reconcileWithRemote(input.workTree, input, remoteSha, env)
          if (!reconciled) throw new GitSyncError('GIT_SYNC_DIVERGED')
        }
      }
      // 远端还没有这个分支（新电脑第一次上传）时，即使这次没有新提交也要把本地历史推上去。
      const head = await this.run(input.workTree, ['rev-parse', '--verify', 'HEAD'])
      const needsPush = reconciled !== null || committed || !remoteHasBranch
      if (needsPush && head.code !== 0) return { committed, commit: null, uploaded }
      if (needsPush) {
        const pushed = await this.run(input.workTree, ['push', REMOTE_NAME, `HEAD:${input.branch}`], env)
        if (pushed.code !== 0) throw this.failure(pushed)
        // 推完让本机的 origin/<branch> 跟上，界面上的 ahead/behind 才不会继续显示分叉。
        // 用推完的真实远端引用，而不是推之前读的 HEAD。
        const landed = await this.run(input.workTree, ['rev-parse', 'HEAD'], env)
        if (landed.code === 0) {
          await this.run(input.workTree, ['update-ref', `refs/remotes/${REMOTE_NAME}/${input.branch}`, landed.stdout.trim()], env)
        }
      }
      if (reconciled) await input.afterReconcile?.(reconciled.changedBooks, reconciled.keptLocal, reconciled.tookRemote)
      const didWork = reconciled !== null || committed
      return { committed: didWork, commit: didWork ? await this.readHead(input.workTree) : null, uploaded }
    })
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
  }): Promise<GitSyncPullResult> {
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
      if (headSha === remoteSha) {
        return { updated: false, commit: null, changedBooks: [], keptLocal: [], tookRemote: [], backupRef: null }
      }
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
      return {
        updated: true,
        commit: await this.readHead(input.workTree),
        changedBooks,
        keptLocal: [],
        tookRemote: changedBooks,
        backupRef: null,
      }
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

  /** 某个树里第一层的作品目录（带 .ai-novel/project.json 的目录）。 */
  private async listTreeBooks(workTree: string, treeish: string): Promise<string[]> {
    const listed = await this.run(workTree, ['ls-tree', '-r', '--name-only', '-z', treeish])
    if (listed.code !== 0) return []
    const books = new Set<string>()
    for (const file of listed.stdout.split('\0')) {
      if (!file) continue
      const parts = file.split('/')
      if (parts.length === 3 && parts[1] === CANONICAL_PROJECT_DIRECTORY && parts[2] === 'project.json') {
        books.add(parts[0] as string)
      }
    }
    return [...books]
  }

  /**
   * 分叉时按书合并：每本书整体取一边，绝不逐行合并 SQLite / LanceDB。
   *
   * 判断依据是三方（共同祖先 base、本机 HEAD、远端）：
   *   - 只有本机动过 → 保留本机；
   *   - 只有远端动过 → 取远端（本机没改，没有可丢的东西）；
   *   - 两边都动过 → 默认保留本机（「以本机为准」），对方那版仍留在 git 历史里，随时能找回。
   * 合并结果是一个正常的双亲提交，所以不需要 force push，也不会删掉任何历史。
   */
  private async reconcileWithRemote(
    workTree: string,
    input: GitSyncPushInput,
    remoteSha: string,
    env: NodeJS.ProcessEnv,
  ): Promise<{ changedBooks: string[]; keptLocal: string[]; tookRemote: string[] } | null> {
    // 一律用刚 fetch 到的远端 SHA，不用 origin/<branch> 这个引用：
    // 合并/推送之后它不会自动前移，拿它算差异会把已合上的书又算一遍。
    const baseResult = await this.run(workTree, ['merge-base', 'HEAD', remoteSha], env)
    const hasCommonBase = baseResult.code === 0 && Boolean(baseResult.stdout.trim())
    // 空树：git 里的常量，直接写死（不依赖 /dev/null，Windows 上没有这个路径）。
    const baseSha = hasCommonBase ? baseResult.stdout.trim() : '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
    // 空树作基时，区间写成「空树..X」，等价于「X 相对空树新增的全部文件」。
    let ours = await this.changedBookPaths(workTree, `${baseSha}..HEAD`)
    let theirs = await this.changedBookPaths(workTree, `${baseSha}..${remoteSha}`)
    // 别把 .gitignore 这类顶层条目当成一本书。
    const bookPaths = new Set(input.books.map(book => book.relativePath))
    // 远端可能有本机书库里还不存在的书（新电脑第一次接上已有仓库）：
    // 这不是「本机的一本书」，仍要参与合并，否则它会被静默丢掉。
    const remoteBooks = await this.listTreeBooks(workTree, remoteSha)
    for (const name of remoteBooks) bookPaths.add(name)
    ours = ours.filter(name => bookPaths.has(name))
    theirs = theirs.filter(name => bookPaths.has(name))


    // 不用 `git merge`：它会先检查工作区，只要有一个不相干的文件（比如被重新生成过的
    // .gitignore）挡住，整次合并就失败——用户点了「以本机为准」却只看到「分叉」。
    // 也不用 `read-tree -m`：两边没有共同祖先时它会静默丢掉远端独有的整本书。
    //
    // 改成确定性构造：先把远端整棵树放进索引（保证远端独有的东西一个不少），
    // 再把「要保留本机」的书整本覆盖回去。只算索引，不碰工作区，也不会留下冲突标记。
    const mergeHead = await this.run(workTree, ['rev-parse', '--verify', '-q', 'MERGE_HEAD'], env)
    if (mergeHead.code === 0) {
      // 上一版可能留下半截合并状态，它会让后续 git 命令全部报错。只重置索引，不动工作区。
      await this.run(workTree, ['reset', '-q'], env)
    }
    const oldHead = (await this.run(workTree, ['rev-parse', 'HEAD'], env)).stdout.trim()
    // 以远端那棵树为起点。
    const seeded = await this.run(workTree, ['read-tree', remoteSha], env)
    if (seeded.code !== 0) { if (process.env.PAGEKIN_DEBUG_SYNC) console.error('[sync] read-tree failed', seeded.stderr); return null }

    // 逐本比较「本机这一版」与「远端这一版」的实际内容，而不是只看提交区间：
    // 没有共同祖先时（两台各自 init），区间会把所有书都算成「两边都改过」，
    // 结果远端独有的版本永远拿不回来。按内容判定对两种情形都成立。
    const subtreeOf = async (treeish: string, book: string): Promise<string | null> => {
      const result = await this.run(workTree, ['rev-parse', '--verify', '-q', `${treeish}:${book}`], env)
      return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null
    }
    const allBooks = [...new Set([...ours, ...theirs, ...input.books.map(book => book.relativePath)])]
      .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
    const keptLocal: string[] = []
    const tookRemote: string[] = []
    for (const book of allBooks) {
      const localTree = await subtreeOf('HEAD', book)
      const remoteTree = await subtreeOf(remoteSha, book)
      // 本机没有这本 → 只能取远端。
      if (!localTree) { if (remoteTree) tookRemote.push(book); continue }
      // 两边一模一样 → 不需要动，算保留本机。
      if (localTree === remoteTree) { keptLocal.push(book); continue }
      // 内容不同，要看是谁动的：
      //   有共同祖先 → 远端动过而本机没动过，才取远端；两边都动过以本机为准。
      //   没有共同祖先 → 无从判断谁动过，本机有这本就保留本机。
      const wantRemote = hasCommonBase && theirs.includes(book) && !ours.includes(book)
      if (wantRemote && remoteTree) { tookRemote.push(book); continue }
      // 保留本机：把这本书整本换成本机那一版（含本机已删掉的文件）。
      //
      // 必须先把这个前缀下的条目从索引里彻底清掉，否则 `read-tree --prefix` 会报
      // "Entry ... overlaps ... Cannot bind"。`git rm --cached` 只处理 HEAD 里有的路径，
      // 对刚从远端读进来的条目无效，所以这里按索引实际内容逐条移除。
      const inIndex = await this.run(workTree, ['ls-files', '-z', '--', book], env)
      for (const file of inIndex.stdout.split('\0')) {
        if (!file) continue
        await this.run(workTree, ['update-index', '--force-remove', '--', file], env)
      }
      const restored = await this.run(workTree, ['read-tree', `--prefix=${book}/`, `HEAD:${book}`], env)
      if (restored.code !== 0) return null
      keptLocal.push(book)
    }

    // 本机独有的非书文件（.gitignore 之类）不能因为索引以远端为起点而消失：
    // 把它们原样补回索引。已经存在的路径不动，避免覆盖远端更新过的内容。
    const localTop = await this.run(workTree, ['ls-tree', '--name-only', '-z', 'HEAD'], env)
    for (const entry of localTop.stdout.split('\0')) {
      if (!entry || bookPaths.has(entry)) continue
      const inRemote = await this.run(workTree, ['rev-parse', '--verify', '-q', `${remoteSha}:${entry}`], env)
      if (inRemote.code === 0) continue
      const inIndexNow = await this.run(workTree, ['ls-files', '-z', '--', entry], env)
      if (inIndexNow.stdout.trim()) continue
      // 当前条目的 blob 与模式，直接写回索引（read-tree 只接受树，不接受单个文件）。
      const describe = await this.run(workTree, ['ls-tree', 'HEAD', '--', entry], env)
      const [meta, name] = describe.stdout.split('\t')
      const [mode, type, sha] = (meta ?? '').split(' ')
      if (!name || type !== 'blob' || !sha) continue
      await this.run(workTree, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${name}`], env)
    }

    const tree = await this.run(workTree, ['write-tree'], env)
    if (tree.code !== 0) return null
    const stamp = this.now().toISOString().replace('T', ' ').slice(0, 16)
    const created = await this.run(workTree, [
      'commit-tree', tree.stdout.trim(), '-p', oldHead, '-p', remoteSha,
      '-m', `merge: 与远端对齐（${input.authorName} @ ${stamp}）`,
    ], env)
    if (created.code !== 0) return null
    const newSha = created.stdout.trim()

    // 移动当前分支到这次合并提交；索引这时已经等于新树。
    const branchRef = await this.run(workTree, ['symbolic-ref', '-q', 'HEAD'], env)
    const target = branchRef.code === 0 ? branchRef.stdout.trim() : 'HEAD'
    const moved = await this.run(workTree, ['update-ref', target, newSha, oldHead], env)
    if (moved.code !== 0) return null

    // 只把「真的变了」的文件写回工作区：没动过的书保持原样，mtime 与 inode 都不变。
    const changed = await this.run(workTree, ['diff', '--name-only', '-z', oldHead, newSha], env)
    for (const file of changed.stdout.split('\0')) {
      if (!file) continue
      const exists = await this.run(workTree, ['cat-file', '-e', `${newSha}:${file}`], env)
      if (exists.code === 0) {
        await this.run(workTree, ['checkout-index', '-f', '--', file], env)
      } else {
        try { fs.rmSync(path.join(workTree, file), { force: true }) } catch { /* 尽力删除 */ }
      }
    }

    // 保持索引与新的 HEAD 一致，避免下次操作抱怨。
    await this.run(workTree, ['reset', '-q'], env)

    const changedBooks = [...new Set([...keptLocal, ...tookRemote])]
      .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
    return { changedBooks, keptLocal, tookRemote }
  }

  /**
   * 「以本机为准」：把本机这一版强制变成远端的最新版。
   *
   * 走的是 push 的路径：先把本机改动提交，再和远端按书对齐，最后推上去。
   * 不能走 pull —— pull 的前置检查会以「本机有未上传改动」为由直接拒绝，
   * 而这正是本操作要处理的情况。
   */
  async forceUpload(input: GitSyncPushInput): Promise<{
    committed: boolean
    commit: GitCommitView | null
    keptLocal: string[]
    tookRemote: string[]
  }> {
    let keptLocal: string[] | null = null
    let tookRemote: string[] = []
    const pushed = await this.push({
      ...input,
      // 调用方（控制器）也要在这时清理被换掉的书，不能被我这里覆盖掉。
      afterReconcile: async (changed, kept, took) => {
        keptLocal = [...kept]
        tookRemote = [...took]
        await input.afterReconcile?.(changed, kept, took)
      },
    })
    return {
      committed: pushed.committed,
      commit: pushed.commit,
      // 没发生分叉合并时，本机这些书原样推了上去，全部算「保留本机」。
      keptLocal: keptLocal ?? input.books.map(book => book.relativePath),
      tookRemote,
    }
  }

  /**
   * 「以远端为准」：把本机退回到远端那一版，本机此前的提交另存成一个备份分支，
   * 不删任何东西。用于本机这一版是误操作、想要远端那版的情形。
   */
  async followRemote(input: {
    workTree: string
    branch: string
    credentials: GitSyncCredentials
    authorName: string
    authorEmail: string
    afterCheckout: (changedBooks: readonly string[]) => Promise<void>
  }): Promise<{ updated: boolean; backupRef: string | null; changedBooks: string[]; commit: GitCommitView | null }> {
    return this.withCredentials(input.workTree, input.credentials, async env => {
      const fetched = await this.run(input.workTree, ['fetch', REMOTE_NAME, '--prune'], env)
      if (fetched.code !== 0) throw this.failure(fetched)
      const remoteRef = `${REMOTE_NAME}/${input.branch}`
      const remote = await this.run(input.workTree, ['rev-parse', '--verify', remoteRef], env)
      if (remote.code !== 0) throw new GitSyncError('GIT_SYNC_REMOTE_EMPTY')
      const remoteSha = remote.stdout.trim()
      const head = await this.run(input.workTree, ['rev-parse', '--verify', 'HEAD'])
      const headSha = head.code === 0 ? head.stdout.trim() : ''
      if (headSha === remoteSha) {
        return { updated: false, backupRef: null, changedBooks: [], commit: await this.readHead(input.workTree) }
      }

      let backupRef: string | null = null
      if (headSha) {
        // 本机独有的提交先留一个分支引用：界面上能看到，也能用 git 找回。
        backupRef = `pagekin-backup/${this.now().toISOString().replace(/[:.]/gu, '-')}`
        await this.mustRun(input.workTree, ['branch', backupRef, headSha])
      }
      const changedBooks = headSha ? await this.changedBookPaths(input.workTree, `${headSha}..${remoteSha}`) : []
      // -f：本机这些书的改动就是这次要丢弃的，调用方已在界面上确认过。
      await this.mustRun(input.workTree, ['checkout', '-f', '-B', input.branch, remoteSha], env)
      await input.afterCheckout(changedBooks)
      return { updated: true, backupRef, changedBooks, commit: await this.readHead(input.workTree) }
    })
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
