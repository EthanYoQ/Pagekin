import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import { installIpcSlowCallLog, IPC_SLOW_CALL_THRESHOLD_MS } from '../ipc-slow-call-log'

type Listener = Parameters<IpcMain['handle']>[1]

function harness(options: { log?: (line: string) => void } = {}) {
  const handlers = new Map<string, Listener>()
  const ipc = { handle: (channel: string, listener: Listener) => { handlers.set(channel, listener) } }
  let clock = 0
  const lines: string[] = []
  installIpcSlowCallLog(ipc, { now: () => clock, log: options.log ?? (line => lines.push(line)) })
  const register = (channel: string, syncMs: number, body: () => unknown) => ipc.handle(channel, () => {
    clock += syncMs
    return body()
  })
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args)
  return { register, invoke, lines }
}

describe('installIpcSlowCallLog', () => {
  it('同步段超过 200 ms 写一行通道名和耗时，返回值照常', () => {
    const { register, invoke, lines } = harness()
    register('db:review-cycle-get', 312, () => ({ ok: true }))
    register('db:fast', IPC_SLOW_CALL_THRESHOLD_MS, () => 'fast')

    expect(invoke('db:review-cycle-get')).toEqual({ ok: true })
    expect(invoke('db:fast')).toBe('fast')
    expect(lines).toEqual(['[ipc-slow] db:review-cycle-get 312ms'])
  })

  it('参数原样传给处理函数', () => {
    const handlers = new Map<string, Listener>()
    const ipc = { handle: (channel: string, listener: Listener) => { handlers.set(channel, listener) } }
    installIpcSlowCallLog(ipc, { log: () => {} })
    const event = {} as IpcMainInvokeEvent
    let received: unknown[] = []
    ipc.handle('echo', (...args) => { received = args; return 'done' })
    expect(handlers.get('echo')!(event, 1, 'two')).toBe('done')
    expect(received).toEqual([event, 1, 'two'])
  })

  it('只计同步段：返回 promise 的处理函数等待再久也不记', async () => {
    const { register, invoke, lines } = harness()
    register('kb:search', 5, () => new Promise(resolve => setTimeout(() => resolve('later'), 20)))

    await expect(invoke('kb:search')).resolves.toBe('later')
    expect(lines).toEqual([])
  })

  it('处理函数抛错时照样记，并抛出原来的错误', () => {
    const { register, invoke, lines } = harness()
    register('db:broken', 250, () => { throw new Error('REVIEW_CYCLE_CONFLICT') })

    expect(() => invoke('db:broken')).toThrow('REVIEW_CYCLE_CONFLICT')
    expect(lines).toEqual(['[ipc-slow] db:broken 250ms'])
  })

  it('主进程在注册任何业务 IPC 之前安装；发版冒烟进程退出前不安装', () => {
    const main = readFileSync(resolve(process.cwd(), 'electron/main.ts'), 'utf8')
    const ready = main.slice(main.indexOf('app.whenReady().then('))
    const installed = ready.indexOf('installIpcSlowCallLog(ipcMain)')

    expect(installed).toBeGreaterThan(ready.indexOf('app.exit(0)'))
    expect(installed).toBeLessThan(ready.indexOf('registerStartupController('))
    expect(installed).toBeLessThan(ready.indexOf('registerIPCHandlers()'))
    expect(installed).toBeLessThan(ready.indexOf('registerUpdateController('))
  })

  it('日志写入失败不影响 IPC 结果', () => {
    const { register, invoke } = harness({ log: () => { throw new Error('EPIPE') } })
    register('db:slow', 400, () => 'value')
    register('db:slow-broken', 400, () => { throw new Error('ORIGINAL') })

    expect(invoke('db:slow')).toBe('value')
    expect(() => invoke('db:slow-broken')).toThrow('ORIGINAL')
  })
})
