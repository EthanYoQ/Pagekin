import assert from 'node:assert/strict'

import * as blueprint from './pages/blueprint.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import { seedStageSample } from './scenarios.mjs'

const RECOVERY_CARD = '有一份蓝图恢复稿'

async function failBlueprints(page) {
  await blueprint.open(page)
  await blueprint.generateRange(page, 13, 16)
  await runSheet.waitUntilOpen(page)
  const failedStep = runSheet.sheet(page).locator('.run-step[data-status="failed"] .run-step-row').first()
  await failedStep.waitFor({ state: 'visible', timeout: 90_000 })
  if (await failedStep.getAttribute('aria-expanded') !== 'true') await failedStep.click()
  const notice = runSheet.sheet(page).locator('.run-step[data-status="failed"] .run-step-error').first()
  await notice.waitFor({ state: 'visible' })
  return (await notice.innerText()).trim()
}

async function recoveryCard(page) {
  await page.keyboard.press('Escape')
  await blueprint.open(page)
  const card = page.getByText(RECOVERY_CARD)
  await card.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  return card.isVisible()
}

export const ERR903_SCENARIOS = {
  'err903-blueprint-failure-recovery-kept': { model: true, shell: 'stage', setup: context => seedStageSample(context, { totalChapters: 16 }), run: async ({ page, shoot }) => {
    const notice = await failBlueprints(page)
    await shoot('err903-blueprint-failure-recovery-kept-notice')
    const cardShown = await recoveryCard(page)
    await shoot('err903-blueprint-failure-recovery-kept-card')
    assert.equal(cardShown, true, '模型回了不合格的蓝图：蓝图页有恢复稿卡片')
    assert.equal(notice, '原有蓝图未改动，已生成的内容存入了恢复稿。蓝图生成失败，可点「编辑恢复稿」或重新生成。')
    return { notice, cardShown }
  } },
  'err903-blueprint-failure-nothing-kept': { model: true, shell: 'stage', setup: context => seedStageSample(context, { totalChapters: 16 }), run: async ({ page, fake, shoot }) => {
    fake.setScenarioRequestHandler(request => {
      if (request.url !== '/v1/chat/completions') return false
      request.socket.destroy()
      return true
    })
    const notice = await failBlueprints(page)
    await shoot('err903-blueprint-failure-nothing-kept-notice')
    const cardShown = await recoveryCard(page)
    await shoot('err903-blueprint-failure-nothing-kept-card')
    assert.doesNotMatch(notice, /恢复稿/u, '没有生成出内容时不提恢复稿')
    assert.equal(notice, '原有蓝图未改动。蓝图生成失败，请点「AI 生成蓝图」重试。')
    return { notice, cardShown }
  } },
}
