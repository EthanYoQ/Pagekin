import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import { ignoreFailure } from '../shared/ignore-failure'
import { toolRegistry } from '../services/agent/tool-registry'
import { caughtFailure, failureText, IPC_HANDLER_FAILED, resultFailure } from '../i18n/app-errors'
import { note, type AuthorNote, type Failure } from '../shared/failure'
import { currentInterfaceLocale, useLocaleStore } from './locale-store'
import type {
  MCPResourceDescription,
  MCPServerStatus,
  MCPToolDescription,
} from '../shared/ipc-channels'

type MCPToolData = MCPToolDescription
type MCPResourceData = MCPResourceDescription
import type { AgentTool } from '../services/agent/tool-registry'

interface MCPState {
  servers: MCPServerStatus[]
  tools: MCPToolData[]
  resources: MCPResourceData[]
  configPath: string | null
  loading: boolean
  error: string | null

  init: () => Promise<void>
  refreshStatus: () => Promise<void>
  connectServer: (serverId: string) => Promise<void>
  disconnectServer: (serverId: string) => Promise<void>
  disconnectAll: () => Promise<void>
  refreshTools: () => Promise<void>
  registerMCPToolsToRegistry: () => void
}

/** IPC_HANDLER_FAILED 只是笼统失败，让给这里的兜底句，与迁移前相同。 */
function mcpErrorText(result: { failure?: Failure }, fallback: AuthorNote): string {
  const failure = resultFailure(result)
  return failureText(currentInterfaceLocale(), failure?.code === IPC_HANDLER_FAILED ? undefined : failure, { fallback })
}

export const useMCPStore = create<MCPState>()((set, get) => ({
  servers: [],
  tools: [],
  resources: [],
  configPath: null,
  loading: false,
  error: null,

  init: async () => {
    set({ loading: true, error: null })
    try {
      const configPath = await ipc.invoke('mcp:get-config-path')
      set({ configPath })

      const result = await ipc.invoke('mcp:load-config')
      if (!result.success) {
        set({ loading: false, error: mcpErrorText(result, note('MCP 配置加载失败', 'Could not load the MCP configuration')) })
        return
      }

      for (const server of result.servers) {
        try {
          const connection = await ipc.invoke('mcp:connect', server.id)
          if (!connection.success) {
            set({ error: mcpErrorText(connection, note('连接失败', 'Connection failed')) })
          }
        } catch (e) {
          console.warn(`[MCP] 连接 ${server.id} 失败:`, e)
          set({ error: useLocaleStore.getState().text('MCP 服务器连接失败', 'Could not connect to the MCP server') })
        }
      }

      await get().refreshStatus()
      await get().refreshTools()

      get().registerMCPToolsToRegistry()

      set({ loading: false })
    } catch (error) {
      set({ loading: false, error: failureText(currentInterfaceLocale(), caughtFailure(error)) })
    }
  },

  refreshStatus: async () => {
    try {
      const servers = await ipc.invoke('mcp:get-servers-status')
      set({ servers: servers as unknown as MCPServerStatus[] })
    } catch (error) {
      console.error('[MCP] 刷新状态失败:', error)
    }
  },

  connectServer: async (serverId) => {
    const result = await ipc.invoke('mcp:connect', serverId)
    if (!result.success) {
      set({ error: mcpErrorText(result, note('连接失败', 'Connection failed')) })
      return
    }
    await get().refreshStatus()
    await get().refreshTools()
    get().registerMCPToolsToRegistry()
  },

  disconnectServer: async (serverId) => {
    await ipc.invoke('mcp:disconnect', serverId)
    toolRegistry.unregisterBySource('mcp')
    await get().refreshStatus()
    await get().refreshTools()
    get().registerMCPToolsToRegistry()
  },

  disconnectAll: async () => {
    await ipc.invoke('mcp:disconnect-all')
    toolRegistry.unregisterBySource('mcp')
    set({ servers: [], tools: [], resources: [] })
  },

  refreshTools: async () => {
    await ignoreFailure('MCP tool list refresh failed', async () => {
      const tools = await ipc.invoke('mcp:list-tools') as unknown[]
      const resources = await ipc.invoke('mcp:list-resources') as unknown[]
      set({ tools: tools as MCPToolData[], resources: resources as MCPResourceData[] })
    })
  },

  registerMCPToolsToRegistry: () => {
    const { tools } = get()

    toolRegistry.unregisterBySource('mcp')

    for (const mcpTool of tools) {
      const agentTool: AgentTool = {
        name: `mcp__${mcpTool.serverId}__${mcpTool.name}`,
        description: mcpTool.description || `MCP Tool: ${mcpTool.name}`,
        source: 'mcp',
        inputSchema: {
          type: 'object',
          properties: (mcpTool.inputSchema as { properties?: Record<string, unknown> })?.properties as Record<string, { type: string; description: string }> ?? {},
          required: (mcpTool.inputSchema as { required?: string[] })?.required,
        },
        requiresConfirmation: true,
        isReadOnly: false,
        userFacingName: `${mcpTool.name} (${mcpTool.serverId})`,
        execute: async (args) => {
          const result = await ipc.invoke('mcp:call-tool', mcpTool.serverId, mcpTool.name, args)
          return {
            success: result.success,
            content: result.content,
            error: result.success ? undefined : failureText(currentInterfaceLocale(), resultFailure(result)),
          }
        },
      }
      toolRegistry.register(agentTool)
    }

    if (tools.length > 0) {
      console.log(`[MCP] 已注册 ${tools.length} 个 MCP Tool 到 ToolRegistry`)
    }
  },
}))
