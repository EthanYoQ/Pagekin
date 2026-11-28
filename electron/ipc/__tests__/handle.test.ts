import { beforeEach, describe, expect, it, vi } from 'vitest'

import { appErrorMessage } from '../../../src/i18n/app-errors'
import { shown as shownLocale } from '../../../src/i18n/__tests__/shown-locale'

type Listener = (event: unknown, ...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({ listeners: new Map<string, Listener>() }))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, listener: Listener) => { mocks.listeners.set(channel, listener) }) },
}))

import { ipcMain } from 'electron'
import { handle } from '../handle'

const event = { sender: { id: 1 } }

function invoke(channel: string, ...args: unknown[]) {
  const listener = mocks.listeners.get(channel)
  if (!listener) throw new Error(`Missing IPC handler: ${channel}`)
  return listener(event, ...args)
}

/** Electron 只把 message 带过 IPC，渲染端看到的是这个外壳。 */
async function rejectedAfterIpc(channel: string, promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(() => { throw new Error('expected the channel to reject') }, (rejected: Error) => rejected)
  return new Error(`Error invoking remote method '${channel}': ${error.name}: ${error.message}`)
}

const RAW = "SQLITE_CANTOPEN: unable to open database file 'C:\\Users\\writer\\Books\\A\\.ai-novel\\project.db'"

beforeEach(() => {
  mocks.listeners.clear()
  vi.mocked(ipcMain.handle).mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {}).mockClear()
})

describe('handle() 抛错', () => {
  it('未登记的错误：渲染端只拿到通用码和通用说明，原文与堆栈只进主进程日志', async () => {
    const raw = new Error(RAW)
    handle('demo:throw', () => { throw raw })

    const shown = await rejectedAfterIpc('demo:throw', invoke('demo:throw'))

    expect(shown.message).toBe("Error invoking remote method 'demo:throw': Error: IPC_HANDLER_FAILED")
    expect(shown.message).not.toContain('SQLITE')
    expect(appErrorMessage(shownLocale('zh-CN'), shown)).toBe('这次操作没有完成，出了意外问题。请再试一次；还不行，请把这条提示反馈给我们。')
    expect(appErrorMessage(shownLocale('en-US'), shown)).toBe('That action did not finish because something unexpected went wrong. Try again; if it keeps happening, send us this message.')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('demo:throw'), raw)
    expect(raw.stack).toBeTruthy()
  })

  it('已登记的码照传，带类名的错误保留原样', async () => {
    class ProjectSessionStaleError extends Error {
      constructor(readonly code: string) { super(code); this.name = 'ProjectSessionStaleError' }
    }
    const stale = new ProjectSessionStaleError('PROJECT_SESSION_STALE')
    handle('demo:stale', () => { throw stale })

    await expect(invoke('demo:stale')).rejects.toBe(stale)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('码只在 code 属性上时，把码放进 message 交出去', async () => {
    handle('demo:code', async () => { throw Object.assign(new Error('disk is full at C:\\x'), { code: 'KNOWLEDGE_BASE_DISK_FULL' }) })

    await expect(invoke('demo:code')).rejects.toThrow(/^KNOWLEDGE_BASE_DISK_FULL$/u)
  })

  it('码的形状对但没登记，也换成通用码', async () => {
    handle('demo:unregistered', () => { throw new Error('EMBEDDING_SPACE_VERIFY_FAILED') })

    await expect(invoke('demo:unregistered')).rejects.toThrow(/^IPC_HANDLER_FAILED$/u)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('demo:unregistered'), expect.objectContaining({ message: 'EMBEDDING_SPACE_VERIFY_FAILED' }))
  })

  it('拆批数量随码过 IPC，作者看到目录说明；别的码带后缀照旧换成通用码', async () => {
    handle('demo:split', () => { throw new Error('TASK_BUDGET_SCOPE_SPLIT_REQUIRED:7') })
    handle('demo:suffixed', () => { throw new Error('GENERATION_REQUEST_FAILED:7') })

    const split = await rejectedAfterIpc('demo:split', invoke('demo:split'))
    expect(split.message).toBe("Error invoking remote method 'demo:split': Error: TASK_BUDGET_SCOPE_SPLIT_REQUIRED:7")
    expect(appErrorMessage(shownLocale('en-US'), split)).toBe('The settings, earlier text, or prose for this request are too large to give to the model, so nothing was generated. Shorten them, then try again.')
    await expect(invoke('demo:suffixed')).rejects.toThrow(/^IPC_HANDLER_FAILED$/u)
  })
})

describe('handle() 返回的失败结果', () => {
  it('error 是原文：换成通用码，其余字段不动，原值进主进程日志', async () => {
    const failure = { success: false, processed: 0, error: RAW }
    handle('demo:raw', () => failure)

    await expect(invoke('demo:raw')).resolves.toEqual({ success: false, processed: 0, error: 'IPC_HANDLER_FAILED' })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('demo:raw'), failure)
  })

  it('只有本地化文案、没有已登记码，也换成通用码；不额外加 errorCode', async () => {
    handle('demo:localized', () => ({ success: false, error: '清空知识库失败' }))

    await expect(invoke('demo:localized')).resolves.toEqual({ success: false, error: 'IPC_HANDLER_FAILED' })
  })

  it('未登记的 errorCode 和 error 一起换成通用码', async () => {
    handle('demo:pair', () => ({ success: false, errorCode: 'EMBEDDING_SPACE_VERIFY_FAILED', error: '校验未通过（EMBEDDING_SPACE_VERIFY_FAILED）' }))

    await expect(invoke('demo:pair')).resolves.toEqual({ success: false, errorCode: 'IPC_HANDLER_FAILED', error: 'IPC_HANDLER_FAILED' })
  })

  it.each([
    ['error 是已登记码', { success: false, error: 'KNOWLEDGE_BASE_VOLUME_UNSUPPORTED' }],
    ['errorCode 已登记、error 是本地化文案', { success: false, errorCode: 'EMBEDDING_MODEL_NOT_CONFIGURED', error: '未配置 Embedding 模型' }],
    ['成功结果', { success: true, docId: 'doc-1' }],
    ['没有失败字段的失败', { success: false, committed: false }],
    ['不是结果对象', ['a', 'b']],
    ['null', null],
  ])('%s：照传', async (_label, value) => {
    handle('demo:pass', () => value)

    await expect(invoke('demo:pass')).resolves.toBe(value)
    expect(console.error).not.toHaveBeenCalled()
  })
})

describe('handle() 注册', () => {
  it('注册时才取 ipcMain.handle，慢调用日志替换后的 handle 照样生效', async () => {
    const replaced = vi.fn()
    const original = ipcMain.handle
    ipcMain.handle = replaced
    try {
      handle('demo:late', () => 'ok')
    } finally {
      ipcMain.handle = original
    }

    expect(replaced).toHaveBeenCalledWith('demo:late', expect.any(Function))
    await expect(replaced.mock.calls[0]![1](event)).resolves.toBe('ok')
  })

  it('把渲染端的参数原样交给处理器', async () => {
    const handler = vi.fn((_event: unknown, left: number, right: number) => left + right)
    handle('demo:args', handler)

    await expect(invoke('demo:args', 2, 3)).resolves.toBe(5)
    expect(handler).toHaveBeenCalledWith(event, 2, 3)
  })
})
