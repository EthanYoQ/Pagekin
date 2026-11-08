import { describe, expect, it, vi } from 'vitest'

import { GitHostClient, GitHostError } from '../git-host-client'

/**
 * 托管站客户端只做三件事：认账号、建私有仓库、名字撞了就换一个。
 * 用假的 fetch 验证请求形状与错误映射，不打真实网络。
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('GitHub / Gitee 建库客户端', () => {
  it('用 token 认出账号', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { login: 'octocat' }))
    const client = new GitHostClient({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.identify('github', 'tok')).resolves.toBe('octocat')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.github.com/user')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('token 无效时给出认证失败，不回显 token', async () => {
    const client = new GitHostClient({
      fetchImpl: (async () => jsonResponse(401, { message: 'Bad credentials' })) as unknown as typeof fetch,
    })
    await expect(client.identify('github', 'secret-token')).rejects.toMatchObject({ code: 'GIT_HOST_AUTH_FAILED' })
    try {
      await client.identify('github', 'secret-token')
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('secret-token')
    }
  })

  it('建的是私有仓库，且能从响应里拿到 https 地址', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, {
      clone_url: 'https://github.com/me/pagekin-library.git',
      full_name: 'me/pagekin-library',
      default_branch: 'main',
    }))
    const client = new GitHostClient({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const repository = await client.createRepository({ host: 'github', token: 'tok', name: 'pagekin-library' })
    expect(repository.cloneUrl).toBe('https://github.com/me/pagekin-library.git')
    expect(repository.fullName).toBe('me/pagekin-library')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.github.com/user/repos')
    expect(JSON.parse(String(init.body)).private).toBe(true)
  })

  it('名字被占用时自动换 name-2 再试', async () => {
    let attempt = 0
    const fetchImpl = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) {
        return jsonResponse(422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] })
      }
      return jsonResponse(201, {
        clone_url: 'https://github.com/me/pagekin-library-2.git',
        full_name: 'me/pagekin-library-2',
      })
    })
    const client = new GitHostClient({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const repository = await client.createRepositoryWithFallback({ host: 'github', token: 'tok', name: 'pagekin-library' })
    expect(repository.fullName).toBe('me/pagekin-library-2')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const secondBody = JSON.parse(String((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body))
    expect(secondBody.name).toBe('pagekin-library-2')
  })

  it('列出账号下的仓库，并把出问题的项跳过', async () => {
    const client = new GitHostClient({
      fetchImpl: (async () => jsonResponse(200, [
        { full_name: 'me/pagekin-novel', clone_url: 'https://github.com/me/pagekin-novel.git', private: true, updated_at: '2026-11-08T00:00:00Z' },
        { full_name: 'broken' },
        null,
      ])) as unknown as typeof fetch,
    })
    const repositories = await client.listRepositories('github', 'tok')
    expect(repositories).toHaveLength(1)
    expect(repositories[0]).toMatchObject({ fullName: 'me/pagekin-novel', private: true })
  })

  it('认得出「根目录里有 .ai-novel」的仓库才是书童备份', async () => {
    const calls: string[] = []
    const client = new GitHostClient({
      fetchImpl: (async (url: string) => {
        calls.push(url)
        if (url.endsWith('/contents')) {
          return jsonResponse(200, [{ type: 'dir', name: '世界都是我的试验品' }, { type: 'file', name: '.gitignore' }])
        }
        if (url.includes('/.ai-novel')) return jsonResponse(200, [{ type: 'dir', name: 'lancedb' }])
        return jsonResponse(404, {})
      }) as unknown as typeof fetch,
    })
    await expect(client.looksLikeBookLibrary('github', 'tok', 'me/pagekin-novel')).resolves.toBe(true)
    expect(calls.some(url => url.includes('%E4%B8%96%E7%95%8C'))).toBe(true)
  })

  it('没有 .ai-novel 的普通仓库不会被误认成备份', async () => {
    const client = new GitHostClient({
      fetchImpl: (async (url: string) => {
        if (url.endsWith('/contents')) {
          return jsonResponse(200, [{ type: 'dir', name: 'src' }, { type: 'file', name: 'README.md' }])
        }
        return jsonResponse(404, {})
      }) as unknown as typeof fetch,
    })
    await expect(client.looksLikeBookLibrary('github', 'tok', 'me/some-code')).resolves.toBe(false)
  })

  it('网络不通时给出可读的网络错误', async () => {
    const client = new GitHostClient({
      fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
    })
    await expect(client.identify('github', 'tok')).rejects.toBeInstanceOf(GitHostError)
    await expect(client.identify('github', 'tok')).rejects.toMatchObject({ code: 'GIT_HOST_NETWORK_FAILED' })
  })

  it('Gitee 走 v5 接口，令牌放在查询参数里', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, {
      html_url: 'https://gitee.com/me/pagekin-library',
      path_with_namespace: 'me/pagekin-library',
    }))
    const client = new GitHostClient({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const repository = await client.createRepository({ host: 'gitee', token: 'tok', name: 'pagekin-library' })
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('https://gitee.com/api/v5/user/repos')
    expect(url).toContain('access_token=tok')
    expect(repository.cloneUrl).toBe('https://gitee.com/me/pagekin-library.git')
  })
})
