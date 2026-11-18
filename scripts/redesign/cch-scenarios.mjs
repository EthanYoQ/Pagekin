import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { openChapter } from './f491-scenarios.mjs'
import { BOOK, buildByReviewCycle } from './perf702-scenarios.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')

/** 与 test/helpers/review-cycle-fixture.ts 的 breakReviewProof 保持一致。 */
function breakReviewProof(projectRoot, chapter) {
  const database = new Database(path.join(projectRoot, '.ai-novel', 'project.db'), { fileMustExist: true })
  try {
    const cycle = database.prepare(`SELECT c.root_action_id AS rootActionId, c.review_id AS reviewId FROM review_cycles c
      JOIN reviews r ON r.id=c.review_id JOIN drafts_all d ON d.id=r.base_draft_id WHERE d.chapter_number=?`).get(chapter)
    assert.ok(cycle, `第 ${chapter} 章有一条审修循环`)
    const changed = database.prepare(`UPDATE generation_attempts
      SET usage_receipt_json=json_set(usage_receipt_json,'$.reviewRevisionEffect.contentHash',?)
      WHERE root_action_id=? AND json_extract(usage_receipt_json,'$.reviewRevisionEffect.kind')='review'
        AND json_extract(usage_receipt_json,'$.reviewRevisionEffect.id')=?`).run('0'.repeat(64), cycle.rootActionId, cycle.reviewId).changes
    assert.equal(changed, 1, `第 ${chapter} 章应改坏一条审稿证据，实际改了 ${changed} 条`)
  } finally { database.close() }
}

const exportAlert = page => stage.root(page).locator('[data-testid="project-backup-panel"] p[role="alert"]')

async function exportOnce(context, archive, { settings, page: pageName, button }) {
  const { app, page } = context
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, archive)
  await stage.root(page).getByRole('navigation', { name: settings }).getByRole('button', { name: pageName, exact: true }).click()
  await stage.root(page).getByRole('button', { name: button, exact: true }).click()
  await exportAlert(page).waitFor({ state: 'visible', timeout: 60_000 })
  const shown = (await exportAlert(page).innerText()).trim()
  assert.equal(fs.existsSync(archive), false, '导出失败时没有写出存档')
  return shown
}

async function switchLocale(page, from, to) {
  await stage.root(page).getByRole('navigation', { name: from.settings }).getByRole('button', { name: from.appearance, exact: true }).click()
  await page.getByLabel(from.languageLabel).selectOption(to)
  await page.waitForFunction(lang => document.documentElement.lang === lang, to)
}

export const CCH_SCENARIOS = {
  'cch-export-damaged': { model: true, shell: 'stage', setup: async context => {
    await buildByReviewCycle(context, 2, { saveCheckpoints: false })
    await context.restart({ beforeLaunch: () => breakReviewProof(path.join(context.roots.projects, BOOK), 2) })
  }, run: async context => {
    const { page, roots, shoot } = context
    await stage.openFromLibrary(page, BOOK)
    await stage.openSettings(page)
    const zh = await exportOnce(context, path.join(roots.projects, 'cch-zh.ainovel'),
      { settings: '设置分组', page: '项目备份', button: '导出本地存档' })
    await shoot('cch-1-zh')
    assert.equal(zh, '作品没有改动。第 2 章「远航之2」有条审稿记录损坏，存档没生成。'
      + '先「复制本章正文」，再「删除正文…」并在回收站「彻底删除…」，然后重试。')

    await switchLocale(page, { settings: '设置分组', appearance: '外观', languageLabel: '界面语言' }, 'ja-JP')
    const ja = await exportOnce(context, path.join(roots.projects, 'cch-ja.ainovel'),
      { settings: 'Settings sections', page: 'Project backup', button: 'Export local archive' })
    await shoot('cch-2-ja')
    assert.equal(ja, '作品は変更されていません。第2章「远航之2」のレビュー記録が破損し、アーカイブを作成できませんでした。'
      + '「Copy chapter text」の後、「Delete manuscript…」とゴミ箱の「Delete permanently…」で削除し、再試行してください。')

    await switchLocale(page, { settings: 'Settings sections', appearance: 'Appearance', languageLabel: 'Interface language' }, 'en-US')
    const en = await exportOnce(context, path.join(roots.projects, 'cch-en.ainovel'),
      { settings: 'Settings sections', page: 'Project backup', button: 'Export local archive' })
    assert.equal(en, 'Your book is unchanged. A review record in Chapter 2 "远航之2" is damaged, so no archive was made. '
      + 'Use "Copy chapter text", then "Delete manuscript…" and "Delete permanently…" in the trash, and retry.')
    return { zh, ja, en }
  } },
  'cch-remedy-ui': { model: true, shell: 'stage', setup: async context => {
    await buildByReviewCycle(context, 2, { saveCheckpoints: false })
    await context.restart({ beforeLaunch: () => breakReviewProof(path.join(context.roots.projects, BOOK), 1) })
  }, run: async context => {
    const { page, roots, shoot } = context
    await stage.openFromLibrary(page, BOOK)
    await stage.openSettings(page)
    const before = await exportOnce(context, path.join(roots.projects, 'cch-before.ainovel'),
      { settings: '设置分组', page: '项目备份', button: '导出本地存档' })
    assert.match(before, /^作品没有改动。第 1 章「远航之1」有条审稿记录损坏/u)
    await stage.closeSettings(page)

    await openChapter(page, 1)
    await page.evaluate(() => {
      window.__copied = []
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied.push(text) } } })
    })
    await chapterView.more(page, '复制本章正文')
    await page.getByText('已复制本章正文').first().waitFor({ state: 'visible' })
    const firstLine = (await chapterView.prose(page).locator('.cm-line').first().innerText()).trim()
    const copied = await page.evaluate(() => window.__copied)
    assert.equal(copied.length, 1, '复制本章正文交给了剪贴板')
    assert.ok(firstLine && copied[0].includes(firstLine), `剪贴板里是第 1 章正文（首行「${firstLine}」）`)
    await chapterView.more(page, '删除正文…')
    const confirm = page.getByRole('dialog', { name: '删除正文' })
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    await confirm.waitFor({ state: 'hidden' })
    await page.getByText(/^已把「.+」移到回收站/u).first().waitFor({ state: 'visible', timeout: 30_000 })
    await stage.openSettings(page)
    const inTrash = await exportOnce(context, path.join(roots.projects, 'cch-trash.ainovel'),
      { settings: '设置分组', page: '项目备份', button: '导出本地存档' })
    await shoot('cch-4-trash')
    assert.match(inTrash, /^作品没有改动。回收站里第 1 章「远航之1」（删除于 .+）有条审稿记录损坏，存档没生成。到回收站把它「彻底删除…」，然后重试。$/u)
    await stage.closeSettings(page)
    await stage.root(page).getByRole('button', { name: /^回收站（1）$/u }).click()
    const trash = page.getByRole('dialog', { name: /^回收站（1）$/u })
    await trash.getByRole('button', { name: '彻底删除…' }).click()
    await shoot('cch-3-purge-confirm')
    await page.getByRole('button', { name: '彻底删除', exact: true }).click()
    const emptied = page.getByRole('dialog', { name: '回收站（0）' })
    await emptied.getByText('回收站是空的').waitFor({ state: 'visible', timeout: 30_000 })
    await emptied.getByRole('button', { name: '关闭', exact: true }).click()
    await emptied.waitFor({ state: 'hidden' })

    await stage.openSettings(page)
    const archive = path.join(roots.projects, 'cch-after.ainovel')
    await context.app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, archive)
    await stage.showSettingsPage(page, '项目备份')
    await stage.root(page).getByRole('button', { name: '导出本地存档', exact: true }).click()
    const notice = stage.root(page).locator('[data-testid="project-backup-panel"] p[role="status"]').filter({ hasText: '本地存档已导出' })
    await notice.waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(fs.existsSync(archive), true, '彻底删除后存档写到了所选位置')
    return { before, inTrash, after: (await notice.innerText()).trim() }
  } },
}
