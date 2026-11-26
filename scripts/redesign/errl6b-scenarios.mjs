import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const name = STAGE_SAMPLE.name
const RAW = /SqliteError|EBUSY|EPERM|EACCES|ENOENT|SQLITE_|PROJECT_|resource busy|not permitted|no such file|发生错误|回滚|rollback|主进程|数据库|\.ai-novel|[A-Z]:\\/u

const COPY = {
  zh: {
    createTitle: '新建作品失败', deleteTitle: '删除作品失败', openTitle: '打开作品失败',
    createDenied: '没有权限在所选位置新建作品。请换一个保存位置。',
    deleteBusy: '作品文件夹没删完，有文件正被别的程序占用，请先关掉那个程序。',
    deleteUnknown: '作品文件夹没删完。',
    deleteDenied: '作品文件夹没删完，没有删除其中文件的权限，请先检查文件夹的权限。',
    closed: `《${name}》已关闭，之后可以直接删掉这个文件夹，再点「从最近项目移除…」。`,
    stillOpen: '作品还开着，之后可以再删除一次。',
    empty: '作品文件里没有内容，打不开。导出过存档的，可以在设置的「项目备份」里点「从本地存档恢复副本」。',
  },
  en: {
    createTitle: 'Couldn’t create the book', deleteTitle: 'Couldn’t delete the book', openTitle: 'Couldn’t open the book',
    createDenied: 'There is no permission to create a book in the chosen location. Choose another location.',
    deleteBusy: 'The book folder was not fully deleted because another program is using a file in it. Close that program first.',
    deleteUnknown: 'The book folder was not fully deleted.',
    deleteDenied: 'The book folder was not fully deleted because there is no permission to delete files in it. Check the folder’s permissions first.',
    closed: `“${name}” has been closed. Afterward, delete the folder yourself, then use Remove from recent… on the shelf.`,
    stillOpen: 'The book is still open, so you can delete it again afterward.',
    empty: 'The book’s files have no content, so it can’t be opened. If you exported an archive, go to Settings > Project backup and click Restore a copy from local archive.',
  },
}

const LOCKER = "$f=[IO.File]::Open($env:ERRL6B_FILE,'OpenOrCreate','ReadWrite',$env:ERRL6B_SHARE);[Console]::Out.WriteLine('ready');[Console]::In.ReadLine()|Out-Null;$f.Dispose()"

async function holdFile(context, file) {
  const child = spawn('powershell', ['-NoProfile', '-Command', LOCKER],
    { env: { ...process.env, ERRL6B_FILE: file, ERRL6B_SHARE: 'None' }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  context.onCleanup(() => { child.stdin.end('\n'); child.kill() })
  const ready = await new Promise(resolve => { child.stdout.once('data', data => resolve(String(data).trim())); child.once('exit', code => resolve(`exited ${code}`)) })
  assert.equal(ready, 'ready', '占住文件的进程没起来')
}

function denyForCurrentUser(context, target, rights) {
  const whoami = path.join(process.env.SystemRoot || process.env.windir, 'System32', 'whoami.exe')
  const sid = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/"(S-1-[\d-]+)"\s*$/)?.[1]
  assert.ok(sid, '取不到当前用户的 SID')
  execFileSync('icacls', [target, '/deny', `*${sid}:${rights}`])
  context.onCleanup(() => { if (fs.existsSync(target)) execFileSync('icacls', [target, '/remove:d', `*${sid}`, '/T', '/C']) })
}

function listed(root) {
  try {
    return fs.readdirSync(root, { recursive: true }).map(String).sort()
  } catch (error) {
    return [String(error.code)]
  }
}

async function useEnglish(context) {
  assert.equal((await context.invoke(context.page, 'config:set', { locale: 'en-US' })).success, true)
  await context.reload()
}

async function alertText(page, title, timeout = 20_000) {
  const dialog = page.getByRole('alertdialog', { name: title })
  await dialog.waitFor({ state: 'visible', timeout })
  return { dialog, shown: (await dialog.innerText()).trim() }
}

async function createDenied(context, lang) {
  const copy = COPY[lang]
  const { app, page, roots } = context
  const parent = path.join(roots.root, 'ro')
  fs.mkdirSync(parent, { recursive: true })
  denyForCurrentUser(context, parent, '(AD,WD)')
  if (lang === 'en') await useEnglish(context)
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, parent)
  const start = lang === 'en' ? 'New book' : '新建作品'
  await stage.root(page).getByRole('button', { name: start }).first().click()
  const form = page.getByRole('dialog', { name: start })
  await form.getByRole('textbox').first().fill('雨巷')
  await form.getByRole('button', { name: lang === 'en' ? 'Choose' : '选择', exact: true }).click()
  await form.getByRole('button', { name: lang === 'en' ? 'Create book' : '创建作品' }).click()
  const { shown } = await alertText(page, copy.createTitle)
  assert.ok(shown.includes(copy.createDenied), `弹窗应说明没有权限并给出办法，实际：${shown}`)
  assert.doesNotMatch(shown, RAW, '弹窗不应露出码或英文原文')
  await context.shoot(`errl6b-create-denied-${lang}`)
  return { shown, left: listed(parent) }
}

async function deleteLeftover(context, kind, lang) {
  const copy = COPY[lang]
  const { page, samplePath } = context
  if (lang === 'en') {
    await useEnglish(context)
    await stage.openFromLibraryEn(page, name)
  } else await stage.openAfterRestart(page, name)
  if (kind === 'busy') await holdFile(context, path.join(samplePath, '人物小传.docx'))
  else if (kind === 'denied') denyForCurrentUser(context, path.join(samplePath, '资料'), '(OI)(CI)(D,DC)')
  else {
    await context.app.evaluate(() => {
      const fsp = process.getBuiltinModule('node:fs/promises')
      globalThis.errl6bRealRm = fsp.rm
      fsp.rm = async () => { throw Object.assign(new Error('EIO: i/o error, rmdir'), { code: 'EIO' }) }
    })
    context.onCleanup(() => context.app.evaluate(() => { process.getBuiltinModule('node:fs/promises').rm = globalThis.errl6bRealRm }))
  }
  if (lang === 'en') {
    await stage.root(page).getByRole('banner').getByRole('button', { name: `“${name}” menu` }).click()
    await page.getByRole('menuitem', { name: 'Back to library' }).click()
    await page.getByRole('list', { name: 'Recent books' }).getByRole('button', { name: `More for “${name}”` }).click()
    await page.getByRole('menuitem', { name: 'Delete book…' }).click()
  } else {
    await stage.backToLibrary(page, name)
    await stage.bookMenu(page, name, '删除作品…')
  }
  const confirm = page.getByRole('dialog', { name: lang === 'en' ? `Delete “${name}”?` : `删除《${name}》？` })
  await confirm.getByRole('textbox').fill(name)
  const started = Date.now()
  await confirm.getByRole('button', { name: lang === 'en' ? 'Delete book' : '删除作品', exact: true }).click()
  const { shown } = await alertText(page, copy.deleteTitle, 180_000)
  const waitedSeconds = (Date.now() - started) / 1000
  assert.ok(waitedSeconds < 10, `点删除后 ${waitedSeconds} 秒才告诉作者没删完，应在几秒内`)
  const left = listed(samplePath)
  const reopened = fs.existsSync(path.join(samplePath, '.ai-novel', 'project.db'))
  const reason = { busy: copy.deleteBusy, denied: copy.deleteDenied, unknown: copy.deleteUnknown }[kind]
  const expected = `${reason}${lang === 'en' ? ' ' : ''}${reopened ? copy.stillOpen : copy.closed}`
  assert.ok(shown.includes(expected), `弹窗应说明原因、作品现在的状态和办法，期望：${expected}；实际：${shown}；文件夹里还剩：${left.join(', ')}`)
  assert.doesNotMatch(shown, RAW, '弹窗不应露出码或英文原文')
  await context.shoot(`errl6b-delete-${kind}-${lang}`)
  return { shown, left, reopened, waitedSeconds }
}

async function deleteBookWithKnowledgeBase(context) {
  const { page, samplePath } = context
  await stage.openAfterRestart(page, name)
  assert.ok(fs.existsSync(path.join(samplePath, '.ai-novel', 'lancedb')), '删除前作品里应有知识库文件')
  await stage.backToLibrary(page, name)
  await stage.bookMenu(page, name, '删除作品…')
  const confirm = page.getByRole('dialog', { name: `删除《${name}》？` })
  await confirm.getByRole('textbox').fill(name)
  const started = Date.now()
  await confirm.getByRole('button', { name: '删除作品', exact: true }).click()
  await page.getByText(`项目「${name}」已删除`).waitFor({ state: 'visible' })
  const waitedSeconds = (Date.now() - started) / 1000
  assert.equal(fs.existsSync(samplePath), false, '作品文件夹应已删掉')
  await context.shoot('errl6b-delete-ok-zh')
  return { waitedSeconds }
}

async function emptyDatabase(context, kind, lang) {
  const copy = COPY[lang]
  const database = path.join(context.samplePath, '.ai-novel', 'project.db')
  await context.restart({ beforeLaunch: () => {
    for (const side of ['-wal', '-shm']) fs.rmSync(database + side, { force: true })
    if (kind === 'zero') fs.writeFileSync(database, '')
    else fs.rmSync(database)
  } })
  const { page } = context
  if (lang === 'en') {
    await useEnglish(context)
    await stage.openFromLibraryEn(page, name)
  } else {
    await stage.cover(page, name).waitFor({ state: 'visible', timeout: 60_000 })
    await stage.cover(page, name).click()
    await stage.overview(page, name).getByRole('button', { name: `打开《${name}》` }).click()
  }
  const { shown } = await alertText(page, copy.openTitle)
  assert.ok(shown.includes(copy.empty), `弹窗应说明作品文件里没有内容，实际：${shown}`)
  assert.doesNotMatch(shown, RAW, '弹窗不应露出码或英文原文')
  await context.shoot(`errl6b-empty-${kind}-${lang}`)
  return { shown }
}

const sample = context => seedStageSample(context, { landOnChapter3: false })
const win32 = { requires: { platform: 'win32' } }
const sampleWithDocument = async context => {
  await sample(context)
  fs.writeFileSync(path.join(context.samplePath, '人物小传.docx'), '林岚的人物小传')
}
const sampleWithNotes = async context => {
  await sample(context)
  fs.mkdirSync(path.join(context.samplePath, '资料'))
  fs.writeFileSync(path.join(context.samplePath, '资料', '灯塔考据.txt'), '灯塔建于光绪年间')
}

const sampleWithKnowledgeBase = context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path: projectPath, session }) => {
  const imported = await invoke(page, 'kb:import-planning-text', '灯塔建于旧港北岸，守塔人每晚记录潮汐。', '灯塔资料.txt', projectPath, session)
  assert.equal(imported.success, true, imported.error)
} })

export const ERRL6B_SCENARIOS = {
  'errl6b-delete-ok-zh': { model: false, shell: 'stage', setup: sampleWithKnowledgeBase, run: deleteBookWithKnowledgeBase },
  ...Object.fromEntries(['zh', 'en'].flatMap(lang => [
  [`errl6b-create-denied-${lang}`, { model: false, shell: 'stage', ...win32, run: context => createDenied(context, lang) }],
  [`errl6b-delete-busy-${lang}`, { model: true, shell: 'stage', ...win32, setup: sampleWithDocument, run: context => deleteLeftover(context, 'busy', lang) }],
  [`errl6b-delete-denied-${lang}`, { model: true, shell: 'stage', ...win32, setup: sampleWithNotes, run: context => deleteLeftover(context, 'denied', lang) }],
  [`errl6b-delete-unknown-${lang}`, { model: true, shell: 'stage', setup: sample, run: context => deleteLeftover(context, 'unknown', lang) }],
  [`errl6b-empty-zero-${lang}`, { model: true, shell: 'stage', setup: sample, run: context => emptyDatabase(context, 'zero', lang) }],
  [`errl6b-empty-missing-${lang}`, { model: true, shell: 'stage', setup: sample, run: context => emptyDatabase(context, 'missing', lang) }],
  ])),
}
