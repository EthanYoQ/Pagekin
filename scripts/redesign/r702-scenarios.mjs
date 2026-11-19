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

const EDITED_PARAGRAPH = '你父亲也问过钟的事'
const EDIT = '钟声停了。'

/** 第 4 章审稿（同 x2-recheck，带正文证据的本章目标意见，合并后需要复验）、修稿后稍后再合并，导出并恢复，在副本里打开第 4 章。 */
async function openRestoredPendingRevision(context, label) {
  const { page, fake } = context
  fake.replyReview(JSON.stringify({ summary: '本章目标还没落地。', items: [
    { category: '连续性', severity: 'warning', description: '核对钟声提前一刻与潮位的关系。', quote: '他给林岚倒了一杯很淡的茶' },
  ], goalReviews: [{ id: 'ch4:keyEvents:1', status: 'unmet', description: '林岚还没有在灯塔里找到新的线索。',
    evidence: [{ quote: '守塔人的屋子在灯塔背风的一侧' }] }] }))
  await chapterView.open(page, 4)
  await runOnce(page, () => chapterView.review(page))
  await runOnce(page, () => chapterView.reviseButton(page).click())
  await chapterView.merge(page).getByRole('button', { name: '稍后再合并' }).click()
  await chapterView.merge(page).waitFor({ state: 'detached' })

  const restoredRoot = await exportAndRestore(context, context.samplePath, label)
  await openInUi(context, restoredRoot)
  if (!await stage.chapterButton(page, 4).isVisible()) await stage.stageButton(page, '正文').click()
  await chapterView.open(page, 4)
  await chapterView.merge(page).waitFor({ state: 'visible', timeout: 30_000 })
}

/** 合并照常，之后假模型不再收到请求：恢复前的循环不自动复验，也不留失败运行。 */
async function mergeAndExpectNoRecheck(page, fake, chats) {
  await chapterView.merge(page).getByRole('button', { name: '全部用修稿' }).click()
  await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
  await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(3000)
  assert.equal(fake.chats.length, chats, '合并后没有发起复验')
  assert.equal(await page.locator('.stage-capsule').count(), 0, '没有自动发起复验，也就没有失败的运行')
  assert.equal(await page.getByText(/自动复验未启动/u).count(), 0, '不提示自动复验未启动')
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
  'r702-restored-merge': { model: true, shell: 'stage', setup: context => seedStageSample(context), run: async context => {
    const { page, fake, shoot } = context
    await openRestoredPendingRevision(context, 'r702-restored-merge')
    assert.equal(await chapterView.merge(page).getByText(/合并后会自动复验/u).count(), 0, '恢复前的修稿：合并视图不说会复验')
    await mergeAndExpectNoRecheck(page, fake, 2)
    await chapterView.hint(page).getByText(RESTORED_HISTORY, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await shoot('r702-3-restored-merge')
    return { chats: fake.chats.length }
  } },
  /** Codex 在 #746 复现的路径：恢复后改稿、重新审稿，再把正文改回去，恢复前的修稿又能合并。 */
  'r702-rereview-old-revision': { model: true, shell: 'stage', setup: context => seedStageSample(context), run: async context => {
    const { page, fake, shoot } = context
    await openRestoredPendingRevision(context, 'r702-rereview-old-revision')
    await chapterView.merge(page).getByRole('button', { name: '稍后再合并' }).click()
    await chapterView.merge(page).waitFor({ state: 'detached' })
    await chapterView.prose(page).getByText(EDITED_PARAGRAPH).first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(EDIT)
    await stage.saveWithCtrlS(page)
    await runOnce(page, () => chapterView.primary(page).click())
    await chapterView.reviseButton(page).waitFor({ state: 'visible', timeout: 30_000 })

    await chapterView.prose(page).getByText(EDITED_PARAGRAPH).first().click()
    await page.keyboard.press('End')
    for (let typed = EDIT.length; typed > 0; typed--) await page.keyboard.press('Backspace')
    await stage.saveWithCtrlS(page)
    if (!await chapterView.merge(page).isVisible()) await chapterView.primary(page).click()
    await chapterView.merge(page).waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(await chapterView.merge(page).getByText(/合并后会自动复验/u).count(), 0, '合并的是恢复前的修稿：显示的虽是新审稿，合并视图也不说会复验')
    await shoot('r702-4-rereview-old-revision')
    await mergeAndExpectNoRecheck(page, fake, 3)
    return { chats: fake.chats.length }
  } },
}
