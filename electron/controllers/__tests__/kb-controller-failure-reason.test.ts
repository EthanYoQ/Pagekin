import { beforeEach, describe, expect, it, vi } from 'vitest'

import { shown as shownLocale } from '../../../src/i18n/__tests__/shown-locale'
import { appErrorMessage } from '../../../src/i18n/app-errors'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  run: vi.fn(),
  currentProjectPath: vi.fn<() => string | null>(() => 'C:/projects/A'),
}))

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'zh-CN') },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) }) },
}))
vi.mock('../../database', () => ({ getCurrentProjectPath: mocks.currentProjectPath }))
vi.mock('../../services/project-access', () => ({
  projectAccess: { assertCurrentProjectContext: vi.fn(() => ({ rootPath: 'C:/projects/A' })) },
}))
vi.mock('../../services/project-storage-preflight', () => ({
  assertKnowledgeBaseStoragePathSupported: vi.fn(),
  projectStoragePreflightFailure: vi.fn(() => undefined),
}))
vi.mock('../../utils/config-utils', () => ({
  readJsonFile: vi.fn((_path: string, fallback: unknown) => fallback),
  GLOBAL_CONFIG_PATH: 'global.json',
  DEFAULT_GLOBAL_CONFIG: {},
  MODELS_CONFIG_PATH: 'models.json',
}))
vi.mock('../../services/knowledge-base-loader', () => ({ knowledgeBaseLoader: { run: mocks.run } }))
vi.mock('../../i18n', () => ({ mainText: vi.fn((_locale: string, zh: string) => zh) }))

import { registerKBController } from '../kb-controller'

const session = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }

function invoke(channel: string, ...args: unknown[]) {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return handler({ sender: { id: 1, once: vi.fn() } }, ...args, session)
}

/** Electron 只把 message 带过 IPC，渲染端看到的是这个外壳。 */
async function shownAfterIpc(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => { throw new Error('expected the channel to reject') }, (rejected: Error) => rejected)
  return appErrorMessage(shownLocale('zh-CN'), new Error(`Error invoking remote method 'kb:search': Error: ${error.message}`))
}

const lanceFailure = () => Object.assign(new Error(
  'Failed to get next batch from stream: lance error: LanceError(IO): Object at location C:\\projects\\A\\.ai-novel\\lancedb\\chunks.lance\\data\\a.lance not found (os error 2)',
), { code: 'GenericFailure' })

beforeEach(() => {
  mocks.handlers.clear()
  mocks.run.mockReset()
  mocks.currentProjectPath.mockReturnValue('C:/projects/A')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  registerKBController()
})

describe('knowledge-base channels that throw', () => {
  it('shows a readable reason instead of a LanceDB error when searching fails', async () => {
    mocks.run.mockRejectedValue(lanceFailure())

    const shown = await shownAfterIpc(invoke('kb:search', '潮位', 5, 'C:/projects/A'))

    expect(shown).toBe('知识库没有改动。这次操作出了意外问题；请再试一次，还不行请把这条提示反馈给我们。')
    expect(console.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ code: 'GenericFailure' }))
  })

  it('names a full disk when listing the material fails with ENOSPC', async () => {
    mocks.run.mockRejectedValue(Object.assign(new Error("ENOSPC: no space left on device, open 'C:\\projects\\A\\x'"), { code: 'ENOSPC' }))

    const shown = await shownAfterIpc(invoke('kb:list-documents', 'C:/projects/A'))

    expect(shown).toBe('知识库没有改动。磁盘空间不足，写不进去；清理磁盘后再试一次。')
  })

  it('passes a code it already knows straight through', async () => {
    mocks.run.mockRejectedValue(new Error('GENERATION_KNOWLEDGE_BUSY'))

    await expect(invoke('kb:search', '潮位', 5, 'C:/projects/A')).rejects.toThrow(/^GENERATION_KNOWLEDGE_BUSY$/u)
  })

  it('asks the author to open a project when a reference import arrives with none open', async () => {
    mocks.currentProjectPath.mockReturnValue(null)

    const shown = await shownAfterIpc(invoke('kb:import-reference-text', 1, 'run-1', { owner: 'o', epoch: 1 }))

    expect(shown).toBe(appErrorMessage(shownLocale('zh-CN'), 'PROJECT_NOT_OPEN'))
  })
})
