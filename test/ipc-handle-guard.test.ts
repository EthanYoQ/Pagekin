import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './helpers/repo-source-files'
import BASELINE from '../electron/ipc/direct-handle-baseline.json'

// 迁到 handle() 的文件也从这里删掉，名单就不能再把它加回去。
const ORIGINAL_BASELINE: readonly string[] = [
  'electron/controllers/app-data-controller.ts',
  'electron/controllers/chapter-lifecycle-controller.ts',
  'electron/controllers/character-avatar-controller.ts',
  'electron/controllers/cloud-backup-controller.ts',
  'electron/controllers/config-controller.ts',
  'electron/controllers/db-controller.ts',
  'electron/controllers/external-file-grant-controller.ts',
  'electron/controllers/finalization-controller.ts',
  'electron/controllers/fs-controller.ts',
  'electron/controllers/generation-controller.ts',
  'electron/controllers/import-controller.ts',
  'electron/controllers/llm-controller.ts',
  'electron/controllers/model-provider-resource-controller.ts',
  'electron/controllers/official-homepage-controller.ts',
  'electron/controllers/project-archive-controller.ts',
  'electron/controllers/project-controller.ts',
  'electron/controllers/stage-notification-controller.ts',
  'electron/controllers/window-controller.ts',
  'electron/main.ts',
  'electron/mcp/mcp-ipc-bridge.ts',
]
const eslint = new ESLint({ cwd: REPO_ROOT })
const PROBE = 'electron/controllers/ipc-handle-probe.ts'

async function syntaxErrors(filePath: string, code: string, marker: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(REPO_ROOT, filePath) })
  return result!.messages.filter(message => message.message.includes(marker)).map(message => message.message)
}
const directHandleErrors = (filePath: string, code: string) => syntaxErrors(filePath, code, 'electron/ipc/handle.ts')

describe('主进程按标识符禁止直接注册 IPC 处理器', () => {
  it.each([
    "import { ipcMain } from 'electron'\nipcMain.handle('demo:x', () => 1)",
    "import { ipcMain } from 'electron'\nconst register = ipcMain.handle.bind(ipcMain)",
    "import { ipcMain } from 'electron'\nexport const deps = { ipc: ipcMain }",
    "import { ipcMain } from 'electron'\nexport function register(ipc = ipcMain) { return ipc }",
    'const ipcMain = { handle: (_channel: string) => undefined }\nipcMain.handle(\'demo:x\')',
    "import { ipcMain as main } from 'electron'\nmain.handle('demo:x', () => 1)",
    "import { ipcMain } from 'electron'\nipcMain['handle']('demo:x', () => 1)",
    "import { ipcMain } from 'electron'\nipcMain[`handle`]('demo:x', () => 1)",
  ])('新文件报错并点名 handle()：%s', async code => {
    expect(await directHandleErrors(PROBE, code)).toEqual([expect.stringContaining('改用 electron/ipc/handle.ts 的 handle()')])
  })

  it.each([
    "import { handle } from '../ipc/handle'\nhandle('demo:x', () => 1)",
    "import { ipcMain } from 'electron'\nipcMain.removeHandler('demo:x')",
    "import { ipcMain } from 'electron'\nimport { installIpcSlowCallLog } from '../services/ipc-slow-call-log'\ninstallIpcSlowCallLog(ipcMain)",
  ])('不直接注册的写法不报：%s', async code => {
    expect(await directHandleErrors(PROBE, code)).toEqual([])
  })

  it('入口自己和测试文件不受限', async () => {
    const code = "import { ipcMain } from 'electron'\nipcMain.handle('demo:x', () => 1)"
    expect(await directHandleErrors('electron/ipc/handle.ts', code)).toEqual([])
    expect(await directHandleErrors('electron/controllers/__tests__/ipc-handle-probe.test.ts', code)).toEqual([])
  })

  it('名单里的文件照样禁止直接打开 LanceDB', async () => {
    const code = "export const open = () => import('@lancedb/lancedb')"
    expect(await syntaxErrors('electron/ipc/handle.ts', code, 'lance-database.ts')).not.toEqual([])
  })
})

describe('直接注册 IPC 的存量名单只减不增', () => {
  it('名单只能是建立时名单的子集：新文件改用 handle()，不进名单，也不能顶替删掉的名额', () => {
    expect(BASELINE.filter(file => !ORIGINAL_BASELINE.includes(file))).toEqual([])
    expect(BASELINE).toEqual([...new Set(BASELINE)].sort())
  })

  it('名单里每个文件仍在直接注册，迁到 handle() 的要从名单删除', async () => {
    const stale: string[] = []
    for (const file of BASELINE) {
      const probe = posix.join(posix.dirname(file), 'ipc-handle-probe.ts')
      if ((await directHandleErrors(probe, readFileSync(join(REPO_ROOT, file), 'utf8'))).length === 0) stale.push(file)
    }
    expect(stale).toEqual([])
  }, 60_000)
})
