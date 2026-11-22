import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const name = STAGE_SAMPLE.name
const RAW = /SqliteError|malformed|EBUSY|EPERM|EACCES|SQLITE_|PROJECT_|resource busy|not permitted|发生错误|\.ai-novel/u

const COPY = {
  zh: {
    title: '打开作品失败',
    damaged: '作品文件已损坏，打不开。导出过存档的，可以在设置的「项目备份」里点「从本地存档恢复副本」。',
    locked: `作品文件正被别的程序占用，这次没能打开。稍等几秒，再点「打开《${name}》」。`,
    denied: '没有权限读取作品文件，打不开。请检查作品文件夹的权限，或把文件夹移到有权限的位置再打开。',
  },
  en: {
    title: 'Couldn’t open the book',
    damaged: 'The book’s files are damaged, so it can’t be opened. If you exported an archive, go to Settings > Project backup and click Restore a copy from local archive.',
    locked: `Another program is using the book’s files, so it could not be opened this time. Wait a few seconds, then click Open “${name}” again.`,
    denied: 'There is no permission to read the book’s files, so it can’t be opened. Check the book folder’s permissions, or move the folder to a location you can access and open it again.',
  },
}

const truncate = bytes => bytes.subarray(0, Math.floor(bytes.length / 4096 / 2) * 4096)
const FILE_LOCKER = "$f=[IO.File]::Open($env:ERRL6_DB,'Open','ReadWrite','None');[Console]::Out.WriteLine('ready');[Console]::In.ReadLine()|Out-Null;$f.Dispose()"

/** 别的程序以不共享方式打开着库文件：worker 读快照时报 EBUSY。 */
async function lockFile(context, database) {
  const child = spawn('powershell', ['-NoProfile', '-Command', FILE_LOCKER],
    { env: { ...process.env, ERRL6_DB: database }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  context.onCleanup(() => { child.stdin.end('\n'); child.kill() })
  const ready = await new Promise(resolve => { child.stdout.once('data', data => resolve(String(data).trim())); child.once('exit', code => resolve(`exited ${code}`)) })
  assert.equal(ready, 'ready', '占住库文件的进程没起来')
}

/** 当前用户对库文件没有读写权限：worker 读快照时报 EPERM。 */
function denyAccess(context, database) {
  const user = execFileSync('whoami', { encoding: 'utf8' }).trim()
  execFileSync('icacls', [database, '/deny', `${user}:(R,W)`])
  context.onCleanup(() => execFileSync('icacls', [database, '/remove:d', user]))
}

const BREAK = {
  damaged: (context, database) => {
    for (const side of ['-wal', '-shm']) fs.rmSync(database + side, { force: true })
    fs.writeFileSync(database, truncate(fs.readFileSync(database)))
  },
  locked: lockFile,
  denied: denyAccess,
}

async function failedOpen(context, kind, lang) {
  const copy = COPY[lang]
  const database = path.join(context.samplePath, '.ai-novel', 'project.db')
  await context.restart({ beforeLaunch: () => BREAK[kind](context, database) })
  const { page } = context
  if (lang === 'en') {
    assert.equal((await context.invoke(page, 'config:set', { locale: 'en-US' })).success, true)
    await context.reload()
    await stage.openFromLibraryEn(page, name)
  } else {
    await stage.cover(page, name).waitFor({ state: 'visible', timeout: 60_000 })
    await stage.cover(page, name).click()
    await stage.overview(page, name).getByRole('button', { name: `打开《${name}》` }).click()
  }
  const dialog = page.getByRole('alertdialog', { name: copy.title })
  await dialog.waitFor({ state: 'visible', timeout: 20_000 })
  const shown = (await dialog.innerText()).trim()
  assert.ok(shown.includes(copy[kind]), `弹窗应说明真正的原因和办法，实际：${shown}`)
  assert.doesNotMatch(shown, RAW, '弹窗不应露出码或英文原文')
  assert.equal(await stage.spine(page).isVisible(), false, '打开失败时不应进入作品')
  if (kind !== 'damaged' || lang !== 'zh') return { shown }
  await context.shoot('errl6-damaged-dialog')
  await dialog.getByRole('button', { name: '确定' }).click()
  await stage.openSettings(page)
  await stage.showSettingsPage(page, '项目备份')
  const restore = page.getByRole('button', { name: '从本地存档恢复副本' })
  await restore.waitFor({ state: 'visible' })
  return { shown, restoreReachable: await restore.isEnabled() }
}

const setup = context => seedStageSample(context, { landOnChapter3: false })

export const ERRL6_SCENARIOS = Object.fromEntries(Object.keys(BREAK).flatMap(kind => ['zh', 'en'].map(lang => [
  `errl6-${kind}${lang === 'en' ? '-en' : ''}`,
  { model: true, shell: 'stage', ...(kind === 'damaged' ? {} : { requires: { platform: 'win32' } }), setup, run: context => failedOpen(context, kind, lang) },
])))
