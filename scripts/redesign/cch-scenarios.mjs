// #702：全书审修循环校验挡住导出时，备份页说明是哪一章坏了、怎么处理，不露错误码。
// 跑法：PERF702_BLUEPRINTS=2 PERF702_FINALIZED=2，书只有两章，第 2 章的审稿证据在重启前被改坏。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as stage from './pages/stage.mjs'
import { buildByReviewCycle } from './perf702-scenarios.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')
const BOOK = '盐湖'

/** 同 test/helpers/review-cycle-fixture.ts 的 breakReviewProof：第 2 章审稿运行记下的内容哈希换成另一份。 */
function breakChapterTwoReviewProof(projectRoot) {
  const database = new Database(path.join(projectRoot, '.ai-novel', 'project.db'), { fileMustExist: true })
  try {
    const cycle = database.prepare(`SELECT c.root_action_id AS rootActionId, c.review_id AS reviewId FROM review_cycles c
      JOIN reviews r ON r.id=c.review_id JOIN drafts_all d ON d.id=r.base_draft_id WHERE d.chapter_number=2`).get()
    assert.ok(cycle, '第 2 章有一条审修循环')
    const changed = database.prepare(`UPDATE generation_attempts
      SET usage_receipt_json=json_set(usage_receipt_json,'$.reviewRevisionEffect.contentHash',?)
      WHERE root_action_id=? AND json_extract(usage_receipt_json,'$.reviewRevisionEffect.kind')='review'
        AND json_extract(usage_receipt_json,'$.reviewRevisionEffect.id')=?`).run('0'.repeat(64), cycle.rootActionId, cycle.reviewId).changes
    assert.equal(changed, 1, '改坏了第 2 章那一条审稿证据')
  } finally { database.close() }
}

const alert = page => stage.root(page).locator('[data-testid="project-backup-panel"] p[role="alert"]')

async function exportOnce(context, archive, { settings, page: pageName, button }) {
  const { app, page } = context
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, archive)
  await stage.root(page).getByRole('navigation', { name: settings }).getByRole('button', { name: pageName, exact: true }).click()
  await stage.root(page).getByRole('button', { name: button, exact: true }).click()
  await alert(page).waitFor({ state: 'visible', timeout: 60_000 })
  const shown = (await alert(page).innerText()).trim()
  assert.equal(fs.existsSync(archive), false, '导出失败时没有写出存档')
  return shown
}

async function switchLocale(page, from, to) {
  await stage.root(page).getByRole('navigation', { name: from.settings }).getByRole('button', { name: from.appearance, exact: true }).click()
  await page.getByLabel(from.languageLabel).selectOption(to)
  await page.getByLabel('Interface language').waitFor({ state: 'visible' })
}

export const CCH_SCENARIOS = {
  'cch-export-damaged': { model: true, shell: 'stage', setup: async context => {
    await buildByReviewCycle(context, 2)
    await context.restart({ beforeLaunch: () => breakChapterTwoReviewProof(path.join(context.roots.projects, BOOK)) })
  }, run: async context => {
    const { page, roots, shoot } = context
    await stage.openFromLibrary(page, BOOK)
    await stage.openSettings(page)
    const zh = await exportOnce(context, path.join(roots.projects, 'cch-zh.ainovel'),
      { settings: '设置分组', page: '项目备份', button: '导出本地存档' })
    await shoot('cch-1-zh')
    assert.equal(zh, '作品没有改动。第 2 章「远航之2」有一条审稿记录已损坏，存档没有生成。'
      + '可以先点「复制本章正文」留底，再点「删除正文…」，并到回收站「彻底删除…」这一章，之后再试。')

    await switchLocale(page, { settings: '设置分组', appearance: '外观', languageLabel: '界面语言' }, 'ja-JP')
    const ja = await exportOnce(context, path.join(roots.projects, 'cch-ja.ainovel'),
      { settings: 'Settings sections', page: 'Project backup', button: 'Export local archive' })
    await shoot('cch-2-ja')
    assert.equal(ja, '作品は変更されていません。第2章「远航之2」のレビュー記録が1件破損しているため、アーカイブは作成されませんでした。'
      + '「Copy chapter text」で本文を控えてから「Delete manuscript…」を選び、ゴミ箱で「Delete permanently…」を選んで、もう一度お試しください。')

    await switchLocale(page, { settings: 'Settings sections', appearance: 'Appearance', languageLabel: 'Interface language' }, 'en-US')
    const en = await exportOnce(context, path.join(roots.projects, 'cch-en.ainovel'),
      { settings: 'Settings sections', page: 'Project backup', button: 'Export local archive' })
    return { zh, ja, en }
  } },
}
