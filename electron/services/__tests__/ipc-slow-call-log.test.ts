import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EVENT_LOOP_SAMPLE_MS, installIpcSlowCallLog, IPC_SLOW_CALL_THRESHOLD_MS } from '../ipc-slow-call-log'

type Listener = Parameters<IpcMain['handle']>[1]

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.useRealTimers()
})

function harness(options: { log?: (line: string) => void } = {}) {
  const handlers = new Map<string, Listener>()
  const ipc = { handle: (channel: string, listener: Listener) => { handlers.set(channel, listener) } }
  let clock = 0
  const lines: string[] = []
  stops.push(installIpcSlowCallLog(ipc, { now: () => clock, log: options.log ?? (line => lines.push(line)) }))
  const register = (channel: string, syncMs: number, body: () => unknown) => ipc.handle(channel, () => {
    clock += syncMs
    return body()
  })
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args)
  const elapse = (ms: number) => { clock += ms }
  return { register, invoke, lines, elapse }
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
    stops.push(installIpcSlowCallLog(ipc, { log: () => {} }))
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

  it('异步处理函数前一段开始，这一段 await 之后又占住主线程、随即结束：迟到那一行记下它', async () => {
    vi.useFakeTimers()
    const { register, invoke, lines, elapse } = harness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    register('generation:list-recovery', 0, async () => {
      await gate
      elapse(EVENT_LOOP_SAMPLE_MS + 330)
      return 'done'
    })
    const answer = invoke('generation:list-recovery')
    elapse(EVENT_LOOP_SAMPLE_MS)
    vi.advanceTimersByTime(EVENT_LOOP_SAMPLE_MS)

    release()
    await expect(answer).resolves.toBe('done')
    vi.advanceTimersByTime(EVENT_LOOP_SAMPLE_MS)
    expect(lines).toEqual(['[event-loop-lag] 330ms 期间开始或结束的通道 generation:list-recovery'])
  })

  it('只在等待、这一段里没开始也没结束的通道不算：长时间的模型调用不会出现在每一行里', async () => {
    vi.useFakeTimers()
    const { register, invoke, lines, elapse } = harness()
    let finish!: (value: string) => void
    register('generation:execute', 0, () => new Promise<string>(resolve => { finish = resolve }))
    register('db:slow-sync', 0, () => 'ok')
    const answer = invoke('generation:execute')
    elapse(EVENT_LOOP_SAMPLE_MS)
    vi.advanceTimersByTime(EVENT_LOOP_SAMPLE_MS)

    elapse(EVENT_LOOP_SAMPLE_MS + 400)
    vi.advanceTimersByTime(EVENT_LOOP_SAMPLE_MS)
    invoke('db:slow-sync')
    elapse(EVENT_LOOP_SAMPLE_MS + 250)
    vi.advanceTimersByTime(EVENT_LOOP_SAMPLE_MS)
    expect(lines).toEqual(['[event-loop-lag] 400ms 期间开始或结束的通道 无', '[event-loop-lag] 250ms 期间开始或结束的通道 db:slow-sync'])

    finish('done')
    await expect(answer).resolves.toBe('done')
  })

  it('迟到不超过阈值不写；失败的异步调用照样按结束算', async () => {
    vi.useFakeTimers()
    const { register, invoke, lines, elapse } = harness()
    let fail!: (error: Error) => void
    register('kb:broken', 0, () => new Promise((_resolve, reject) => { fail = reject }))
    const answer = invoke('kb:broken')
    elapse(EVENT_LOOP_SAMPLE_MS + IPC_SLOW_CALL_THRESHOLD_MS)
    vi.advanceTimersByTime(EVENT_LOOP_SAMPLE_MS)
    expect(lines).toEqual([])

    fail(new Error('KB_DOWN'))
    await expect(answer).rejects.toThrow('KB_DOWN')
    elapse(EVENT_LOOP_SAMPLE_MS + 250)
    vi.advanceTimersByTime(EVENT_LOOP_SAMPLE_MS)
    expect(lines).toEqual(['[event-loop-lag] 250ms 期间开始或结束的通道 kb:broken'])
  })
})
