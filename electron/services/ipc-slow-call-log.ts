import type { IpcMain } from 'electron'

export const IPC_SLOW_CALL_THRESHOLD_MS = 200

type InvokeListener = Parameters<IpcMain['handle']>[1]

export interface IpcSlowCallLogOptions {
  thresholdMs?: number
  now?: () => number
  log?: (line: string) => void
}

/**
 * 之后注册的每个 invoke 处理函数都计时：同步段（调用到处理函数返回）超过阈值，写一行通道名和耗时。
 * 主进程被同步段占住时整个应用假死，异步等待不占主进程，所以不计。
 */
export function installIpcSlowCallLog(ipc: Pick<IpcMain, 'handle'>, options: IpcSlowCallLogOptions = {}): void {
  const thresholdMs = options.thresholdMs ?? IPC_SLOW_CALL_THRESHOLD_MS
  const now = options.now ?? (() => performance.now())
  const log = options.log ?? (line => console.warn(line))
  const handle = ipc.handle.bind(ipc)
  ipc.handle = (channel: string, listener: InvokeListener) => handle(channel, (event, ...args) => {
    const startedAt = now()
    try {
      return listener(event, ...args)
    } finally {
      const elapsedMs = now() - startedAt
      if (elapsedMs > thresholdMs) {
        try {
          log(`[ipc-slow] ${channel} ${Math.round(elapsedMs)}ms`)
        } catch {
          // 日志写不出去也不能改变这次 IPC 的结果。
        }
      }
    }
  })
}
