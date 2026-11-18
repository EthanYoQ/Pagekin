import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { openChapter } from './f491-scenarios.mjs'
import { BOOK, buildByReviewCycle } from './perf702-scenarios.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')

function withBook(projectRoot, action) {
  const database = new Database(path.join(projectRoot, '.ai-novel', 'project.db'), { fileMustExist: true })
  try { return action(database) } finally { database.close() }
}

function cycleOf(database, chapter) {
  const cycle = database.prepare(`SELECT c.root_action_id AS rootActionId, c.review_id AS reviewId FROM review_cycles c
    JOIN reviews r ON r.id=c.review_id JOIN drafts_all d ON d.id=r.base_draft_id WHERE d.chapter_number=?`).get(chapter)
  assert.ok(cycle, `第 ${chapter} 章有一条审修循环`)
  return cycle
}

/** 与 test/helpers/review-cycle-fixture.ts 的 breakReviewProof 保持一致。 */
function breakReviewProof(projectRoot, chapter) {
  withBook(projectRoot, database => {
    const cycle = cycleOf(database, chapter)
    const changed = database.prepare(`UPDATE generation_attempts
      SET usage_receipt_json=json_set(usage_receipt_json,'$.reviewRevisionEffect.contentHash',?)
      WHERE root_action_id=? AND json_extract(usage_receipt_json,'$.reviewRevisionEffect.kind')='review'
        AND json_extract(usage_receipt_json,'$.reviewRevisionEffect.id')=?`).run('0'.repeat(64), cycle.rootActionId, cycle.reviewId).changes
    assert.equal(changed, 1, `第 ${chapter} 章应改坏一条审稿证据，实际改了 ${changed} 条`)
  })
}

/** 清空根预算，使去掉坏循环后这棵根仍过不了投影（ADR-0029「照旧失败」）。 */
function breakRootBudget(projectRoot, chapter) {
  withBook(projectRoot, database => {
    const changed = database.prepare("UPDATE generation_roots SET budget_json='{}' WHERE root_action_id=?").run(cycleOf(database, chapter).rootActionId).changes
    assert.equal(changed, 1)
  })
}

const notice = (page, role) => stage.root(page).locator(`[data-testid="project-backup-panel"] p[role="${role}"]`)

async function exportOnce(context, archive, { settings, page: pageName, button }, role, expected) {
  const { app, page } = context
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, archive)
  await stage.root(page).getByRole('navigation', { name: settings }).getByRole('button', { name: pageName, exact: true }).click()
  await stage.root(page).getByRole('button', { name: button, exact: true }).click()
  const deadline = Date.now() + 60_000
  let shown = ''
  while (!expected.test(shown)) {
    if (Date.now() > deadline) assert.fail(`等不到导出提示，最后看到：${shown || '（无）'}`)
    await page.waitForTimeout(200)
    shown = await notice(page, role).count() ? (await notice(page, role).innerText()).trim() : ''
  }
  assert.equal(fs.existsSync(archive), role === 'status', role === 'status' ? '导出成功时写出了存档' : '导出失败时没有写出存档')
  return shown
}

async function switchLocale(page, from, to) {
  await stage.root(page).getByRole('navigation', { name: from.settings }).getByRole('button', { name: from.appearance, exact: true }).click()
  await page.getByLabel(from.languageLabel).selectOption(to)
  await page.waitForFunction(lang => document.documentElement.lang === lang, to)
}

const ZH = { settings: '设置分组', page: '项目备份', button: '导出本地存档' }
const EN = { settings: 'Settings sections', page: 'Project backup', button: 'Export local archive' }
const SHA = '[0-9a-f]{64}'

export const CCH_SCENARIOS = {
  'cch-export-damaged': { model: true, shell: 'stage', setup: async context => {
    await buildByReviewCycle(context, 2, { saveCheckpoints: false,
      beforeLaunch: () => breakReviewProof(path.join(context.roots.projects, BOOK), 2) })
  }, run: async context => {
    const { page, roots, shoot } = context
    await stage.openAfterRestart(page, BOOK)
    await stage.openSettings(page)
    const zh = await exportOnce(context, path.join(roots.projects, 'cch-zh.ainovel'), ZH, 'status',
      new RegExp(`^本地存档已导出：${SHA}。第 2 章「远航之2」有条审稿记录损坏，没放进存档。正文和审稿内容都在。$`, 'u'))
    await shoot('cch-1-zh')

    await switchLocale(page, { settings: '设置分组', appearance: '外观', languageLabel: '界面语言' }, 'ja-JP')
    const ja = await exportOnce(context, path.join(roots.projects, 'cch-ja.ainovel'), EN, 'status',
      new RegExp(`^Local archive exported: ${SHA}\\. 第2章「远航之2」のレビュー記録が破損していたため、アーカイブに含めませんでした。本文とレビュー内容は含まれています。$`, 'u'))
    await shoot('cch-2-ja')

    await switchLocale(page, { settings: 'Settings sections', appearance: 'Appearance', languageLabel: 'Interface language' }, 'en-US')
    const en = await exportOnce(context, path.join(roots.projects, 'cch-en.ainovel'), EN, 'status',
      new RegExp(`^Local archive exported: ${SHA}\\. A damaged review record in Chapter 2 "远航之2" was left out of the archive\\. The text and reviews are included\\.$`, 'u'))
    await shoot('cch-3-en')
    return { zh, ja, en }
  } },
  'cch-export-multi': { model: true, shell: 'stage', setup: async context => {
    await buildByReviewCycle(context, 2, { saveCheckpoints: false, beforeLaunch: () => {
      for (const chapter of [1, 2]) breakReviewProof(path.join(context.roots.projects, BOOK), chapter)
    } })
  }, run: async context => {
    const { page, roots, shoot } = context
    await stage.openAfterRestart(page, BOOK)
    await stage.openSettings(page)
    const zh = await exportOnce(context, path.join(roots.projects, 'cch-multi-zh.ainovel'), ZH, 'status',
      new RegExp(`^本地存档已导出：${SHA}。第 1、2 章有审稿记录损坏，没放进存档。正文和审稿内容都在。$`, 'u'))
    await shoot('cch-5-multi-zh')

    await switchLocale(page, { settings: '设置分组', appearance: '外观', languageLabel: '界面语言' }, 'en-US')
    const en = await exportOnce(context, path.join(roots.projects, 'cch-multi-en.ainovel'), EN, 'status',
      new RegExp(`^Local archive exported: ${SHA}\\. Damaged review records in Chapters 1, 2 were left out of the archive\\. The text and reviews are included\\.$`, 'u'))
    await shoot('cch-6-multi-en')
    return { zh, en }
  } },
  'cch-trash-damaged': { model: true, shell: 'stage', setup: async context => {
    await buildByReviewCycle(context, 2, { saveCheckpoints: false,
      beforeLaunch: () => breakReviewProof(path.join(context.roots.projects, BOOK), 1) })
  }, run: async context => {
    const { page, roots, shoot } = context
    await stage.openAfterRestart(page, BOOK)
    await openChapter(page, 1)
    await chapterView.more(page, '删除正文…')
    const confirm = page.getByRole('dialog', { name: '删除正文' })
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    await confirm.waitFor({ state: 'hidden' })
    await page.getByText(/^已把「.+」移到回收站/u).first().waitFor({ state: 'visible', timeout: 30_000 })
    await stage.openSettings(page)
    const inTrash = await exportOnce(context, path.join(roots.projects, 'cch-trash.ainovel'), ZH, 'status',
      new RegExp(`^本地存档已导出：${SHA}。回收站里第 1 章「远航之1」有条审稿记录损坏，没放进存档。正文和审稿内容都在。$`, 'u'))
    await shoot('cch-4-trash')
    return { inTrash }
  } },
  'cch-export-still-fails': { model: true, shell: 'stage', setup: async context => {
    await buildByReviewCycle(context, 2, { saveCheckpoints: false, beforeLaunch: () => {
      breakReviewProof(path.join(context.roots.projects, BOOK), 2)
      breakRootBudget(path.join(context.roots.projects, BOOK), 2)
    } })
  }, run: async context => {
    const { page, roots, shoot } = context
    await stage.openAfterRestart(page, BOOK)
    await stage.openSettings(page)
    const zh = await exportOnce(context, path.join(roots.projects, 'cch-fail-zh.ainovel'), ZH, 'alert',
      /^作品没有改动。第 2 章「远航之2」有条审稿记录损坏，存档没生成。请把这条提示反馈给我们。$/u)
    await shoot('cch-7-still-fails')
    return { zh }
  } },
}
