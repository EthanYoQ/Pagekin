import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import * as blueprint from './pages/blueprint.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

// 别的进程在 project.db-shm 上只留一个映射段（不留文件句柄），和强杀书童后旧进程收尾时的状态一样。
const SECTION_HOLDER = "$fs=[IO.FileStream]::new($env:ODIO_SHM,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]'ReadWrite,Delete');$m=[IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($fs,[NullString]::Value,0,[IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read,[IO.HandleInheritability]::None,$true);$v=$m.CreateViewAccessor(0,0,[IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read);$fs.Dispose();[Console]::Out.WriteLine('ready');[Console]::In.ReadLine()|Out-Null;$v.Dispose();$m.Dispose()"
const FAILED = /打开作品失败|Couldn’t open the book/u
const name = STAGE_SAMPLE.name

function contentHashes(dataRoot) {
  return Object.fromEntries(['project.db', 'project.db-wal', 'project.db-shm'].map(file => {
    const target = path.join(dataRoot, file)
    return [file, fs.existsSync(target) ? createHash('sha256').update(fs.readFileSync(target)).digest('hex').slice(0, 12) + ':' + fs.statSync(target).size : null]
  }))
}

async function startWriting(context) {
  const { fake } = context
  fake.streamProse({ chunks: Array.from({ length: 4 }, (_, index) => `雾钟第${index + 1}次提前响起，林岚记下潮位。`), intervalMs: 1500 })
  await blueprint.open(context.page)
  await blueprint.writeNext(context.page)
  for (const deadline = Date.now() + 60_000; fake.streamLog.length < 4; await context.page.waitForTimeout(100))
    assert.ok(Date.now() < deadline, '60 秒内正文没有流完')
  fake.gate.hold()
  for (const deadline = Date.now() + 30_000; fake.gate.waiting === 0; await context.page.waitForTimeout(100))
    assert.ok(Date.now() < deadline, '正文流完后 30 秒内没有发出下一次请求')
}

async function clickOpen(page, english) {
  if (english) return stage.openFromLibraryEn(page, name)
  await stage.cover(page, name).click()
  await stage.overview(page, name).getByRole('button', { name: `打开《${name}》` }).click()
}

async function openOutcome(page) {
  const failed = page.getByRole('alertdialog').filter({ hasText: FAILED })
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await page.waitForTimeout(200)) {
    if (await failed.isVisible()) return { opened: false, shown: (await failed.innerText()).trim() }
    if (await stage.spine(page).isVisible()) return { opened: true }
  }
  return { opened: false, shown: null }
}

/** releaseAfterClickMs 为空时映射段一直不放。 */
async function heldShmOpen(context, { releaseAfterClickMs = null, locale = null } = {}) {
  await startWriting(context)
  const dataRoot = path.join(context.samplePath, '.ai-novel')
  let holder, afterKill
  try {
    await context.restart({ killed: true, beforeLaunch: async () => {
      afterKill = contentHashes(dataRoot)
      holder = spawn('powershell', ['-NoProfile', '-Command', SECTION_HOLDER], { env: { ...process.env, ODIO_SHM: path.join(dataRoot, 'project.db-shm') }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
      const ready = await new Promise(resolve => { holder.stdout.once('data', data => resolve(String(data).trim())); holder.once('exit', code => resolve(`exited ${code}`)) })
      assert.equal(ready, 'ready', '映射段持有者没有起来')
    } })
    context.fake.gate.release()
    context.fake.streamProse({ chunks: ['雾钟又响了一次。'], intervalMs: 10 })
    const { page } = context
    if (locale) {
      assert.equal((await context.invoke(page, 'config:set', { locale })).success, true)
      await context.reload()
      await page.getByRole('list', { name: 'Recent books' }).waitFor({ state: 'visible' })
    } else await stage.cover(page, name).waitFor({ state: 'visible', timeout: 60_000 })
    const release = () => holder.stdin.end('\n')
    await clickOpen(page, Boolean(locale))
    if (releaseAfterClickMs !== null) setTimeout(release, releaseAfterClickMs)
    const held = await openOutcome(page)
    const afterHeldOpen = contentHashes(dataRoot)
    if (releaseAfterClickMs !== null) {
      assert.deepEqual(held, { opened: true }, '映射段放开后应等到并打开作品')
      return { held }
    }
    await context.shoot(`odio-held-shm-failed${locale ? `-${locale}` : ''}`)
    assert.equal(held.opened, false, '映射段一直不放时不应打开')
    assert.doesNotMatch(held.shown ?? '', /SqliteError|disk I\/O/u, '界面不应露出英文原文')
    assert.match(held.shown ?? '', locale ? new RegExp(`Open “${name}”`, 'u') : new RegExp(`已保存的内容没有受影响.*打开《${name}》`, 'su'))
    assert.deepEqual(afterHeldOpen, afterKill, '打开失败不应改动作品文件')
    release()
    if (holder.exitCode === null) await new Promise(resolve => holder.once('exit', resolve))
    if (locale) return { held, afterKill, afterHeldOpen }
    await page.getByRole('button', { name: '确定' }).click()
    await clickOpen(page, false)
    const released = await openOutcome(page)
    assert.deepEqual(released, { opened: true }, '映射段放开后再点打开应能打开')
    return { held, afterKill, afterHeldOpen, released }
  } finally { holder?.kill() }
}

const setup = context => seedStageSample(context, { landOnChapter3: false })
const requires = { platform: 'win32' }

export const ODIO_SCENARIOS = {
  'odio-held-shm': { model: true, shell: 'stage', requires, setup, run: context => heldShmOpen(context) },
  'odio-held-shm-ja': { model: true, shell: 'stage', requires, setup, run: context => heldShmOpen(context, { locale: 'ja-JP' }) },
  'odio-held-shm-brief': { model: true, shell: 'stage', requires, setup, run: context => heldShmOpen(context, { releaseAfterClickMs: 1000 }) },
}
