import assert from 'node:assert/strict'

import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { exportAndRestore, openInUi } from './f491-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'

const RESTORED_HISTORY = '审稿内容都还在，但它是作品从备份恢复前做的，不能接着按它修稿或复验。点「重新审稿」，再按新意见修稿。'

/** 审稿与修稿在后台跑，必须等运行胶囊出现并消失后才能点下一步。 */
async function runOnce(page, action) {
  await page.evaluate(() => {
    window.__r702Runs = { count: 0 }
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && node.matches('.stage-capsule:not([data-tone="ok"])')) window.__r702Runs.count++
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
  await action()
  await page.waitForFunction(() => window.__r702Runs.count > 0 && !document.querySelector('.stage-capsule:not([data-tone="ok"])'), null, { timeout: 90_000 })
}

export const R702_SCENARIOS = {
  'r702-restored-review': { model: true, shell: 'stage', setup: context => seedStageSample(context), run: async context => {
    const { page, shoot } = context
    await chapterView.open(page, 4)
    await runOnce(page, () => chapterView.review(page))
    const label = await chapterView.reviseButton(page).innerText()

    const restoredRoot = await exportAndRestore(context, context.samplePath, 'r702-restored')
    await openInUi(context, restoredRoot)
    if (!await stage.chapterButton(page, 4).isVisible()) await stage.stageButton(page, '正文').click()
    await chapterView.open(page, 4)
    await chapterView.hint(page).getByText(RESTORED_HISTORY, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(await chapterView.primary(page).innerText(), '重新审稿', '恢复前审过稿的章，主按钮直接是「重新审稿」')
    assert.equal(await chapterView.reviseButton(page).count(), 0, '不再摆「按 N 项意见修稿」')
    assert.equal(await chapterView.view(page).getByRole('button', { name: /^(确认不修改|修稿选项)$/u }).count(), 0, '依赖旧循环的入口都不出现')
    assert.equal(await chapterView.reviewSheet(page).isVisible(), true, '审稿报告照常可读')
    assert.equal(await page.locator('.stage-capsule').count(), 0, '没有点过修稿，也就没有失败的运行')
    await shoot('r702-3-restored-review')

    await runOnce(page, () => chapterView.primary(page).click())
    await chapterView.reviseButton(page).waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(await chapterView.hint(page).getByText(RESTORED_HISTORY, { exact: true }).count(), 0, '重新审稿后不再提示恢复前')
    await runOnce(page, () => chapterView.reviseButton(page).click())
    await chapterView.merge(page).waitFor({ state: 'visible', timeout: 60_000 })
    await shoot('r702-3-fresh-revise')
    return { label }
  } },
}
