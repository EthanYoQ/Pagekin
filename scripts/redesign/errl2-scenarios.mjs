import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import * as stage from './pages/stage.mjs'
import { BOOK, seedLargeBook } from './perf702-scenarios.mjs'

const ZH = { settings: '设置分组', page: '项目备份', appearance: '外观', language: '界面语言', export: '导出本地存档', restore: '从本地存档恢复副本' }
const EN = { settings: 'Settings sections', page: 'Project backup', appearance: 'Appearance', language: 'Interface language', export: 'Export local archive', restore: 'Restore a copy from local archive' }

const panel = page => stage.root(page).locator('[data-testid="project-backup-panel"]')

async function openBackup(page, labels) {
  await stage.root(page).getByRole('navigation', { name: labels.settings }).getByRole('button', { name: labels.page, exact: true }).click()
}

async function switchToEnglish(page) {
  await stage.root(page).getByRole('navigation', { name: ZH.settings }).getByRole('button', { name: ZH.appearance, exact: true }).click()
  await page.getByLabel(ZH.language).selectOption('en-US')
  await page.waitForFunction(() => document.documentElement.lang === 'en-US')
  await openBackup(page, EN)
}

async function notice(page, role) {
  const shown = panel(page).locator(`p[role="${role}"]`)
  await shown.first().waitFor({ state: 'visible', timeout: 60_000 })
  return (await shown.first().innerText()).trim()
}

async function exportTo({ app, page }, labels, filePath) {
  await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }) }, filePath)
  await stage.root(page).getByRole('button', { name: labels.export, exact: true }).click()
}

async function mainLogged(diagnostics, from, pattern) {
  const deadline = Date.now() + 10_000
  while (!pattern.test(diagnostics.slice(from).join('\n'))) {
    assert.ok(Date.now() < deadline, `主进程日志没有记下 ${pattern}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** 作者选好存档、还在选恢复位置时，存档被移走（拔了 U 盘、云盘同步删掉）。 */
async function restoreAfterArchiveMoved({ app, page, diagnostics }, labels, archive, parent) {
  const logged = diagnostics.length
  await app.evaluate(({ dialog }, [file, folder]) => {
    const fs = process.getBuiltinModule('node:fs')
    let calls = 0
    dialog.showOpenDialog = async () => {
      calls += 1
      if (calls === 1) return { canceled: false, filePaths: [file] }
      fs.renameSync(file, `${file}.moved`)
      return { canceled: false, filePaths: [folder] }
    }
  }, [archive, parent])
  await stage.root(page).getByRole('button', { name: labels.restore, exact: true }).click()
  const shown = await notice(page, 'alert')
  await mainLogged(diagnostics, logged, /restore failed[\s\S]*ENOENT: no such file or directory, lstat/u)
  fs.renameSync(`${archive}.moved`, archive)
  return shown
}

/** 同步盘、杀毒软件或权限让文件能看见、读不出内容。只拒「读数据」，属性照常可读。 */
function denyRead(file) {
  execFileSync('icacls', [file, '/deny', '*S-1-1-0:(RD)'], { stdio: 'ignore' })
  return () => execFileSync('icacls', [file, '/remove:d', '*S-1-1-0'], { stdio: 'ignore' })
}

export const ERRL2_SCENARIOS = {
  'errl2-source-unreadable': { model: true, shell: 'stage', setup: async context => { await seedLargeBook(context, 1) }, run: async context => {
    assert.equal(process.platform, 'win32', '这个场景用 icacls 拒读，只在 Windows 上跑')
    const { page, roots, shoot, diagnostics } = context
    await stage.openAfterRestart(page, BOOK)
    await stage.openSettings(page)
    await openBackup(page, ZH)
    const archive = path.join(roots.projects, '好的备份.ainovel')
    await exportTo(context, ZH, archive)
    assert.match(await notice(page, 'status'), /^本地存档已导出：/u)

    const manifest = path.join(roots.projects, BOOK, '.ai-novel', 'project.json')
    const logged = diagnostics.length
    let allow = denyRead(manifest)
    const blocked = path.join(roots.projects, '读不了作品.ainovel')
    try {
      await exportTo(context, ZH, blocked)
      const zh = await notice(page, 'alert')
      assert.equal(zh, '作品没有改动。作品文件读不了，可能正被同步盘或杀毒软件占用。请稍后再点「导出本地存档」。')
      await mainLogged(diagnostics, logged, /export failed[\s\S]*EPERM/u)
      await shoot('errl2-5-export-source-unreadable-zh')
    } finally { allow() }
    assert.equal(fs.existsSync(blocked), false, '没有写出存档')

    const target = path.join(roots.temp, '恢复到这里')
    fs.mkdirSync(target)
    allow = denyRead(archive)
    try {
      await context.app.evaluate(({ dialog }, [file, folder]) => {
        let calls = 0
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [++calls === 1 ? file : folder] })
      }, [archive, target])
      await stage.root(page).getByRole('button', { name: ZH.restore, exact: true }).click()
      const restore = await notice(page, 'alert')
      assert.equal(restore, '没有新建副本。所选存档读不了，可能没有权限或正被占用。请换一个存档，再点「从本地存档恢复副本」。')
      await shoot('errl2-6-restore-archive-unreadable-zh')
    } finally { allow() }
    assert.deepEqual(fs.readdirSync(target), [], '恢复位置没有建出副本')

    await switchToEnglish(page)
    allow = denyRead(manifest)
    try {
      await exportTo(context, EN, blocked)
      const en = await notice(page, 'alert')
      assert.equal(en, 'Your book is unchanged. Some book files cannot be read; a sync or antivirus app may be using them. Wait a moment, then click Export local archive again.')
      await shoot('errl2-7-export-source-unreadable-en')
    } finally { allow() }
    assert.equal(fs.existsSync(blocked), false, '没有写出存档')
    return { blocked: path.basename(blocked) }
  } },
  'errl2-export-inside-source': { model: true, shell: 'stage', setup: async context => { await seedLargeBook(context, 1) }, run: async context => {
    const { page, roots, shoot } = context
    await stage.openAfterRestart(page, BOOK)
    await stage.openSettings(page)
    await openBackup(page, ZH)
    const inside = path.join(roots.projects, BOOK, '备份.ainovel')
    await exportTo(context, ZH, inside)
    const zh = await notice(page, 'alert')
    assert.equal(zh, '作品没有改动。存档不能放进作品自己的文件夹，没有生成。请再点「导出本地存档」，换到作品文件夹以外的位置。')
    await shoot('errl2-1-export-inside-zh')

    await switchToEnglish(page)
    await exportTo(context, EN, inside)
    const en = await notice(page, 'alert')
    assert.equal(en, "Your book is unchanged. An archive cannot go inside the book's own folder, so none was created. Click Export local archive again and choose a location outside the book folder.")
    await shoot('errl2-2-export-inside-en')
    assert.equal(fs.existsSync(inside), false, '作品文件夹里没有写出存档')
    return { zh, en }
  } },
  'errl2-restore-archive-moved': { model: true, shell: 'stage', setup: async context => { await seedLargeBook(context, 1) }, run: async context => {
    const { page, roots, shoot } = context
    const target = path.join(roots.temp, '恢复到这里')
    fs.mkdirSync(target)
    await stage.openAfterRestart(page, BOOK)
    await stage.openSettings(page)
    await openBackup(page, ZH)
    const archive = path.join(roots.projects, '好的备份.ainovel')
    await exportTo(context, ZH, archive)
    assert.match(await notice(page, 'status'), /^本地存档已导出：/u)

    const zh = await restoreAfterArchiveMoved(context, ZH, archive, target)
    assert.equal(zh, '没有新建副本。找不到所选存档。请再点「从本地存档恢复副本」重新选一次。')
    await shoot('errl2-3-restore-moved-zh')

    await switchToEnglish(page)
    const en = await restoreAfterArchiveMoved(context, EN, archive, target)
    assert.equal(en, 'No copy was created. The chosen archive could not be found. Click Restore a copy from local archive and choose it again.')
    await shoot('errl2-4-restore-moved-en')
    assert.deepEqual(fs.readdirSync(target), [], '恢复位置没有建出副本')
    return { zh, en }
  } },
}
