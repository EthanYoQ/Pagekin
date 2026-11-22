import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const GBK_CHAPTER = Buffer.from('b5da31d5c220d3eed2b90a', 'hex')
const UTF8_CHAPTER = Buffer.from('第1章 雨夜\n林岚推开旧港的门。\n', 'utf8')

function writeFixture(roots, name, content) {
  const file = path.join(roots.temp, name)
  fs.writeFileSync(file, content)
  return file
}

function oversized(roots) {
  const file = path.join(roots.temp, 'oversized-65mb.txt')
  const line = Buffer.from('林岚沿着旧港的石阶往下走，对照父亲留下的潮汐表。\n', 'utf8')
  const target = 65 * 1024 * 1024
  const fd = fs.openSync(file, 'w')
  try {
    fs.writeSync(fd, UTF8_CHAPTER)
    const block = Buffer.concat(Array.from({ length: Math.ceil(1024 * 1024 / line.length) }, () => line))
    for (let written = UTF8_CHAPTER.length; written < target; written += block.length) fs.writeSync(fd, block)
  } finally {
    fs.closeSync(fd)
  }
  return file
}

function denyRead(file) {
  execFileSync('icacls', [file, '/deny', `${process.env.USERNAME}:(RD)`], { stdio: 'ignore' })
  return () => execFileSync('icacls', [file, '/remove:d', process.env.USERNAME], { stdio: 'ignore' })
}

async function holdExclusively(file) {
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command',
    `$h=[IO.File]::Open('${file.replaceAll("'", "''")}','Open','Read','None'); [Console]::Out.WriteLine('held'); [Console]::In.ReadLine() | Out-Null; $h.Close()`],
  { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  await new Promise((resolve, reject) => {
    holder.once('error', reject)
    holder.stdout.on('data', chunk => { if (String(chunk).includes('held')) resolve() })
  })
  return () => execFileSync('taskkill', ['/T', '/F', '/PID', String(holder.pid)], { stdio: 'ignore' })
}

async function chooseReference(context, file, shotName) {
  const { app, page, shoot } = context
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, file)
  await stage.openWorkMenuItem(page, STAGE_SAMPLE.name, '小说拆解与仿写…')
  const dialog = page.getByRole('dialog', { name: '小说拆解与仿写' })
  await dialog.getByTestId('import-target-current').click()
  await dialog.getByRole('button', { name: '选择', exact: true }).click()
  const failure = dialog.locator('div', { has: page.locator('svg.lucide-triangle-alert, svg.lucide-alert-triangle') }).last()
  await failure.waitFor({ state: 'visible', timeout: 60_000 })
  const shown = (await failure.innerText()).trim()
  await page.waitForTimeout(400)
  await shoot(shotName)
  return shown
}

function expectShown(shown, expected) {
  assert.equal(shown, expected, `导入对话框显示的失败原因：${shown}`)
  return { shown }
}

export const E763_SCENARIOS = {
  'e763-gbk': { model: false, shell: 'stage', setup: seedStageSample, run: async context => expectShown(
    await chooseReference(context, writeFixture(context.roots, 'gbk-novel.txt', GBK_CHAPTER), 'e763-gbk'),
    '这个文件不是 UTF-8 编码的文本。请用文本编辑器另存为 UTF-8 后重新导入。',
  ) },
  'e763-too-large': { model: false, shell: 'stage', setup: seedStageSample, run: async context => expectShown(
    await chooseReference(context, oversized(context.roots), 'e763-too-large'),
    '这个文件超过 64 MB，读不进来。请拆成几个小文件后重新导入。',
  ) },
  'e763-denied': { model: false, shell: 'stage', setup: seedStageSample, run: async context => {
    const file = writeFixture(context.roots, 'denied-novel.txt', UTF8_CHAPTER)
    const restore = denyRead(file)
    try {
      return expectShown(
        await chooseReference(context, file, 'e763-denied'),
        '系统不让打开这个文件。请把它复制到桌面等普通文件夹，再重新导入。',
      )
    } finally {
      restore()
    }
  } },
  'e763-in-use': { model: false, shell: 'stage', setup: seedStageSample, run: async context => {
    const file = writeFixture(context.roots, 'held-novel.txt', UTF8_CHAPTER)
    const release = await holdExclusively(file)
    try {
      return expectShown(
        await chooseReference(context, file, 'e763-in-use'),
        '这个文件正被别的程序占用。请关掉打开它的程序，再重新导入。',
      )
    } finally {
      release()
    }
  } },
}
