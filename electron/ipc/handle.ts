import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_HANDLER_FAILED, registeredErrorCode } from '../../src/i18n/app-errors'

export type IpcHandler<Args extends unknown[] = unknown[]> = (event: IpcMainInvokeEvent, ...args: Args) => unknown

/**
 * 处理器抛出的错误交给渲染端的样子：已登记的码照传，其余换成通用码。
 * Electron 只把 message 带过 IPC，所以 code 属性上的码要放进 message。
 */
export function publicIpcError(error: unknown): Error {
  const code = registeredErrorCode(error)
  if (!code) return new Error(IPC_HANDLER_FAILED)
  return error instanceof Error && error.message === code ? error : new Error(code)
}

type FailureFields = { error?: unknown; errorCode?: unknown }

function isFailure(value: unknown): value is { success: false } & FailureFields {
  return typeof value === 'object' && value !== null && (value as { success?: unknown }).success === false
}

/**
 * 处理器返回的失败结果交给渲染端的样子：error 或 errorCode 有一个是已登记的码就照传；
 * 否则把出现的这两个字段换成通用码，不新增字段。不是失败结果的照传。
 */
export function publicIpcResult<T>(value: T): T {
  if (!isFailure(value)) return value
  const { error, errorCode } = value
  if (error === undefined && errorCode === undefined) return value
  if (registeredErrorCode(errorCode) || registeredErrorCode(error)) return value
  return {
    ...value,
    ...(error === undefined ? {} : { error: IPC_HANDLER_FAILED }),
    ...(errorCode === undefined ? {} : { errorCode: IPC_HANDLER_FAILED }),
  }
}

/**
 * 注册 IPC 处理器的唯一入口。没登记的失败，原文和堆栈只写主进程日志，渲染端拿到 IPC_HANDLER_FAILED。
 * 每次调用时才取 ipcMain.handle：main.ts 的慢调用日志在启动时替换了它。
 */
export function handle<Args extends unknown[]>(channel: string, handler: IpcHandler<Args>): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    let value: unknown
    try {
      value = await handler(event, ...(args as Args))
    } catch (error) {
      const shown = publicIpcError(error)
      if (shown.message === IPC_HANDLER_FAILED) console.error(`[AI Novel IPC] ${channel} 抛出未登记的错误:`, error)
      throw shown
    }
    const shown = publicIpcResult(value)
    if (shown !== value) console.error(`[AI Novel IPC] ${channel} 返回未登记的失败:`, value)
    return shown
  })
}
