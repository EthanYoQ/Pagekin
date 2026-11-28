import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  loadConfig: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  disconnectAll: vi.fn(),
  getAllTools: vi.fn((): unknown[] => []),
  getAllResources: vi.fn((): unknown[] => []),
  callTool: vi.fn(),
  getServersStatus: vi.fn((): unknown[] => []),
  getDefaultConfigPath: vi.fn(() => 'C:/isolated/.vela/mcp_config.json'),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('../mcp-manager', () => ({ mcpManager: mocks }))

import { registerMCPHandlers } from '../mcp-ipc-bridge'

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

beforeAll(() => registerMCPHandlers())

beforeEach(() => {
  vi.clearAllMocks()
  mocks.loadConfig.mockResolvedValue({
    status: 'loaded',
    servers: [{ id: 'safe-id', name: 'Safe server', transport: 'stdio' }],
  })
})

describe('MCP IPC trust boundary', () => {
  it('does not accept an arbitrary config path or expose trusted launch configuration', async () => {
    const result = await handler('mcp:load-config')({}, 'C:/attacker/config.json')

    expect(mocks.loadConfig).toHaveBeenCalledWith()
    expect(result).toEqual({
      success: true,
      status: 'loaded',
      servers: [{ id: 'safe-id', name: 'Safe server', transport: 'stdio' }],
    })
    expect(JSON.stringify(result)).not.toMatch(/command|args|env|url|SECRET_(?:COMMAND|ARGUMENT|ENV|URL)_MARKER/iu)
  })

  it('connects by a previously loaded server id and reports initialization failure', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('SECRET_INITIALIZE_ERROR_MARKER'))

    const result = await handler('mcp:connect')({}, 'safe-id')
    expect(result).toEqual({
      success: false,
      failure: { code: 'MCP_CONNECT_FAILED' },
    })
    expect(JSON.stringify(result)).not.toContain('SECRET_INITIALIZE_ERROR_MARKER')
    expect(mocks.connect).toHaveBeenCalledWith('safe-id')
  })

  it('makes malformed configuration visible while preserving missing as a distinct state', async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      status: 'error',
      servers: [],
      error: 'MCP_CONFIG_INVALID',
    })
    await expect(handler('mcp:load-config')({})).resolves.toEqual({
      success: false,
      status: 'error',
      servers: [],
      failure: { code: 'MCP_CONFIG_INVALID' },
    })

    mocks.loadConfig.mockResolvedValueOnce({ status: 'missing', servers: [] })
    await expect(handler('mcp:load-config')({})).resolves.toEqual({
      success: true,
      status: 'missing',
      servers: [],
    })
  })

  it.each([
    ['mcp:disconnect', () => mocks.disconnect.mockRejectedValueOnce(new Error('SECRET_DISCONNECT_MARKER C:/Users/a'))],
    ['mcp:disconnect-all', () => mocks.disconnectAll.mockRejectedValueOnce(new Error('SECRET_DISCONNECT_MARKER C:/Users/a'))],
  ] as const)('%s 失败时只回通用码，原文留在主进程', async (channel, fail) => {
    fail()
    const result = await handler(channel)({}, 'safe-id')
    expect(result).toEqual({ success: false, failure: { code: 'IPC_HANDLER_FAILED' } })
  })

  it('工具调用失败只回码：已登记的照传，服务器原文不过 IPC', async () => {
    mocks.callTool.mockResolvedValueOnce({ success: false, content: '', error: 'MCP_SERVER_NOT_CONNECTED' })
    await expect(handler('mcp:call-tool')({}, 'safe-id', 'tool', {})).resolves.toEqual({ success: false, content: '', failure: { code: 'MCP_SERVER_NOT_CONNECTED' } })

    mocks.callTool.mockResolvedValueOnce({ success: false, content: '', error: 'Error: SECRET_TOOL_MARKER at C:/Users/a/server.js' })
    const raw = await handler('mcp:call-tool')({}, 'safe-id', 'tool', {})
    expect(raw).toEqual({ success: false, content: '', failure: { code: 'IPC_HANDLER_FAILED' } })
  })
})
