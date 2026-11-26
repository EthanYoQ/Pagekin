import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  projectPath: '',
  accessError: undefined as Error | undefined,
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) } },
}))
vi.mock('../../i18n', async importOriginal => ({ ...await importOriginal<object>(), mainText: (_locale: unknown, zhCN: string) => zhCN }))
vi.mock('../../database', () => ({ getCurrentProjectPath: () => mocks.projectPath }))
vi.mock('../../services/project-access', () => ({
  projectAccess: {
    assertCurrentProjectContext: () => {
      if (mocks.accessError) throw mocks.accessError
      return { rootPath: mocks.projectPath }
    },
  },
}))

import { registerFSController } from '../fs-controller'
import { registerExternalFileGrantController } from '../external-file-grant-controller'
import { ExternalFileGrantService } from '../../services/external-file-grant-service'
import type { WindowsSafeFileSystem } from '../../security/windows-safe-file-system'
import { nodeTestSecureFileSystem } from '../../../test/helpers/node-test-secure-file-system'
import { requireIpcSuccess } from '../../../src/services/ipc-result'
import { receivedIpcResult } from '../../../src/i18n/app-errors'
import { useLocaleStore } from '../../../src/stores/locale-store'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-file-failure-copy-'))
const projectPath = path.join(root, 'project')
const exportDirectory = path.join(root, 'exports')
fs.mkdirSync(path.join(projectPath, '.ai-novel'), { recursive: true })
fs.writeFileSync(path.join(projectPath, '.ai-novel', 'partial_arch.json'), '{}', 'utf8')
fs.mkdirSync(exportDirectory)
fs.writeFileSync(path.join(exportDirectory, 'book.md'), 'old', 'utf8')
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const failing = (error: Error): WindowsSafeFileSystem => ({
  ...nodeTestSecureFileSystem,
  readText: async () => { throw error },
  writeTextAtomically: async () => { throw error },
  mkdir: async () => { throw error },
})

async function shown(result: Promise<unknown>): Promise<string> {
  try {
    requireIpcSuccess(receivedIpcResult(await result) as { success: boolean }, '读写文件')
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('应当失败')
}

const session = () => ({ projectId: 'project', leaseId: 'lease', projectPath })
const project = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)!({}, ...args, session())

beforeEach(() => {
  mocks.handlers.clear()
  mocks.projectPath = projectPath
  mocks.accessError = undefined
  useLocaleStore.setState({ interfaceLocale: 'zh-CN', locale: 'zh-CN' })
})

describe('文件读写失败的说明与 master 逐字相同', () => {
  const file = path.join(projectPath, '.ai-novel', 'partial_arch.json')

  it.each([
    ['fs:write-json', [file, {}, projectPath], '无法写入项目数据。'],
    ['fs:write-file', [file, '{}', projectPath], '无法写入项目文件。'],
    ['fs:mkdir', [path.join(projectPath, 'prompts'), projectPath], '无法创建项目目录。'],
    ['fs:read-file', [file, projectPath], '无法读取项目文件。'],
    ['fs:read-json', [file, projectPath], '无法读取项目数据。'],
  ])('%s 在文件层失败时', async (channel, args, expected) => {
    registerFSController(failing(new Error('EACCES C:\\Users\\writer\\project')))
    await expect(shown(project(channel, ...args))).resolves.toBe(expected)
  })

  it('读不到的项目文件提示改用 read_architecture', async () => {
    registerFSController(failing(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })))
    await expect(shown(project('fs:read-file', file, projectPath))).resolves
      .toBe('项目文件不存在。请检查文件路径；故事架构保存在项目数据中，请使用 read_architecture 工具读取。')
  })

  it.each([
    ['PROJECT_SESSION_STALE', '项目租约已失效，已拒绝操作。'],
    ['PROJECT_SESSION_REQUIRED', '缺少项目会话上下文，已拒绝操作。'],
    ['PROJECT_FILE_OUTSIDE_PROJECT', '目标超出当前项目范围，已拒绝操作。'],
    ['PROJECT_CONTEXT_CHANGED', '检测到跨项目读写，已拒绝操作。'],
  ])('项目会话拒绝 %s', async (code, expected) => {
    registerFSController(nodeTestSecureFileSystem)
    mocks.accessError = new Error(code)
    await expect(shown(project('fs:write-file', file, '{}', projectPath))).resolves.toBe(expected)
  })

  const grantsFor = (operations: Array<'write' | 'create'> = ['write', 'create'], webContentsId = 17) => {
    const grants = new ExternalFileGrantService({ now: () => 1_000, newGrantId: () => 'grant' })
    grants.issueDirectory({ webContentsId, directoryPath: exportDirectory, operations, ttlMs: 60_000, maxUses: 10 })
    return grants
  }
  const event = { sender: { id: 17, once: () => undefined } }
  const grantWrite = (relativePath = 'book.md') => mocks.handlers.get('fs:grant-write-file')!(event, 'grant', relativePath, 'new')

  it.each([
    ['SECURE_FS_HELPER_UNAVAILABLE', '安全外部文件服务不可用，已拒绝操作。'],
    ['SECURE_FS_REPARSE_POINT', '外部文件授权路径无效，已拒绝操作。'],
    ['EXTERNAL_FILE_GRANT_EXPIRED', '外部文件授权已失效，请重新选择。'],
    ['EACCES C:\\Users\\writer\\book.md', '外部文件授权操作失败。'],
  ])('导出写文件遇到 %s', async (code, expected) => {
    registerExternalFileGrantController(grantsFor(), failing(new Error(code)))
    await expect(shown(grantWrite())).resolves.toBe(expected)
  })

  it('导出写文件被拒：别的窗口、越出所选目录、授权不存在', async () => {
    registerExternalFileGrantController(grantsFor(['write', 'create'], 18), nodeTestSecureFileSystem)
    await expect(shown(grantWrite())).resolves.toBe('当前窗口无权使用该外部文件授权。')
    mocks.handlers.clear()
    registerExternalFileGrantController(grantsFor(), nodeTestSecureFileSystem)
    await expect(shown(grantWrite('../outside.md'))).resolves.toBe('外部文件授权路径无效，已拒绝操作。')
    await expect(shown(mocks.handlers.get('fs:grant-mkdir')!(event, 'missing', 'split'))).resolves.toBe('外部文件授权已失效，请重新选择。')
  })

  it.each([
    ['SECURE_FS_INVALID_TEXT', '这个文件不是 UTF-8 编码的文本。请用文本编辑器另存为 UTF-8 后重新导入。'],
    ['SECURE_FS_FILE_TOO_LARGE', '这个文件超过 64 MB，读不进来。请拆成几个小文件后重新导入。'],
    ['SECURE_FS_OPEN_FAILED', '系统不让打开这个文件。请把它复制到桌面等普通文件夹，再重新导入。'],
    ['SECURE_FS_FILE_IN_USE', '这个文件正被别的程序占用。请关掉打开它的程序，再重新导入。'],
    ['EACCES C:\\Users\\writer\\notes.txt', '无法读取所选文件；请重新选择后再试。'],
  ])('读外部文件遇到 %s', async (code, expected) => {
    const grants = new ExternalFileGrantService({ now: () => 1_000, newGrantId: () => 'read' })
    grants.issueFile({ webContentsId: 17, filePath: path.join(exportDirectory, 'book.md'), operations: ['read'], ttlMs: 60_000, maxUses: 1 })
    registerExternalFileGrantController(grants, failing(new Error(code)))
    await expect(shown(mocks.handlers.get('fs:grant-read-file')!(event, 'read'))).resolves.toBe(expected)
  })
})

describe('目标文件被占用时显示目录说明', () => {
  it('SECURE_FS_TARGET_IN_USE：文件没改，关掉占用的程序后重新导出', async () => {
    registerExternalFileGrantController(grantsForTargetInUse(), failing(new Error('SECURE_FS_TARGET_IN_USE')))
    const result = await mocks.handlers.get('fs:grant-write-file')!({ sender: { id: 17, once: () => undefined } }, 'grant', 'book.md', 'new')
    await expect(shown(Promise.resolve(result))).resolves
      .toBe('文件没有改动。目标文件正被其他程序打开，关掉它后再点「选择目录并导出」。')
    expect(result).toMatchObject({ success: false, commitState: 'not_committed' })
  })

  function grantsForTargetInUse() {
    const grants = new ExternalFileGrantService({ now: () => 1_000, newGrantId: () => 'grant' })
    grants.issueDirectory({ webContentsId: 17, directoryPath: exportDirectory, operations: ['write', 'create'], ttlMs: 60_000, maxUses: 10 })
    return grants
  }
})

it('列目录时目录已不存在，渲染端仍能认出是缺目录', async () => {
  registerFSController(nodeTestSecureFileSystem)
  await expect(project('fs:list-dir', path.join(projectPath, '.ai-novel', 'skills'), projectPath)).rejects.toThrow(/^PROJECT_FILE_NOT_FOUND$/u)
})
