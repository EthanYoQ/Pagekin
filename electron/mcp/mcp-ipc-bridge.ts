/**
 * MCP IPC 桥接
 *
 * 在 Electron 主进程注册 MCP 相关的 IPC 处理器，
 * 让渲染进程能够通过 IPC 管理和调用 MCP 服务器。
 */

import { IPC_HANDLER_FAILED, registeredErrorCode } from '../../src/i18n/app-errors'
import { failureCode, type WireFailure } from '../../src/shared/failure'
import { handle } from '../ipc/handle'
import { mcpManager } from './mcp-manager'

/** 已登记的码照传，其余原文只进日志。 */
function mcpFailure(error: unknown): WireFailure {
  const code = failureCode(registeredErrorCode(error))
  if (!code) console.error('[MCP] 操作失败:', error)
  return { code: code ?? IPC_HANDLER_FAILED }
}

/**
 * 注册所有 MCP IPC 处理器
 * 在 main.ts 中调用
 */
export function registerMCPHandlers(): void {
  // 加载配置文件
  handle('mcp:load-config', async () => {
    try {
      const result = await mcpManager.loadConfig()
      if (result.status === 'error') return { success: false, status: result.status, servers: result.servers, failure: mcpFailure(result.error) }
      return { success: true, ...result }
    } catch {
      return { success: false, status: 'error' as const, servers: [], failure: { code: 'MCP_CONFIG_INVALID' } }
    }
  })

  // 连接服务器
  handle('mcp:connect', async (_event, serverId: string) => {
    try {
      await mcpManager.connect(serverId)
      return { success: true }
    } catch {
      return { success: false, failure: { code: 'MCP_CONNECT_FAILED' } }
    }
  })

  // 断开服务器
  handle('mcp:disconnect', async (_event, serverId: string) => {
    try {
      await mcpManager.disconnect(serverId)
      return { success: true }
    } catch (error) {
      return { success: false, failure: mcpFailure(error) }
    }
  })

  // 断开所有
  handle('mcp:disconnect-all', async () => {
    try {
      await mcpManager.disconnectAll()
      return { success: true }
    } catch (error) {
      return { success: false, failure: mcpFailure(error) }
    }
  })

  // 获取所有可用 Tool
  handle('mcp:list-tools', async () => {
    return mcpManager.getAllTools()
  })

  // 获取所有可用资源
  handle('mcp:list-resources', async () => {
    return mcpManager.getAllResources()
  })

  // 调用 MCP Tool
  handle('mcp:call-tool', async (_event, serverId: string, toolName: string, args: Record<string, unknown>) => {
    const { success, content, error } = await mcpManager.callTool(serverId, toolName, args)
    return success ? { success, content } : { success, content, failure: mcpFailure(error) }
  })

  // 获取服务器状态
  handle('mcp:get-servers-status', async () => {
    return mcpManager.getServersStatus()
  })

  // 获取默认配置文件路径
  handle('mcp:get-config-path', async () => {
    return mcpManager.getDefaultConfigPath()
  })

  console.log('[MCP] IPC 处理器已注册')
}
