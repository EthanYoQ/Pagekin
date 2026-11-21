import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  locale: 'zh-CN',
}))

vi.mock('electron', () => ({
  app: { getLocale: () => mocks.locale },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)) },
}))

let fixtureRoot = ''

async function inspect(url: string): Promise<{ success: boolean; error?: string }> {
  return await mocks.handlers.get('skills:inspect-github')!({}, url) as { success: boolean; error?: string }
}

const ENGLISH_SENTENCE = /\b(?:Invalid|Only|Use|Incomplete|failed|must|larger|returned|fetch|aborted|malformed)\b/u

beforeEach(async () => {
  vi.resetModules()
  mocks.handlers.clear()
  mocks.locale = 'zh-CN'
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-skill-url-locale-'))
  await (await import('../../services/__tests__/global-data-fixture')).prepareGlobalDataFixture(fixtureRoot)
  const { registerAppDataController } = await import('../app-data-controller')
  registerAppDataController()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.AI_NOVEL_VELA_HOME
  delete process.env.AI_NOVEL_APP_DATA_HOME
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('写作 Skills 的 GitHub 地址报错按界面语言说明（#702）', () => {
  it.each([
    ['不是网址', 'github.com/acme/skill'],
    ['不是 https', 'http://github.com/acme/skill'],
    ['不是 GitHub', 'https://example.com/acme/skill/SKILL.md'],
    ['raw 地址不完整', 'https://raw.githubusercontent.com/acme/skill'],
    ['指向 issue 页', 'https://github.com/acme/skill/issues/1'],
    ['不指向 SKILL.md', 'https://github.com/acme/skill/blob/main/README.md'],
    ['仓库名含非法字符', 'https://github.com/acme/%20bad/tree/main'],
    ['路径里的 % 编码坏了', 'https://github.com/acme/skill/blob/main/%E0%A4%A/SKILL.md'],
  ])('中文界面：%s 时说中文，不露英文原文', async (_label, url) => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch should not run') }))
    const result = await inspect(url)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/\p{Script=Han}/u)
    expect(result.error).not.toMatch(ENGLISH_SENTENCE)
  })

  it.each([
    ['仓库不存在', () => new Response('', { status: 404 })],
    ['GitHub 拒绝或限流', () => new Response('', { status: 403 })],
    ['连不上 GitHub', () => { throw new TypeError('fetch failed') }],
    ['SKILL.md 太大', () => new Response('x'.repeat(65 * 1024), { status: 200 })],
  ])('中文界面：%s 时说中文，不露英文原文或状态码', async (_label, respond) => {
    vi.stubGlobal('fetch', vi.fn(async () => respond()))
    const result = await inspect('https://github.com/acme/skill/blob/main/SKILL.md')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/\p{Script=Han}/u)
    expect(result.error).not.toMatch(ENGLISH_SENTENCE)
    expect(result.error).not.toMatch(/\b40[34]\b/u)
  })

  it('仓库地址不带分支、查默认分支时仓库不存在，同样说中文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    const result = await inspect('https://github.com/acme/no-such-repo')
    expect(result.error).toMatch(/\p{Script=Han}/u)
    expect(result.error).not.toMatch(ENGLISH_SENTENCE)
  })

  it('读 SKILL.md 正文时连接断了，同样说中文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start: controller => controller.error(new TypeError('terminated')) }), { status: 200 })))
    const result = await inspect('https://github.com/acme/skill/blob/main/SKILL.md')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/\p{Script=Han}/u)
    expect(result.error).not.toMatch(ENGLISH_SENTENCE)
  })

  it('查默认分支时收到的不是 JSON（例如代理返回的网页），同样说中文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>portal</html>', { status: 200 })))
    const result = await inspect('https://github.com/acme/skill')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/\p{Script=Han}/u)
    expect(result.error).not.toMatch(/Unexpected token|JSON/u)
  })

  it('连不上 GitHub 时，原始异常记进主进程日志，作者仍只看到说明', async () => {
    const cause = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }) })
    vi.stubGlobal('fetch', vi.fn(async () => { throw cause }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await inspect('https://github.com/acme/skill')
    expect(result.error).not.toMatch(/ENOTFOUND|fetch failed/u)
    expect(warn).toHaveBeenCalledWith(expect.any(String), cause)
    warn.mockRestore()
  })

  it('英文界面：报错是英文', async () => {
    mocks.locale = 'en-US'
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    const results = [await inspect('http://github.com/acme/skill'), await inspect('https://github.com/acme/skill/blob/main/SKILL.md')]
    for (const result of results) {
      expect(result.success).toBe(false)
      expect(result.error).not.toMatch(/\p{Script=Han}/u)
      expect(result.error).toMatch(/GitHub|SKILL\.md/u)
    }
  })
})
