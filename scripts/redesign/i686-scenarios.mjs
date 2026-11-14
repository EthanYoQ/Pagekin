import assert from 'node:assert/strict'

import * as chapterView from './pages/chapter-view.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as shell from './pages/shell.mjs'
import { seedStageSample } from './scenarios.mjs'

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
}
