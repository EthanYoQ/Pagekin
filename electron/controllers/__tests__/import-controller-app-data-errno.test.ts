import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  showOpenDialog: vi.fn(),
}))

vi.mock('electron', async () => {
  const { shownSelectionFailure } = await import('./shown-selection-failure')
  return {
  app: { getLocale: () => 'zh-CN' },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, shownSelectionFailure(handler))
    }),
  },
  }
})

vi.mock('../../services/import-source-identity-secret', () => ({
  loadApplicationImportSourceSecret: () => {
    throw Object.assign(new Error('EPERM: operation not permitted, open import-source-identity.secret'), { code: 'EPERM' })
  },
}))

import { registerImportController } from '../import-controller'
import { nodeTestSecureFileSystem } from '../../../test/helpers/node-test-secure-file-system'
import { READ_FAILURE_TEXT } from '../../../test/helpers/external-file-read-codes'

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-import-app-data-'))
const globalEnvironmentKeys = ['AI_NOVEL_APP_DATA_HOME', 'AI_NOVEL_LEGACY_SOURCE_HOME', 'AI_NOVEL_VELA_HOME'] as const
const previousGlobalEnvironment = new Map<string, string | undefined>()
let globalFixtureRoot = ''

beforeAll(async () => {
  for (const key of globalEnvironmentKeys) previousGlobalEnvironment.set(key, process.env[key])
  const cache = path.resolve('.runtime/.cache')
  fs.mkdirSync(cache, { recursive: true })
  globalFixtureRoot = fs.mkdtempSync(path.join(cache, 'controller-global-import-app-data-errno-'))
  process.env.AI_NOVEL_LEGACY_SOURCE_HOME = path.join(globalFixtureRoot, 'legacy')
  await (await import('../../services/__tests__/global-data-fixture')).prepareGlobalDataFixture(globalFixtureRoot)
})

afterAll(() => {
  for (const key of globalEnvironmentKeys) {
    const previous = previousGlobalEnvironment.get(key)
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
  vi.resetModules()
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
  if (globalFixtureRoot) fs.rmSync(globalFixtureRoot, { recursive: true, force: true })
})

it('应用数据目录里的文件读不了时，不让作者去挪小说文件（#763）', async () => {
  const selected = path.join(temporaryRoot, 'novel.txt')
  fs.writeFileSync(selected, '第1章 开始\n正文', 'utf8')
  registerImportController(nodeTestSecureFileSystem)
  mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })

  const result = await mocks.handlers.get('dialog:select-novel-files')!({ sender: { id: 7, once: vi.fn() } })

  expect(result).toEqual({ success: false, error: READ_FAILURE_TEXT.generic })
})
