import type {
  AllInvokeChannels,
  AllEventChannels,
  InvokeChannel,
  EventChannel,
} from '../shared/ipc-channels'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import { getActiveProjectSessionContext } from '../shared/project-session-context'
import type { AiNovelAPI } from '../shared/desktop-api'
import { receivedIpcResult } from '../i18n/app-errors'

function getAPI(): AiNovelAPI {
  const api = typeof window === 'undefined' ? undefined : window.aiNovelAPI
  if (!api) {
    // i18n-exempt: 只在 Electron 以外（单元测试、纯浏览器调试）出现，作者用的桌面应用总有 aiNovelAPI
    // i18n-exempt: 只在 Electron 以外（单元测试、纯浏览器调试）出现，作者用的桌面应用总有 aiNovelAPI
    throw new Error('桌面接口 aiNovelAPI 未就绪，请重新启动应用')
  }
  return api
}

function isCapabilityOrAppDataChannel(channel: string): boolean {
  return channel.startsWith('fs:grant-')
    || channel.startsWith('dialog:select-')
    || channel.startsWith('prompt:')
    || channel.startsWith('skills:')
}

function isProjectScopedChannel(channel: string): boolean {
  if (isCapabilityOrAppDataChannel(channel)) return false
  return channel.startsWith('generation:')
    || channel.startsWith('character-proposal:')
    || channel.startsWith('character-identity:')
    || channel.startsWith('character-avatar:')
    || channel.startsWith('finalized-character:')
    || channel.startsWith('finalization-generation:')
    || channel.startsWith('graph-generation:')
    || channel.startsWith('legacy-roster:')
    || channel.startsWith('review-revision:')
    || channel.startsWith('agent-generation:')
    || channel.startsWith('import-generation:')
    || channel.startsWith('editor-inline:')
    || channel.startsWith('db:')
    || channel.startsWith('kb:')
    || channel.startsWith('chapter:')
    || channel.startsWith('fs:')
    || channel === 'project:save'
    || channel === 'project:update-config'
    || channel === 'project:delete'
    || channel === 'project:overview-current'
}

/** finalization-client 另走定稿通道，不经此处。 */
async function invokeWithSession<C extends InvokeChannel>(
  channel: C,
  args: AllInvokeChannels[C]['args'],
  context?: ProjectSessionContext,
): Promise<AllInvokeChannels[C]['return']> {
  if (!isProjectScopedChannel(channel)) {
    return receivedIpcResult(await getAPI().invoke(channel, ...args)) as AllInvokeChannels[C]['return']
  }
  const projectSession = context ?? getActiveProjectSessionContext()
  if (!projectSession) {
    throw new Error('GENERATION_PROJECT_SESSION_REQUIRED')
  }
  return receivedIpcResult(await getAPI().invoke(channel, ...args, projectSession)) as AllInvokeChannels[C]['return']
}

export const ipc = {
  invoke: async <C extends InvokeChannel>(
    channel: C,
    ...args: AllInvokeChannels[C]['args']
  ): Promise<AllInvokeChannels[C]['return']> => {
    console.log('[ipc-client.invoke] 调用通道:', channel, '参数数量:', args.length)
    const result = await invokeWithSession(channel, args)
    console.log('[ipc-client.invoke] 调用完成:', channel)
    return result
  },

  invokeWithProjectSession: async <C extends InvokeChannel>(
    context: ProjectSessionContext,
    channel: C,
    ...args: AllInvokeChannels[C]['args']
  ): Promise<AllInvokeChannels[C]['return']> => {
    if (!isProjectScopedChannel(channel)) {
      // i18n-exempt: 通道类型已限定在项目会话范围内，只有绕过类型的调用才会触发
      // i18n-exempt: 通道类型已限定在项目会话范围内，只有绕过类型的调用才会触发
      throw new Error(`通道不属于项目会话范围：${channel}`)
    }
    return invokeWithSession(channel, args, context)
  },

  on: <C extends EventChannel>(
    channel: C,
    callback: (data: AllEventChannels[C]) => void,
  ): (() => void) => {
    return getAPI().on(channel, callback as (...args: unknown[]) => void)
  },

  once: <C extends EventChannel>(
    channel: C,
    callback: (data: AllEventChannels[C]) => void,
  ) => {
    getAPI().once(channel, callback as (...args: unknown[]) => void)
  },

  send: (channel: string, ...args: unknown[]) => {
    getAPI().send(channel, ...args)
  },

  get isElectron(): boolean {
    return typeof window !== 'undefined'
      && !!window.aiNovelAPI
  },

  setZoomLevel: (level: number) => {
    getAPI().setZoomLevel(level)
  },

  setZoomFactor: (factor: number) => {
    getAPI().setZoomFactor(factor)
  },

  getZoomLevel: () => {
    return getAPI().getZoomLevel()
  }
}
