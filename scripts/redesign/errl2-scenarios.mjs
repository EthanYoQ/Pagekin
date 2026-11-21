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

/** 同步盘、杀毒软件或权限让文件能看见、读不出内容。默认只拒「读数据」；`(R)` 连属性也拒，解析真实路径就会失败。 */
function denyRead(file, rights = '(RD)') {
  execFileSync('icacls', [file, '/deny', `*S-1-1-0:${rights}`], { stdio: 'ignore' })
  return () => execFileSync('icacls', [file, '/remove:d', '*S-1-1-0'], { stdio: 'ignore' })
}

/** 副本文件夹已经建好、往里放某个文件时出错（磁盘满、杀毒软件拦）：在主进程里让这一次 link 抛系统报错。 */
async function restoreFailingAt({ app, page }, labels, archive, parent, failing) {
  await app.evaluate(({ dialog }, [file, folder, [name, code]]) => {
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    const link = fs.linkSync
    globalThis.__errl2RestoreLink = link
    fs.linkSync = (from, to) => {
      if (path.basename(String(to)) === name && String(to).startsWith(folder)) {
        throw Object.assign(new Error(`${code}: link '${to}'`), { code, syscall: 'link', path: String(to) })
      }
      return link(from, to)
    }
    let calls = 0
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [++calls === 1 ? file : folder] })
  }, [archive, parent, failing])
  try {
    await stage.root(page).getByRole('button', { name: labels.restore, exact: true }).click()
    return await notice(page, 'alert')
  } finally {
    await app.evaluate(() => { process.getBuiltinModule('node:fs').linkSync = globalThis.__errl2RestoreLink })
  }
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

    allow = denyRead(manifest, '(R)')
    try {
      await exportTo(context, ZH, blocked)
      assert.equal(await notice(page, 'alert'), '作品没有改动。作品文件读不了，可能正被同步盘或杀毒软件占用。请稍后再点「导出本地存档」。')
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
  'errl2-restore-mid-install': { model: true, shell: 'stage', setup: async context => { await seedLargeBook(context, 1) }, run: async context => {
    const { page, roots, shoot } = context
    const parent = path.join(roots.temp, '恢复到这里')
    fs.mkdirSync(parent)
    await stage.openAfterRestart(page, BOOK)
    await stage.openSettings(page)
    await openBackup(page, ZH)
    const archive = path.join(roots.projects, '好的备份.ainovel')
    await exportTo(context, ZH, archive)
    assert.match(await notice(page, 'status'), /^本地存档已导出：/u)
    const leftovers = () => fs.readdirSync(parent).filter(name => !name.startsWith('.')).length

    const unwritable = await restoreFailingAt(context, ZH, archive, parent, ['project.json', 'ENOSPC'])
    assert.equal(unwritable, '所选文件夹写不进去，可能没有权限或磁盘满了，里面可能留下没恢复完的副本文件夹，可以删掉。请换一个文件夹，再点「从本地存档恢复副本」。')
    assert.equal(leftovers(), 1, '装到一半的副本文件夹留在所选位置')
    await shoot('errl2-8-restore-mid-install-unwritable-zh')

    const unsafe = await restoreFailingAt(context, ZH, archive, parent, ['.portable-restore-reservation.json', 'EPERM'])
    assert.equal(unsafe, '所选文件夹没法安全写入，里面可能留下没恢复完的副本文件夹，可以删掉。请换一个文件夹，再点「从本地存档恢复副本」。')
    assert.equal(leftovers(), 2, '建好的副本文件夹留在所选位置')
    await shoot('errl2-9-restore-mid-install-unsafe-zh')

    const unexpected = await restoreFailingAt(context, ZH, archive, parent, ['project.db', 'EBUSY'])
    assert.equal(unexpected, '恢复时出了意外错误，所选文件夹里可能留下没恢复完的副本文件夹，可以删掉。请再点「从本地存档恢复副本」；还不行，请把这条提示反馈给我们。')
    assert.equal(leftovers(), 3, '装到一半的副本文件夹留在所选位置')
    await shoot('errl2-10-restore-mid-install-failed-zh')

    await switchToEnglish(page)
    const en = await restoreFailingAt(context, EN, archive, parent, ['project.json', 'ENOSPC'])
    assert.equal(en, 'The chosen folder cannot be written to; you may lack permission or the disk may be full. An unfinished copy folder may be left in it; you can delete it. Choose another folder, then click Restore a copy from local archive again.')
    await shoot('errl2-11-restore-mid-install-unwritable-en')
    return { leftovers: leftovers() }
  } },
}
