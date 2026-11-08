import assert from 'node:assert/strict'

import { streamingProse } from './fake-model.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample, untilGateHolds } from './scenarios.mjs'

const capsule = page => stage.root(page).getByRole('banner').locator('.stage-capsule')
const note = page => runSheet.sheet(page).locator('.run-step-wait')

/** 让假模型卡住第一次请求，等到运行侧页出现等待说明。 */
async function waitOnHeldModel(page, fake) {
  fake.gate.hold()
  await blueprint.open(page)
  await blueprint.writeNext(page)
  await runSheet.waitUntilOpen(page)
  await untilGateHolds(fake.gate)
  await note(page).waitFor({ state: 'visible', timeout: 25_000 })
  assert.match(await note(page).innerText(), /^正在等模型回复，已等 \d+ 秒$/)
}

async function finish({ page, fake }) {
  fake.gate.release()
  await runSheet.waitForRunDone(page)
}

export const I631_SCENARIOS = {
  'i631-wait-sheet': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake }) => {
    await waitOnHeldModel(page, fake)
    const first = await note(page).innerText()
    await page.waitForFunction(([selector, seen]) => document.querySelector(selector)?.textContent !== seen, ['.run-step-wait', first], { timeout: 5_000 })
    return { first, later: await note(page).innerText(), capsule: await capsule(page).innerText() }
  }, after: finish },

  'i631-wait-capsule': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake }) => {
    await waitOnHeldModel(page, fake)
    await capsule(page).click()
    await runSheet.sheet(page).waitFor({ state: 'hidden' })
    await page.waitForTimeout(3_000)
    const text = await capsule(page).innerText()
    assert.match(text, /已等 \d+ 秒/)
    return { capsule: text }
  }, after: async ({ page, fake }) => {
    fake.gate.release()
    await capsule(page).waitFor({ state: 'detached', timeout: 90_000 })
  } },

  'i631-wait-review': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake }) => {
    fake.gate.hold()
    await chapterView.open(page, 4)
    await chapterView.view(page).getByRole('button', { name: 'AI 审稿', exact: true }).click()
    await untilGateHolds(fake.gate)
    if (!await runSheet.sheet(page).isVisible()) await capsule(page).click()
    await runSheet.waitUntilOpen(page)
    await note(page).getByText(/已等/).waitFor({ state: 'visible', timeout: 25_000 })
    const shown = await page.evaluate(() => ({
      capsule: document.querySelector('.stage-capsule-wait')?.textContent ?? '',
      firstLine: document.querySelector('.run-step-wait > p')?.textContent ?? '',
      lines: [...document.querySelectorAll('.run-step-wait > p')].map(line => line.textContent),
    }))
    assert.equal(shown.firstLine, `正在等模型回复，${shown.capsule}`, '胶囊和侧页首行是同一个已等时长')
    assert.ok(shown.lines.some(line => line.includes('尚无完整审稿报告')), '原有的审稿说明还在')
    return shown
  }, after: async ({ page, fake }) => {
    fake.gate.release()
    await capsule(page).waitFor({ state: 'detached', timeout: 90_000 })
  } },

  'i631-wait-resumed': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake }) => {
    fake.streamProse({ chunks: streamingProse(60, 50), intervalMs: 800 })
    await waitOnHeldModel(page, fake)
    fake.gate.release()
    await note(page).waitFor({ state: 'hidden', timeout: 10_000 })
    await page.waitForFunction(selector => [...document.querySelectorAll(selector)].at(-1)?.textContent?.includes('第3句'), runSheet.OUTPUT_TEXT, { timeout: 30_000 })
    const flashes = await page.evaluate(() => new Promise(resolve => {
      let seen = 0
      const timer = setInterval(() => { if (document.querySelector('.run-step-wait')) seen++ }, 200)
      setTimeout(() => { clearInterval(timer); resolve(seen) }, 20_000)
    }))
    assert.equal(flashes, 0, '正常流式输出期间不出现等待说明')
    const text = await capsule(page).innerText()
    assert.doesNotMatch(text, /已等/)
    return { flashes, capsule: text }
  }, after: ({ page }) => runSheet.waitForRunDone(page, 120_000) },
}
