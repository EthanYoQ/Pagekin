/**
 * 远端仓库托管服务的最小客户端：只用 token 调 HTTPS API，
 * 不做任何浏览器跳转，也不把 token 写进日志或错误里。
 *
 * 目前支持 GitHub 与 Gitee（两者都是「个人访问令牌 + REST」的模式）。
 */

import type { GitSyncHost } from '../../src/shared/git-sync'

export class GitHostError extends Error {
  constructor(
    readonly code: 'GIT_HOST_AUTH_FAILED' | 'GIT_HOST_NAME_TAKEN' | 'GIT_HOST_NETWORK_FAILED' | 'GIT_HOST_FAILED',
    readonly detail?: string,
  ) {
    super(code)
    this.name = 'GitHostError'
  }
}

export interface RemoteRepositorySummary {
  fullName: string
  cloneUrl: string
  private: boolean
  updatedAt: string
}

export interface RemoteRepository {
  /** 可直接用于 git 的 https 地址（不带凭据） */
  cloneUrl: string
  fullName: string
  defaultBranch: string
}

export interface GitHostClientOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 20_000

/** 只保留一行、且绝不包含 token 的摘要。 */
function summarize(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const record = body as Record<string, unknown>
  const message = typeof record.message === 'string' ? record.message : ''
  return message.split('\n')[0]?.slice(0, 200) ?? ''
}

export class GitHostClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: GitHostClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async request(
    host: GitSyncHost,
    path: string,
    token: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const base = host === 'gitee' ? 'https://gitee.com/api/v5' : 'https://api.github.com'
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'pagekin-git-sync',
    }
    if (host === 'gitee') {
      // Gitee 的 v5 用 access_token 查询参数；放在 query 里，不进 URL 的可见部分也无妨。
      const separator = path.includes('?') ? '&' : '?'
      path = `${path}${separator}access_token=${encodeURIComponent(token)}`
    } else {
      headers.Authorization = `Bearer ${token}`
      headers['X-GitHub-Api-Version'] = '2022-11-28'
    }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      })
    } catch {
      throw new GitHostError('GIT_HOST_NETWORK_FAILED')
    } finally {
      clearTimeout(timer)
    }
    let body: unknown = null
    try { body = await response.json() } catch { body = null }
    return { ok: response.ok, status: response.status, body }
  }

  /** 用 token 换到账号名：新电脑上「账号」一栏可以自动填好。 */
  async identify(host: GitSyncHost, token: string): Promise<string> {
    const result = await this.request(host, '/user', token)
    if (result.status === 401 || result.status === 403) throw new GitHostError('GIT_HOST_AUTH_FAILED')
    if (!result.ok) throw new GitHostError('GIT_HOST_FAILED', summarize(result.body))
    const record = (result.body ?? {}) as Record<string, unknown>
    const login = host === 'gitee'
      ? (typeof record.login === 'string' ? record.login : typeof record.name === 'string' ? record.name : '')
      : (typeof record.login === 'string' ? record.login : '')
    if (!login) throw new GitHostError('GIT_HOST_FAILED')
    return login
  }

  /** 建一个私有仓库；已存在时给出可读的「名字被占用」。 */
  async createRepository(input: {
    host: GitSyncHost
    token: string
    name: string
    description?: string
  }): Promise<RemoteRepository> {
    const name = input.name.trim()
    if (!name) throw new GitHostError('GIT_HOST_FAILED')
    const result = input.host === 'gitee'
      ? await this.request('gitee', '/user/repos', input.token, {
        method: 'POST',
        body: { name, private: true, auto_init: false, description: input.description ?? '' },
      })
      : await this.request('github', '/user/repos', input.token, {
        method: 'POST',
        body: {
          name,
          private: true,
          auto_init: false,
          description: input.description ?? '',
          has_issues: false,
          has_wiki: false,
        },
      })

    if (result.status === 401 || result.status === 403) throw new GitHostError('GIT_HOST_AUTH_FAILED')
    // 422 + name already exists：换个名字再试
    if (result.status === 422) {
      const body = (result.body ?? {}) as Record<string, unknown>
      const errors = Array.isArray(body.errors) ? body.errors : []
      const taken = errors.some(item => item && typeof item === 'object'
        && String((item as Record<string, unknown>).message ?? '').toLowerCase().includes('already exist'))
      throw new GitHostError(taken ? 'GIT_HOST_NAME_TAKEN' : 'GIT_HOST_FAILED', summarize(result.body))
    }
    if (!result.ok) throw new GitHostError('GIT_HOST_FAILED', summarize(result.body))

    const record = (result.body ?? {}) as Record<string, unknown>
    const cloneUrl = typeof record.clone_url === 'string'
      ? record.clone_url
      : typeof record.html_url === 'string' ? `${record.html_url}.git` : ''
    const fullName = typeof record.full_name === 'string'
      ? record.full_name
      : typeof record.path_with_namespace === 'string' ? record.path_with_namespace : name
    if (!cloneUrl) throw new GitHostError('GIT_HOST_FAILED')
    return {
      cloneUrl,
      fullName,
      defaultBranch: typeof record.default_branch === 'string' && record.default_branch
        ? record.default_branch
        : 'main',
    }
  }

  /** 列出账号下的仓库（按最近更新），用于「已经有备份仓库就别再建一个」。 */
  async listRepositories(host: GitSyncHost, token: string): Promise<RemoteRepositorySummary[]> {
    const result = host === 'gitee'
      ? await this.request('gitee', '/user/repos?per_page=100&sort=updated', token)
      : await this.request('github', '/user/repos?per_page=100&sort=updated&affiliation=owner', token)
    if (result.status === 401 || result.status === 403) throw new GitHostError('GIT_HOST_AUTH_FAILED')
    if (!result.ok) throw new GitHostError('GIT_HOST_FAILED', summarize(result.body))
    if (!Array.isArray(result.body)) return []
    const repositories: RemoteRepositorySummary[] = []
    for (const item of result.body) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const fullName = typeof record.full_name === 'string'
        ? record.full_name
        : typeof record.path_with_namespace === 'string' ? record.path_with_namespace : ''
      const cloneUrl = typeof record.clone_url === 'string'
        ? record.clone_url
        : typeof record.html_url === 'string' ? `${record.html_url}.git` : ''
      if (!fullName || !cloneUrl) continue
      repositories.push({
        fullName,
        cloneUrl,
        private: record.private === true,
        updatedAt: typeof record.updated_at === 'string' ? record.updated_at : '',
      })
    }
    return repositories
  }

  /**
   * 确认一个仓库确实装的是书童作品：根目录下至少有一个文件夹带 .ai-novel。
   * 连接错仓库再上传会很危险，所以宁可多问一次。
   */
  async looksLikeBookLibrary(host: GitSyncHost, token: string, fullName: string): Promise<boolean> {
    const contents = host === 'gitee'
      ? await this.request('gitee', `/repos/${fullName}/contents`, token)
      : await this.request('github', `/repos/${fullName}/contents`, token)
    if (contents.status === 404) return false
    if (!contents.ok) throw new GitHostError('GIT_HOST_FAILED', summarize(contents.body))
    if (!Array.isArray(contents.body)) return false
    const directories = contents.body
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .filter(item => item.type === 'dir' && typeof item.name === 'string')
      .map(item => String(item.name))
    for (const directory of directories.slice(0, 3)) {
      const marker = host === 'gitee'
        ? await this.request('gitee', `/repos/${fullName}/contents/${encodeURIComponent(directory)}/.ai-novel`, token)
        : await this.request('github', `/repos/${fullName}/contents/${encodeURIComponent(directory)}/.ai-novel`, token)
      if (marker.ok) return true
    }
    // 也兼容早期「一本书就是仓库根」的布局
    const legacy = host === 'gitee'
      ? await this.request('gitee', `/repos/${fullName}/contents/.ai-novel`, token)
      : await this.request('github', `/repos/${fullName}/contents/.ai-novel`, token)
    return legacy.ok
  }

  /** 仓库名已被占用时，依次试 name-2、name-3…（最多 5 个）。 */
  async createRepositoryWithFallback(input: {
    host: GitSyncHost
    token: string
    name: string
    description?: string
  }): Promise<RemoteRepository> {
    const base = input.name.trim() || 'pagekin-library'
    let lastError: unknown
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const candidate = attempt === 1 ? base : `${base}-${attempt}`
      try {
        return await this.createRepository({ ...input, name: candidate })
      } catch (error) {
        lastError = error
        if (!(error instanceof GitHostError) || error.code !== 'GIT_HOST_NAME_TAKEN') throw error
      }
    }
    throw lastError instanceof Error ? lastError : new GitHostError('GIT_HOST_NAME_TAKEN')
  }
}
