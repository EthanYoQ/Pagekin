import assert from 'node:assert/strict'

import * as chapterView from './pages/chapter-view.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as shell from './pages/shell.mjs'
import * as stage from './pages/stage.mjs'
import { FIXTURE_PROSE } from './fake-model.mjs'
import { firstLine, seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

async function runsStarted(page) {
  return page.evaluate(() => {
    if (!window.__i686Runs) {
      window.__i686Runs = { count: 0 }
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes)
          if (node instanceof Element && node.matches('.stage-capsule:not([data-tone="ok"])')) window.__i686Runs.count++
      }).observe(document.body, { childList: true, subtree: true })
    }
    return window.__i686Runs.count
  })
}

async function waitRunDone(page, before) {
  await page.waitForFunction(({ before, selector }) => window.__i686Runs.count > before && !document.querySelector(selector),
    { before, selector: '.stage-capsule:not([data-tone="ok"])' }, { timeout: 90_000 })
}

async function recoveryListed(app, page) {
  if (await runSheet.sheet(page).isVisible()) {
    await runSheet.sheet(page).getByRole('button', { name: '收起运行侧页' }).first().click()
    await runSheet.sheet(page).waitFor({ state: 'hidden' })
  }
  await app.evaluate(({ ipcMain }) => {
    globalThis.__i686Reads = 0
    if (globalThis.__i686Wrapped) return
    globalThis.__i686Wrapped = true
    const original = ipcMain._invokeHandlers.get('generation:list-recovery')
    ipcMain._invokeHandlers.set('generation:list-recovery', async (...args) => {
      const result = await original(...args)
      globalThis.__i686Reads += 1
      return result
    })
  })
  await runSheet.openFromPalette(page)
  for (const deadline = Date.now() + 10_000; ; await page.waitForTimeout(50)) {
    if (await app.evaluate(() => globalThis.__i686Reads) > 0) break
    assert.ok(Date.now() < deadline, '10 秒内运行侧页没有读可恢复列表')
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

const reviewCards = page => runSheet.sheet(page).locator('.run-recovery > .run-card').evaluateAll(cards => cards
  .map(card => ({ kicker: card.querySelector('.run-card-kicker')?.textContent ?? '', title: card.querySelector('h3')?.textContent ?? '' }))
  .filter(card => /^第\d+章(审稿|修稿)候选$/u.test(card.title)))

const allCards = page => runSheet.sheet(page).locator('.run-recovery > .run-card').evaluateAll(cards => cards.map(card => ({
  kicker: card.querySelector('.run-card-kicker')?.textContent ?? '',
  title: card.querySelector('h3')?.textContent ?? '',
  buttons: [...card.querySelectorAll('.run-card-buttons button')].map(button => button.textContent),
})))

async function refineSelection(page, text, finish) {
  await chapterView.prose(page).getByText(text).first().click({ clickCount: 3 })
  const toolbar = page.getByRole('toolbar', { name: '选中文字的操作' })
  await toolbar.getByRole('button', { name: '润色' }).click()
  await toolbar.getByText(firstLine(FIXTURE_PROSE)).waitFor({ state: 'visible', timeout: 30_000 })
  await toolbar.getByRole('button', { name: finish }).click()
  await toolbar.getByRole('button', { name: finish }).waitFor({ state: 'hidden' })
}

export const I686_SCENARIOS = {
  'i686-saved-review-revision': { model: true, shell: 'stage', setup: context => seedStageSample(context), run: async ({ app, page, fake, shoot }) => {
    await chapterView.open(page, 4)
    fake.replyReview(prompt => prompt.includes('goalReviews') ? '这一次没有给出审稿报告。' : null)
    const broken = await runsStarted(page)
    await chapterView.view(page).getByRole('button', { name: 'AI 审稿', exact: true }).click()
    await waitRunDone(page, broken)
    fake.replyReview(undefined)

    const reviewing = await runsStarted(page)
    await chapterView.review(page)
    await waitRunDone(page, reviewing)
    const revising = await runsStarted(page)
    await chapterView.reviseButton(page).click()
    await chapterView.merge(page).waitFor({ state: 'visible', timeout: 60_000 })
    await waitRunDone(page, revising)
    await shell.waitForCompletionToast(page)
    await shell.dismissCompletionToasts(page)

    await recoveryListed(app, page)
    const cards = await reviewCards(page)
    await shoot('i686-run-sheet')
    assert.deepEqual(cards, [{ kicker: '可恢复', title: '第4章审稿候选' }], '只列没保存的那次审稿，已保存的审稿与修稿不列')
    return { cards }
  } },
  /** 选区润色替换一次、润色后取消一次，再审稿一次没拿到报告；重启后「可恢复」只剩那张审稿卡，它和选区卡都能「不再显示」。 */
  'i686-tail-cards': { model: true, shell: 'stage', setup: context => seedStageSample(context), run: async context => {
    await chapterView.open(context.page, 4)
    await refineSelection(context.page, firstLine(STAGE_SAMPLE.drafts[4].text), '替换')
    await refineSelection(context.page, '你父亲也问过钟的事', '取消')
    context.fake.replyReview(prompt => prompt.includes('goalReviews') ? '这一次没有给出审稿报告。' : null)
    const broken = await runsStarted(context.page)
    await chapterView.view(context.page).getByRole('button', { name: 'AI 审稿', exact: true }).click()
    await waitRunDone(context.page, broken)
    context.fake.replyReview(undefined)
    await context.page.keyboard.press('ControlOrMeta+S')

    await context.restart()
    await stage.openAfterRestart(context.page, STAGE_SAMPLE.name)
    await context.page.waitForTimeout(2000)
    await recoveryListed(context.app, context.page)
    const listed = await allCards(context.page)
    await context.shoot('i686-tail-run-sheet')
    assert.deepEqual(listed.map(card => card.title), ['第4章审稿候选'], '送达过和拒绝过的选区建议不列，只剩没拿到报告的审稿')
    assert.ok(listed[0].buttons.includes('不再显示'), '审稿卡有「不再显示」')

    await runSheet.sheet(context.page).locator('.run-recovery > .run-card').first().getByRole('button', { name: '不再显示' }).click()
    const hidden = await allCards(context.page)
    assert.deepEqual(hidden, [], '点「不再显示」后审稿卡不再列出')
    return { listed, hidden }
  } },
}
