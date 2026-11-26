import { ipcMain, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_HANDLER_FAILED, publicWireFailure, registeredErrorCode } from '../../src/i18n/app-errors'
import DIRECT_CHANNELS from './direct-channels.json'

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

type FailureFields = { error?: unknown; errorCode?: unknown; failure?: unknown }

function isFailure(value: unknown): value is { success: false } & FailureFields {
  return typeof value === 'object' && value !== null && (value as { success?: unknown }).success === false
}

function publicLegacyFields({ error, errorCode }: FailureFields): FailureFields | undefined {
  if (error === undefined && errorCode === undefined) return undefined
  if (registeredErrorCode(errorCode) || registeredErrorCode(error)) return undefined
  return {
    ...(error === undefined ? {} : { error: IPC_HANDLER_FAILED }),
    ...(errorCode === undefined ? {} : { errorCode: IPC_HANDLER_FAILED }),
  }
}

export function publicIpcResult<T>(value: T): T {
  if (!isFailure(value)) return value
  const legacy = publicLegacyFields(value)
  const failure = 'failure' in value ? publicWireFailure(value.failure) : undefined
  if (!legacy && failure === value.failure) return value
  return { ...value, ...legacy, ...(failure ? { failure } : {}) }
}

let registeringThroughHandle = false

/**
 * 注册 IPC 处理器的唯一入口。没登记的失败，原文和堆栈只写主进程日志，渲染端拿到 IPC_HANDLER_FAILED。
 * 每次调用时才取 ipcMain.handle：main.ts 启动时用慢调用日志和 guardIpcRegistration 替换了它。
 */
export function handle<Args extends unknown[]>(channel: string, handler: IpcHandler<Args>): void {
  registeringThroughHandle = true
  try {
    ipcMain.handle(channel, sanitized(channel, handler))
  } finally {
    registeringThroughHandle = false
  }
}

function sanitized<Args extends unknown[]>(channel: string, handler: IpcHandler<Args>): IpcHandler {
  return async (event, ...args) => {
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
  }
}

type Register = (channel: string, handler: IpcHandler) => void

/**
 * 之后经 ipc 注册的处理器，不是 handle() 发起、通道又不在 direct-channels.json 里的，交给 onUnlisted，
 * 连同这次用的原注册方法（handle 或 handleOnce）。
 * 拦的是 ipc 对象本身，经 electron['ipcMain'] 或注入的 ipc 注册的同样被拦。
 */
export function guardIpcRegistration(
  ipc: Pick<IpcMain, 'handle' | 'handleOnce'>,
  onUnlisted: (channel: string, handler: IpcHandler, register: Register) => void,
): void {
  const direct = new Set<string>(DIRECT_CHANNELS)
  for (const method of ['handle', 'handleOnce'] as const) {
    const register: Register = ipc[method].bind(ipc)
    ipc[method] = (channel: string, handler: IpcHandler) => {
      if (registeringThroughHandle || direct.has(channel)) register(channel, handler)
      else onUnlisted(channel, handler, register)
    }
  }
}

/** 打包版降级为套上 handle() 的失败处理再注册，避免已发布应用因漏登记而打不开。 */
export function rejectUnlistedIpc(packaged: boolean): (channel: string, handler: IpcHandler, register: Register) => void {
  return (channel, handler, register) => {
    const message = `IPC 通道 ${channel} 没有经 electron/ipc/handle.ts 的 handle() 注册：新通道改用 handle()，不要加进 direct-channels.json。`
    console.error(`[AI Novel IPC] ${message}`)
    if (!packaged) throw new Error(message)
    register(channel, sanitized(channel, handler))
  }
}
