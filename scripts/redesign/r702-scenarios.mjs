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
    assert.equal(await chapterView.reviseButton(page).innerText(), label, '恢复的副本里第 4 章仍停在已审稿，主按钮与恢复前一致')
    await chapterView.reviseButton(page).click()
    const failure = stage.root(page).getByText(RESTORED_HISTORY, { exact: true })
    await failure.waitFor({ state: 'visible', timeout: 30_000 })
    await shoot('r702-1-restored-revise')
    assert.equal(await stage.root(page).getByText(/可追溯的生成记录|GENERATION_/u).count(), 0, '不再落到通用的「没有可追溯的生成记录」，也不露原码')
    assert.equal(await chapterView.view(page).getByRole('button', { name: '重新审稿', exact: true }).isEnabled(), true, '「重新审稿」就在动作条上')

    await runOnce(page, () => chapterView.view(page).getByRole('button', { name: '重新审稿', exact: true }).click())
    await runOnce(page, () => chapterView.reviseButton(page).click())
    await chapterView.merge(page).waitFor({ state: 'visible', timeout: 60_000 })
    await shoot('r702-2-fresh-revise')
    return { label }
  } },
}
