import { openCanonicalProjectFixture } from '../../test/helpers/canonical-project-fixture'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { shown as shownLocale } from '../../src/i18n/__tests__/shown-locale'
import { workflowMainProcessError } from '../../src/services/workflows/workflow-project-session'
import { closeProjectDatabase } from '../database'
import { backfillVectors, importText } from '../knowledge-base'
import { applyNetworkProxy } from '../network-proxy'
import { closeConnection } from '../vector-store'
import { refused } from './proxy-failure-fixture'

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import('node:http') }>()
  const { setGlobalProxyFromEnv } = await import('./proxy-failure-fixture')
  return { ...actual, default: { ...actual.default, setGlobalProxyFromEnv } }
})

let projectPath = ''

async function closedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

const localModel = (baseUrl: string) => ({ provider: 'custom', baseUrl, apiKey: 'test-key', modelName: 'local-embed' })

async function rebuildFailureShown(locale: 'zh-CN' | 'en-US', baseUrl: string): Promise<string> {
  await importText('林岚核对潮位表。', '第1章 旧港.txt', projectPath, 'openai', localModel(baseUrl), { mode: 'fts-only' })
  const result = await backfillVectors(projectPath, 'openai', localModel(baseUrl))
  expect(result.success).toBe(false)
  return workflowMainProcessError(shownLocale(locale), result.errorCode ?? result.error, '重建检索失败', 'Could not rebuild search.').message
}

beforeAll(() => { fs.mkdirSync(path.resolve('.runtime/.cache'), { recursive: true }) })

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(path.resolve('.runtime/.cache'), 'ai-novel-kb-embedding-connection-'))
  openCanonicalProjectFixture(projectPath)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  applyNetworkProxy({ enabled: false, type: 'http', host: '', port: 0 })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  closeProjectDatabase()
  closeConnection(projectPath)
  fs.rmSync(projectPath, { recursive: true, force: true })
})

describe('rebuilding search when the retrieval model cannot be reached', () => {
  it('tells a Chinese author nothing is answering at the base_url instead of showing "fetch failed"', async () => {
    const shown = await rebuildFailureShown('zh-CN', `http://127.0.0.1:${await closedPort()}/v1`)

    expect(shown).not.toMatch(/fetch failed|ECONNREFUSED|[A-Z]{2,}_[A-Z]/u)
    expect(shown).toBe('重建检索失败：base_url 上没有服务在响应。请确认模型服务已启动，端口填写正确。')
  })

  it('tells an English author the same reason instead of only the summary', async () => {
    const shown = await rebuildFailureShown('en-US', `http://127.0.0.1:${await closedPort()}/v1`)

    expect(shown).toBe('Could not rebuild search. Nothing is answering at the base_url. Make sure the model service is running and the port is correct.')
  })

  it('blames the stopped proxy, not the base_url, when a cloud retrieval model goes through it', async () => {
    applyNetworkProxy({ enabled: true, type: 'http', host: '127.0.0.1', port: 7890 })
    vi.stubGlobal('fetch', vi.fn(async () => { throw refused('127.0.0.1', 7890) }))

    const shown = await rebuildFailureShown('zh-CN', 'https://api.example.com/v1')

    expect(shown).toBe('重建检索失败：连不上「网络代理」里设置的代理。请检查「主机地址」和「端口」，打开代理软件，或关掉「启用代理」。')
  })

  it('still names the base_url when a proxy is set but the local model itself refuses', async () => {
    applyNetworkProxy({ enabled: true, type: 'http', host: '127.0.0.1', port: 7890 })
    vi.stubGlobal('fetch', vi.fn(async () => { throw refused('127.0.0.1', 11434) }))

    const shown = await rebuildFailureShown('zh-CN', 'http://127.0.0.1:11434/v1')

    expect(shown).toBe('重建检索失败：base_url 上没有服务在响应。请确认模型服务已启动，端口填写正确。')
  })

  it('names a server that cannot be found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }) }))

    const shown = await rebuildFailureShown('zh-CN', 'http://127.0.0.1:9/v1')

    expect(shown).toBe('重建检索失败：找不到 base_url 里的服务器。请检查地址拼写和网络。')
  })

  it('explains a connect timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }) }))

    const shown = await rebuildFailureShown('zh-CN', 'http://127.0.0.1:9/v1')

    expect(shown).toBe('重建检索失败：连接模型服务超时。请检查网络后重试。')
  })

  it('points at the retrieval model settings for a network failure it cannot classify', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause: new Error('other side closed') }) }))

    const zh = await rebuildFailureShown('zh-CN', 'http://127.0.0.1:9/v1')
    const en = await rebuildFailureShown('en-US', 'http://127.0.0.1:9/v1')

    expect(zh).toBe('重建检索失败：连不上检索模型，检索索引没有改动。请在设置的「检索模型」页检查 Base URL、网络或代理后重试。')
    expect(en).toBe('Could not rebuild search. The retrieval model could not be reached, so the search index was not changed. Check its Base URL, network, or proxy on the Retrieval model page in Settings, then try again.')
  })

  it('does not take an inherited property for a cause code it does not know', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause: { code: 'constructor' } }) }))

    const shown = await rebuildFailureShown('zh-CN', 'http://127.0.0.1:9/v1')

    expect(shown).toBe('重建检索失败：连不上检索模型，检索索引没有改动。请在设置的「检索模型」页检查 Base URL、网络或代理后重试。')
  })

  it.each([401, 403, 404])('keeps the request-failed advice for HTTP %i', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status })))

    const shown = await rebuildFailureShown('zh-CN', 'http://127.0.0.1:9/v1')

    expect(shown).toBe('重建检索失败：检索模型请求失败。请检查检索模型的 Base URL、网关与 API Key。')
  })
})
