import assert from 'node:assert/strict'

import * as blueprint from './pages/blueprint.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'

const settle = page => page.waitForTimeout(400)

export const ERRC_SCENARIOS = {
  'errc-blueprint-generation-failure-en': { model: true, shell: 'stage', setup: context => seedStageSample(context, { totalChapters: 16 }), run: async ({ page, shoot }) => {
    await blueprint.open(page)
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('en-US')
    await page.keyboard.press('Escape')
    await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })

    await page.getByRole('button', { name: 'Generate blueprints' }).click()
    const dialog = page.getByRole('dialog', { name: 'Generate blueprints' })
    await dialog.getByRole('button', { name: 'Generate', disabled: false }).waitFor({ state: 'visible' })
    await dialog.getByLabel('First blueprint chapter').fill('13')
    await dialog.getByLabel('Last blueprint chapter').fill('16')
    await dialog.getByRole('button', { name: 'Generate' }).click()
    await dialog.waitFor({ state: 'hidden' })
    const warning = page.getByRole('dialog', { name: 'The architecture is incomplete' })
    await warning.or(runSheet.sheet(page)).first().waitFor({ state: 'visible', timeout: 60_000 })
    if (await warning.isVisible()) await warning.getByRole('button', { name: 'Continue' }).click()

    await runSheet.waitUntilOpen(page)
    const failedStep = runSheet.sheet(page).locator('.run-step[data-status="failed"] .run-step-row').first()
    await failedStep.waitFor({ state: 'visible', timeout: 60_000 })
    if (await failedStep.getAttribute('aria-expanded') !== 'true') await failedStep.click()
    const stepNotice = runSheet.sheet(page).locator('.run-step[data-status="failed"] .run-step-error').first()
    await stepNotice.waitFor({ state: 'visible' })
    const observed = {
      stepNotice: await stepNotice.innerText(),
      sheet: await runSheet.sheet(page).innerText(),
      lang: await page.evaluate(() => document.documentElement.lang),
    }
    await settle(page)
    await shoot('errc-blueprint-generation-failure-en')
    assert.equal(observed.lang, 'en-US')
    assert.equal(observed.stepNotice, 'Chapter-blueprint generation failed. Please try again.')
    assert.doesNotMatch(observed.sheet, /code=|reason=|finishReason|[A-Z]+_[A-Z_]+/u, '运行侧页不带 code=、reason= 和裸码')
    return observed
  } },
}
