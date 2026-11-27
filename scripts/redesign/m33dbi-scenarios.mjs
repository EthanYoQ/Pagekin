import assert from 'node:assert/strict'

import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { referenceNovel } from './f537-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const CHECK_FAILED_EN = 'The import could not continue because a check failed. Try again; if it keeps happening, send us this message.'

async function setInterfaceLocale(page, locale) {
  const settings = /^(设置|Settings)$/u
  const spine = page.getByRole('navigation', { name: /^(创作流程|写作流程|Writing flow)$/u })
  if (await spine.isVisible()) await spine.getByRole('button', { name: settings }).click()
  else await stage.root(page).getByRole('banner').getByRole('button', { name: settings }).click()
  const nav = page.getByRole('navigation', { name: /^(设置分组|Settings sections)$/u })
  await nav.getByRole('button', { name: /^(外观|Appearance)$/u }).click()
  await page.getByLabel(/^(界面语言|Interface language)$/u).selectOption(locale)
  await page.keyboard.press('Escape')
  await nav.waitFor({ state: 'detached' })
}

async function failedStepError(page) {
  const failedStep = runSheet.sheet(page).locator('.run-step[data-status="failed"] .run-step-row').first()
  await failedStep.waitFor({ state: 'visible', timeout: 60_000 })
  if (await failedStep.getAttribute('aria-expanded') !== 'true') await failedStep.click()
  const stepError = runSheet.sheet(page).locator('.run-step[data-status="failed"] .run-step-error').first()
  await stepError.waitFor({ state: 'visible' })
  return stepError.innerText()
}

export const M33DBI_SCENARIOS = {
  'm33dbi-checkpoint-failed-en': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ app, page, roots, shoot }) => {
    await setInterfaceLocale(page, 'en-US')
    const file = referenceNovel(roots, 2)
    assert.ok(await app.evaluate(({ dialog, ipcMain }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
      const handlers = ipcMain._invokeHandlers
      const original = handlers.get('db:import-run-complete-batch')
      if (!original) return false
      handlers.set('db:import-run-complete-batch', (event, runId, _stage, ...rest) => original(event, runId, 'global', ...rest))
      return true
    }, file), '能让导入批次检查点在主进程的处理器里失败')

    await stage.root(page).getByRole('banner').getByRole('button', { name: `“${STAGE_SAMPLE.name}” menu` }).click()
    await page.getByRole('menuitem', { name: 'Novel breakdown & imitation…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Novel analysis and style study' })
    await dialog.getByTestId('import-target-current').click()
    await dialog.getByRole('button', { name: 'Choose', exact: true }).click()
    await dialog.getByRole('button', { name: 'Import into current project (2 chapters)', disabled: false }).click()
    await dialog.waitFor({ state: 'hidden' })

    await runSheet.waitUntilOpen(page)
    const stepError = await failedStepError(page)
    assert.equal(stepError, CHECK_FAILED_EN)

    await setInterfaceLocale(page, 'zh-CN')
    await runSheet.openFromPalette(page)
    const afterSwitch = await failedStepError(page)
    const sheet = await runSheet.sheet(page).innerText()
    await page.waitForTimeout(400)
    await shoot('m33dbi-checkpoint-failed-en-zh-ui')
    assert.equal(afterSwitch, stepError, '界面切到中文后，英文运行的失败说明不变')
    assert.doesNotMatch(sheet, /IMPORT_RUN_|CHECKPOINT_STAGE|Error invoking/u, '运行侧页不露错误码与主进程原文')
    return { stepError, afterSwitch, lang: await page.evaluate(() => document.documentElement.lang) }
  } },
}
