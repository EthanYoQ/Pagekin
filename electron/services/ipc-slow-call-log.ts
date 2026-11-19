import type { IpcMain } from 'electron'

export const IPC_SLOW_CALL_THRESHOLD_MS = 200
export const EVENT_LOOP_SAMPLE_MS = 100

type InvokeListener = Parameters<IpcMain['handle']>[1]

export interface IpcSlowCallLogOptions {
  thresholdMs?: number
  now?: () => number
  log?: (line: string) => void
}

/**
 * 之后注册的每个 invoke 处理函数都计时：同步段（调用到处理函数返回）超过阈值，写一行通道名和耗时。
 * 主进程被同步段占住时整个应用假死，异步等待不占主进程，所以不计。
 * 异步处理函数在 await 之后的同步段也会占住主进程，单个调用的计时看不到它；
 * 所以另按 EVENT_LOOP_SAMPLE_MS 采样事件循环，迟到超过阈值时写一行迟到多久，和这一段里开始或结束的通道：
 * 结束前的最后一个同步段落在这一段里也算；整段都在等待的通道没占主线程，不算。
 */
export function installIpcSlowCallLog(ipc: Pick<IpcMain, 'handle'>, options: IpcSlowCallLogOptions = {}): () => void {
  const thresholdMs = options.thresholdMs ?? IPC_SLOW_CALL_THRESHOLD_MS
  const now = options.now ?? (() => performance.now())
  const log = options.log ?? (line => console.warn(line))
  const write = (line: string) => {
    try {
      log(line)
    } catch {
      // 日志写不出去也不能改变这次 IPC 的结果。
    }
  }
  const touched = new Set<string>()
  const handle = ipc.handle.bind(ipc)
  ipc.handle = (channel: string, listener: InvokeListener) => handle(channel, (event, ...args) => {
    const startedAt = now()
    touched.add(channel)
    try {
      const result: unknown = listener(event, ...args)
      if (result instanceof Promise) {
        const done = () => { touched.add(channel) }
        void result.then(done, done)
      }
      return result
    } finally {
      const elapsedMs = now() - startedAt
      if (elapsedMs > thresholdMs) write(`[ipc-slow] ${channel} ${Math.round(elapsedMs)}ms`)
    }
  })
  let sampledAt = now()
  const sampler = setInterval(() => {
    const at = now(), lagMs = at - sampledAt - EVENT_LOOP_SAMPLE_MS
    sampledAt = at
    if (lagMs > thresholdMs) write(`[event-loop-lag] ${Math.round(lagMs)}ms 期间开始或结束的通道 ${[...touched].join(',') || '无'}`)
    touched.clear()
  }, EVENT_LOOP_SAMPLE_MS)
  sampler.unref?.()
  return () => clearInterval(sampler)
}
