import assert from 'node:assert/strict'

import * as chapterView from './pages/chapter-view.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as shell from './pages/shell.mjs'
import * as stage from './pages/stage.mjs'
import { FIXTURE_PROSE } from './fake-model.mjs'
import { firstLine, seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

export async function runsStarted(page) {
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

export async function waitRunDone(page, before) {
  await page.waitForFunction(({ before, selector }) => window.__i686Runs.count > before && !document.querySelector(selector),
    { before, selector: '.stage-capsule:not([data-tone="ok"])' }, { timeout: 90_000 })
}

export async function recoveryListed(app, page) {
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
      globalThis.__i686Partial = result?.partial === true
      return result
    })
  })
  await runSheet.openFromPalette(page)
  for (const deadline = Date.now() + 10_000; ; await page.waitForTimeout(50)) {
    if (await app.evaluate(() => globalThis.__i686Reads) > 0) break
    assert.ok(Date.now() < deadline, '10 秒内运行侧页没有读可恢复列表')
  }
  assert.equal(await app.evaluate(() => globalThis.__i686Partial), false, '可恢复列表读全了：读不全时少列的卡片不能当作「不再列出」')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

const reviewCards = page => runSheet.sheet(page).locator('.run-recovery > .run-card').evaluateAll(cards => cards
  .map(card => ({ kicker: card.querySelector('.run-card-kicker')?.textContent ?? '', title: card.querySelector('h3')?.textContent ?? '' }))
  .filter(card => /^第\d+章(审稿|修稿)候选$/u.test(card.title)))

export const allCards = page => runSheet.sheet(page).locator('.run-recovery > .run-card').evaluateAll(cards => cards.map(card => ({
  kicker: card.querySelector('.run-card-kicker')?.textContent ?? '',
  title: card.querySelector('h3')?.textContent ?? '',
  buttons: [...card.querySelectorAll('.run-card-head button, .run-card-buttons button')].map(button => button.textContent),
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
    assert.ok(listed[0].buttons.includes('不再恢复'), '审稿卡有「不再恢复」')

    await runSheet.sheet(context.page).locator('.run-recovery > .run-card').first().getByRole('button', { name: '不再恢复' }).click()
    await runSheet.sheet(context.page).locator('.run-recovery').waitFor({ state: 'detached' })
    const hidden = await allCards(context.page)
    assert.deepEqual(hidden, [], '点「不再恢复」后审稿卡不再列出')
    return { listed, hidden }
  } },
  'i686-tail-copy-only': { model: true, shell: 'stage', setup: context => seedStageSample(context), run: async context => {
    await chapterView.open(context.page, 4)
    context.fake.replyReview(prompt => prompt.includes('goalReviews') ? '这一次没有给出审稿报告。' : null)
    const broken = await runsStarted(context.page)
    await chapterView.view(context.page).getByRole('button', { name: 'AI 审稿', exact: true }).click()
    await waitRunDone(context.page, broken)
    context.fake.replyReview(undefined)
    await chapterView.prose(context.page).getByText('你父亲也问过钟的事').first().click()
    await context.page.keyboard.press('End')
    await context.page.keyboard.type('钟声停了。')
    await stage.saveWithCtrlS(context.page)

    context.fake.failProse()
    await chapterView.prose(context.page).getByText('你父亲也问过钟的事').first().click({ clickCount: 3 })
    const toolbar = context.page.getByRole('toolbar', { name: '选中文字的操作' })
    await toolbar.getByRole('button', { name: '润色' }).click()
    await toolbar.getByText('生成未完整完成，结果不可应用').waitFor({ state: 'visible', timeout: 30_000 })
    context.fake.failProse(false)

    await context.restart()
    await stage.openAfterRestart(context.page, STAGE_SAMPLE.name)
    await context.page.waitForTimeout(2000)
    await recoveryListed(context.app, context.page)
    const listed = await allCards(context.page)
    await context.shoot('i686-tail-copy-only-run-sheet')
    assert.deepEqual(listed.map(card => card.title), ['编辑器选区建议', '第4章审稿候选'], '中途被拦下的选区建议和来源已变的审稿仍列出')
    assert.ok(listed.every(card => card.buttons.includes('不再恢复')), '两张卡都有「不再恢复」')
    const resumable = await runSheet.sheet(context.page).locator('.run-recovery > .run-card').evaluateAll(cards => cards.map(card =>
      [...card.querySelectorAll('.run-card-buttons .pi-btn--secondary')].map(button => ({ label: button.textContent, disabled: button.disabled }))))
    assert.ok(resumable.every(buttons => buttons.length > 0 && buttons.every(button => button.disabled)), `两张卡的继续类按钮都不可点：${JSON.stringify(resumable)}`)
    await runSheet.sheet(context.page).locator('.run-recovery > .run-card').last().locator('.run-card-buttons').scrollIntoViewIfNeeded()
    await context.shoot('i686-tail-copy-only-review')

    for (const title of ['编辑器选区建议', '第4章审稿候选']) {
      await runSheet.sheet(context.page).locator('.run-recovery > .run-card').filter({ has: context.page.getByRole('heading', { name: title }) })
        .getByRole('button', { name: '不再恢复' }).click()
    }
    await runSheet.sheet(context.page).locator('.run-recovery').waitFor({ state: 'detached' })
    const hidden = await allCards(context.page)
    assert.deepEqual(hidden, [], '两张卡点「不再恢复」后都不再列出')
    return { listed, resumable, hidden }
  } },
  'i686-continue-selection': { model: true, shell: 'stage', setup: context => seedStageSample(context), run: async context => {
    const before = await continueInterruptedSelection(context)
    const bubble = context.page.getByRole('toolbar', { name: '选中文字的操作' })
    await bubble.getByText(firstLine(FIXTURE_PROSE)).waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(await runSheet.sheet(context.page).isVisible(), false, '运行侧页已收起')
    await context.shoot('i686-continue-bubble')

    await bubble.getByRole('button', { name: '替换' }).click()
    await bubble.getByRole('button', { name: '替换' }).waitFor({ state: 'hidden' })
    assert.ok((await chapterView.prose(context.page).innerText()).includes(firstLine(FIXTURE_PROSE)), '建议替换进正文')
    await recoveryListed(context.app, context.page)
    const after = await allCards(context.page)
    assert.ok(!after.some(card => card.title === '编辑器选区建议'), '送达气泡的选区建议不再列出')
    return { before, after }
  } },
  'i686-continue-selection-changed': { model: true, shell: 'stage', setup: context => seedStageSample(context), run: async context => {
    const before = await continueInterruptedSelection(context, async () => {
      await chapterView.prose(context.page).getByText('你父亲也问过钟的事').first().click()
      await context.page.keyboard.press('End')
      await context.page.keyboard.type('夜')
    })
    const card = runSheet.sheet(context.page).locator('.run-recovery > .run-card').filter({ has: context.page.getByRole('heading', { name: '编辑器选区建议' }) })
    await card.getByText(firstLine(FIXTURE_PROSE)).waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(await context.page.getByRole('toolbar', { name: '选中文字的操作' }).count(), 0, '没有重开气泡')
    await card.locator('.run-card-buttons').scrollIntoViewIfNeeded()
    await context.shoot('i686-continue-card')
    return { before, after: await allCards(context.page) }
  } },
}

async function continueInterruptedSelection(context, beforeContinue = async () => {}) {
  await chapterView.open(context.page, 4)
  await context.app.evaluate(({ ipcMain }) => {
    ipcMain._invokeHandlers.set('editor-inline:execute', async () => { throw new Error('请求发出前应用关闭') })
  })
  await chapterView.prose(context.page).getByText('你父亲也问过钟的事').first().click({ clickCount: 3 })
  const toolbar = context.page.getByRole('toolbar', { name: '选中文字的操作' })
  await toolbar.getByRole('button', { name: '润色' }).click()
  await toolbar.getByText('生成失败，结果不可应用').waitFor({ state: 'visible', timeout: 30_000 })

  await context.restart()
  await stage.openAfterRestart(context.page, STAGE_SAMPLE.name)
  await chapterView.open(context.page, 4)
  await beforeContinue()
  await recoveryListed(context.app, context.page)
  const before = await allCards(context.page)
  assert.ok(before.some(card => card.title === '编辑器选区建议' && card.buttons.includes('继续原选区任务')), '重启后列出可继续的选区任务')
  await runSheet.sheet(context.page).locator('.run-recovery > .run-card').filter({ has: context.page.getByRole('heading', { name: '编辑器选区建议' }) })
    .getByRole('button', { name: '继续原选区任务' }).click()
  return before
}
