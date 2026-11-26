import assert from 'node:assert/strict'

import { allCards, recoveryListed, runsStarted, waitRunDone } from './i686-scenarios.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const CARDS = ['编辑器选区建议', '第4章审稿候选', '第3章候选']
const titles = cards => cards.map(card => card.title)

async function reopenRunSheet(context) {
  await context.restart()
  await stage.openAfterRestart(context.page, STAGE_SAMPLE.name)
  await context.page.waitForTimeout(2000)
  await recoveryListed(context.app, context.page)
  return allCards(context.page)
}

export const I686D_SCENARIOS = {
  'i686d-abandon': { model: true, shell: 'stage', setup: context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path: projectPath, session }) => {
    for (const draft of await invoke(page, 'db:draft-list', 3, projectPath, session)) {
      assert.equal((await invoke(page, 'db:draft-delete', draft.id, projectPath, session)).success, true)
    }
  } }), run: async context => {
    const { page, fake } = context
    fake.failProse()
    await blueprint.open(page)
    await blueprint.writeNext(page)
    await runSheet.waitUntilOpen(page)
    await runSheet.recovery(page).getByRole('article').filter({ hasText: /第3章候选/ }).waitFor({ state: 'visible', timeout: 60_000 })
    fake.failProse(false)

    await runSheet.sheet(page).getByRole('button', { name: '收起运行侧页' }).first().click()
    await stage.openChapter(page, 4)
    await chapterView.view(page).waitFor({ state: 'visible' })
    fake.replyReview(prompt => prompt.includes('goalReviews') ? '这一次没有给出审稿报告。' : null)
    const broken = await runsStarted(page)
    await chapterView.view(page).getByRole('button', { name: 'AI 审稿', exact: true }).click()
    await waitRunDone(page, broken)
    fake.replyReview(undefined)

    fake.failProse()
    await chapterView.prose(page).getByText('你父亲也问过钟的事').first().click({ clickCount: 3 })
    const toolbar = page.getByRole('toolbar', { name: '选中文字的操作' })
    await toolbar.getByRole('button', { name: '润色' }).click()
    await toolbar.getByText('生成未完整完成，结果不可应用').waitFor({ state: 'visible', timeout: 30_000 })
    fake.failProse(false)

    const listed = await reopenRunSheet(context)
    assert.deepEqual(titles(listed), CARDS, '重启后三类恢复卡都列出')
    assert.ok(listed.every(card => card.buttons[0] === '不再恢复'), '每张卡右上角第一个按钮是「不再恢复」')
    await context.shoot('i686d-cards')

    const restarted = context.page
    const abandonTwo = async afterFirst => {
      for (const [title, left] of [['第4章审稿候选', 2], ['第3章候选', 1]]) {
        await runSheet.sheet(restarted).locator('.run-recovery > .run-card').filter({ has: restarted.getByRole('heading', { name: title }) })
          .getByRole('button', { name: '不再恢复' }).click()
        await restarted.waitForFunction(count => document.querySelectorAll('.run-recovery > .run-card').length === count, left)
        if (left === 2) await afterFirst?.()
      }
    }
    await abandonTwo(async () => {
      const single = restarted.locator('.pi-toast:not([data-exiting])').filter({ hasText: '已不再恢复「第4章审稿候选」' })
      await single.waitFor({ state: 'visible' })
      await restarted.mouse.move(0, 0)
      assert.ok(!(await single.innerText()).includes('生成记录'), '单张提示条不说生成记录还在')
      await context.shoot('i686d-abandoned-one')
    })
    const toast = restarted.locator('.pi-toast:not([data-exiting])').filter({ hasText: '已不再恢复 2 张卡片' })
    await toast.waitFor({ state: 'visible' })
    await restarted.mouse.move(0, 0)
    const abandoned = await allCards(restarted)
    assert.deepEqual(titles(abandoned), ['编辑器选区建议'], '点了的两张不再列出，选区卡不动')
    const toastText = await toast.innerText()
    assert.ok(toastText.includes('已不再恢复') && !toastText.includes('生成记录'), '提示条不说生成记录还在')
    assert.ok(await toast.getByRole('button', { name: '撤销' }).isVisible(), '提示条可撤销')
    await context.shoot('i686d-abandoned')

    await toast.getByRole('button', { name: '撤销' }).click()
    await restarted.waitForFunction(() => document.querySelectorAll('.run-recovery > .run-card').length === 3)
    const undone = await allCards(restarted)
    assert.deepEqual(titles(undone), CARDS, '撤销后两张都放回')
    await abandonTwo()

    const afterRestart = await reopenRunSheet(context)
    assert.deepEqual(titles(afterRestart), ['编辑器选区建议'], '重启后点过「不再恢复」的两张不回来')
    await context.shoot('i686d-after-restart')
    return { listed, abandoned, toastText, undone, afterRestart }
  } },
}
