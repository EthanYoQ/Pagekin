import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (event: unknown, ...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({ listeners: new Map<string, Listener>() }))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, listener: Listener) => { mocks.listeners.set(channel, listener) }) },
}))

import { handle } from '../handle'
import { ipc } from '../../../src/services/ipc-client'
import { failureText, knownAppErrorMessage, wireNote } from '../../../src/i18n/app-errors'
import { shown } from '../../../src/i18n/__tests__/shown-locale'
import type { Failure } from '../../../src/shared/failure'

const RAW = "SqliteError: database is locked at C:\\Users\\writer\\Books\\A\\.ai-novel\\project.db"
const zh = shown('zh-CN')

/** 用 JSON 往返代替结构化克隆。 */
async function received(returned: unknown, options: { bypassExit?: boolean } = {}): Promise<{ failure?: Failure }> {
  let wire = returned
  if (!options.bypassExit) {
    handle('test:wire', () => returned)
    wire = await mocks.listeners.get('test:wire')!({ sender: { id: 1 } })
  }
  const crossed = JSON.parse(JSON.stringify(wire)) as unknown
  vi.stubGlobal('window', { aiNovelAPI: { invoke: vi.fn(async () => crossed) } })
  return await (ipc.invoke as unknown as (channel: string) => Promise<{ failure?: Failure }>)('test:wire')
}

beforeEach(() => {
  mocks.listeners.clear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('过 IPC 的失败形状（#844 PR-B）', () => {
  it('返回值的 failure 码没登记时渲染端拿到通用码', async () => {
    const returned = { success: false, failure: { code: 'KNOWLEDGE_BASE_SHARD_LOST', note: wireNote('error.projectNotOpen') } }

    const result = await received(returned)

    expect(result.failure).toEqual({ code: 'IPC_HANDLER_FAILED' })
    expect(failureText(zh, result.failure)).toBe(knownAppErrorMessage(zh, 'IPC_HANDLER_FAILED'))
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('test:wire'), returned)

    const bypassed = await received(returned, { bypassExit: true })
    expect(bypassed.failure).toEqual({ code: 'IPC_HANDLER_FAILED' })
  })

  it('码的形状不对时渲染端不当它是失败描述', async () => {
    const result = await received({ success: false, failure: { code: RAW } }, { bypassExit: true })

    expect(result).not.toHaveProperty('failure')
  })

  it.each([
    ['写好的句子当键', { key: '请先打开项目。' }],
    ['整句装原文的键', { key: 'error.unknown', params: { message: RAW } }],
    ['参数不是数字或字符串', { key: 'error.projectPathTooDeepForDatabase', params: { max: { raw: RAW } } }],
  ])('过 IPC 的目录键不在目录里时渲染端只按码说明（%s）', async (_case, note) => {
    for (const bypassExit of [false, true]) {
      const result = await received({ success: false, failure: { code: 'PROJECT_NOT_OPEN', note } }, { bypassExit })

      expect(result.failure, `bypassExit=${bypassExit}`).toEqual({ code: 'PROJECT_NOT_OPEN' })
      expect(failureText(zh, result.failure)).toBe(knownAppErrorMessage(zh, 'PROJECT_NOT_OPEN'))
      expect(failureText(zh, result.failure)).not.toContain('database is locked')
    }
  })

  it('合格的目录键与参数原样过 IPC，按界面语言说明', async () => {
    const returned = { success: false, failure: { code: 'PROJECT_STORAGE_PATH_UNSUPPORTED', note: wireNote('error.projectPathTooDeepForDatabase', { max: 120 }) } }

    const result = await received(returned)

    expect(failureText(zh, result.failure)).toContain('路径不超过 120 个字符')
    expect(failureText(shown('en-US'), result.failure)).toContain('at most 120 characters')
    expect(console.error).not.toHaveBeenCalled()
  })

  it('旧字段照旧规则交出，新字段另外校验', async () => {
    const result = await received({ success: false, error: RAW, errorCode: 'PROJECT_NOT_OPEN', failure: { code: 'PROJECT_NOT_OPEN' } })

    expect(result).toEqual({ success: false, error: RAW, errorCode: 'PROJECT_NOT_OPEN', failure: { code: 'PROJECT_NOT_OPEN' } })
  })
})
