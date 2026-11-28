import assert from 'node:assert/strict'

import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { holdBlueprintDispatch, importRoot, readDb, referenceNovel, writeDb } from './f537-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

// 845 PR-F：导入停下的说明按运行开始时的界面语言写，停下后切换界面语言不改变已有说明。

const LABELS = {
  zh: { menu: `《${STAGE_SAMPLE.name}》作品菜单`, item: '小说拆解与仿写…', dialog: '小说拆解与仿写', choose: '选择', start: chapters => `导入当前项目（${chapters} 章）` },
  en: { menu: `“${STAGE_SAMPLE.name}” menu`, item: 'Novel breakdown & imitation…', dialog: 'Novel analysis and style study', choose: 'Choose', start: chapters => `Import into current project (${chapters} chapters)` },
}

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

async function startImport(app, page, file, chapters, labels) {
  assert.ok(await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    return true
  }, file))
  await stage.root(page).getByRole('banner').getByRole('button', { name: labels.menu }).click()
  await page.getByRole('menuitem', { name: labels.item, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: labels.dialog })
  await dialog.getByTestId('import-target-current').click()
  await dialog.getByRole('button', { name: labels.choose, exact: true }).click()
  await dialog.getByRole('button', { name: labels.start(chapters), disabled: false }).click()
  await dialog.waitFor({ state: 'hidden' })
}

async function failedStepError(page) {
  const failedStep = runSheet.sheet(page).locator('.run-step[data-status="failed"] .run-step-row').first()
  await failedStep.waitFor({ state: 'visible', timeout: 90_000 })
  if (await failedStep.getAttribute('aria-expanded') !== 'true') await failedStep.click()
  const stepError = runSheet.sheet(page).locator('.run-step[data-status="failed"] .run-step-error').first()
  await stepError.waitFor({ state: 'visible' })
  return stepError.innerText()
}

async function stopOnActiveTime(context, lang, chapters = 15) {
  const { app, page, roots, fake } = context
  if (lang === 'en') await setInterfaceLocale(page, 'en-US')
  fake.replyImport()
  const hold = await holdBlueprintDispatch(app, 2)
  await startImport(app, page, referenceNovel(roots, chapters), chapters, LABELS[lang])
  try {
    await hold.waitHeld()
    writeDb(context, db => {
      const root = importRoot(db)
      db.prepare('UPDATE generation_roots SET active_elapsed_ms=? WHERE root_action_id=?').run(JSON.parse(root.budget_json).maxActiveElapsedMs - 300, root.root_action_id)
    })
    fake.gate.hold()
  } finally {
    await hold.release()
  }
  await runSheet.waitUntilOpen(page)
  let stepError
  try { stepError = await failedStepError(page) } finally { fake.gate.release() }
  assert.equal(readDb(context, importRoot).blocked_code, 'ROOT_BUDGET_EXHAUSTED')
  assert.doesNotMatch(stepError, /[A-Z]{3,}_[A-Z]/u, '运行卡片的说明不露错误码')
  return stepError
}

export const ERRF_SCENARIOS = {
  'errf-stop-zh': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const stepError = await stopOnActiveTime(context, 'zh')
    await context.page.waitForTimeout(400)
    await context.shoot('errf-stop-zh-card')
    assert.match(stepError, /模型请求累计时长已到上限/u, stepError)
    assert.match(stepError, /在导入对话框里点「继续导入」，已提交的批次不会重做/u, stepError)
    return { stepError }
  } },
  'errf-stop-en': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const { page, shoot } = context
    const stepError = await stopOnActiveTime(context, 'en')
    await page.waitForTimeout(400)
    await shoot('errf-stop-en-card')
    assert.match(stepError, /This import used up its time allowance for model requests/u, stepError)
    assert.doesNotMatch(stepError, /\p{Script=Han}/u, '英文运行的说明不含中文')

    await setInterfaceLocale(page, 'zh-CN')
    const lang = await page.evaluate(() => document.documentElement.lang)
    assert.equal(lang, 'zh-CN', '界面已切到中文')
    await runSheet.openFromPalette(page)
    const afterSwitch = await failedStepError(page)
    await page.waitForTimeout(400)
    await shoot('errf-stop-en-card-zh-ui')
    assert.equal(afterSwitch, stepError, '界面切到中文后，英文运行的停下说明不变')
    return { stepError, afterSwitch, lang }
  } },
}
