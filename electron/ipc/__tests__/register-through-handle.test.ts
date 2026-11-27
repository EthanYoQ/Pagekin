import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { REPO_ROOT, repoSourceFiles } from '../../../test/helpers/repo-source-files'

const NOT_PRODUCTION = /\/__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/u
const DIRECT_REGISTRATION = /\bipcMain\s*(?:\.\s*|\[\s*['"])(?:handle|handleOnce|on|once|addListener|prependListener|prependOnceListener)\b/u

it('主进程只能经 handle() 注册 IPC：源码里不直接调 ipcMain 的注册方法', () => {
  const direct = repoSourceFiles('electron')
    .filter(file => /\.[cm]?tsx?$/u.test(file) && !NOT_PRODUCTION.test(file) && file !== 'electron/ipc/handle.ts')
    .filter(file => DIRECT_REGISTRATION.test(readFileSync(join(REPO_ROOT, file), 'utf8')))
  expect(direct).toEqual([])
})

it('守卫认得出直接注册的几种写法', () => {
  for (const source of ["ipcMain.handle('a:b', fn)", "ipcMain.on('a:b', fn)", "ipcMain['once']('a:b', fn)", 'ipcMain .handleOnce(x, fn)']) {
    expect(DIRECT_REGISTRATION.test(source), source).toBe(true)
  }
  expect(DIRECT_REGISTRATION.test('ipcMain.removeHandler(channel)')).toBe(false)
})
