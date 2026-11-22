import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, it, vi } from 'vitest'
vi.mock('playwright', () => ({ _electron: { launch: () => { throw new Error('UNIT_TEST_MUST_NOT_LAUNCH_ELECTRON') } } }))
import { kill } from '../drive.mjs'

const children = []
const parents = []
afterEach(() => {
  for (const child of children.splice(0)) if (alive(child.pid)) try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { child.kill('SIGKILL') }
  for (const parent of parents.splice(0)) fs.rmSync(parent, { recursive: true, force: true, maxRetries: 10 })
})

const userDataDir = () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-kill-'))
  parents.push(parent)
  return parent
}
const track = child => { children.push(child); return child }
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const fakeApp = () => {
  const child = track(spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore', windowsHide: true }))
  return { process: () => child }
}

/** 脚本末尾的 `# --user-data-dir=` 是 PowerShell 注释，只为让占锁进程的命令行带上它，kill 才会把它认成被杀实例的同树进程。 */
async function holdWindowsLock(userData, heldMs) {
  const script = `$f = [System.IO.File]::Open($env:DRIVE_LOCK, 'OpenOrCreate', 'ReadWrite', 'None'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${heldMs} # --user-data-dir=${userData}`
  const child = track(spawn('powershell.exe', ['-NoProfile', '-Command', script], { env: { ...process.env, DRIVE_LOCK: path.join(userData, 'lockfile') }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }))
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('locked')) resolve() })
    child.once('exit', code => reject(new Error(`占锁进程提前退出：${code}`)))
  })
  return child
}

const lockOpenable = userData => { try { fs.closeSync(fs.openSync(path.join(userData, 'lockfile'), 'r+')); return true } catch (error) { return error.code === 'ENOENT' } }

it.runIf(process.platform === 'win32')('Windows：强杀后等同一 userData 的进程都退出、lockfile 放开才返回', async () => {
  const userData = userDataDir()
  const holder = await holdWindowsLock(userData, 4000)
  await kill(fakeApp(), userData)
  assert.equal(alive(holder.pid), false, 'kill 返回时占锁进程已退出')
  assert.equal(lockOpenable(userData), true, 'kill 返回时 lockfile 已能读写打开')
}, 30_000)

it.runIf(process.platform === 'win32')('Windows：lockfile 一直被占时在上限内报错，并写出锁路径', async () => {
  const userData = userDataDir()
  await holdWindowsLock(userData, 60_000)
  const startedAt = Date.now()
  await assert.rejects(kill(fakeApp(), userData, 2000), error => error.message.includes(path.join(userData, 'lockfile')))
  assert.ok(Date.now() - startedAt < 10_000, `超时报错用了 ${Date.now() - startedAt} ms`)
}, 30_000)

it.skipIf(process.platform === 'win32')('macOS 与 Linux：SingletonLock 指向的 pid 退出后就返回，留下的旧链接不算占用', async () => {
  const userData = userDataDir()
  const holder = track(spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)', '--', `--user-data-dir=${userData}`], { stdio: 'ignore' }))
  fs.symlinkSync(`${os.hostname()}-${holder.pid}`, path.join(userData, 'SingletonLock'))
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(alive(holder.pid), true, '占锁进程已启动')
  await kill(fakeApp(), userData)
  assert.equal(alive(holder.pid), false, 'kill 返回时 SingletonLock 指向的进程已退出')
}, 30_000)
