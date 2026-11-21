import assert from 'node:assert/strict'

import { recoveryListed } from './i686-scenarios.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const deleteChapter3Drafts = async ({ invoke, page, path: projectPath, session }) => {
  for (const draft of await invoke(page, 'db:draft-list', 3, projectPath, session))
    assert.equal((await invoke(page, 'db:draft-delete', draft.id, projectPath, session)).success, true)
}

/** 第 3 章正文流完、保存前应用被结束：重开后「可恢复」里是第 3 章候选，正文片段可勾选继续。 */
async function leaveDraftCandidate(context) {
  const { fake } = context
  fake.streamProse({ chunks: Array.from({ length: 4 }, (_, index) => `雾钟第${index + 1}次提前响起，林岚记下潮位。`), intervalMs: 1500 })
  await blueprint.open(context.page)
  await blueprint.writeNext(context.page)
  for (const deadline = Date.now() + 60_000; fake.streamLog.length < 4; await context.page.waitForTimeout(100))
    assert.ok(Date.now() < deadline, '60 秒内正文没有流完')
  fake.gate.hold()
  for (const deadline = Date.now() + 30_000; fake.gate.waiting === 0; await context.page.waitForTimeout(100))
    assert.ok(Date.now() < deadline, '正文流完后 30 秒内没有发出下一次请求')
  await context.restart({ killed: true, beforeLaunch: () => new Promise(resolve => setTimeout(resolve, 3000)) })
  fake.gate.release()
  fake.streamProse({ chunks: ['雾钟又响了一次。'], intervalMs: 10 })
  await stage.openAfterRestart(context.page, STAGE_SAMPLE.name)
}

async function renameChapter3Blueprint(page) {
  await blueprint.open(page)
  await blueprint.planItem(page, 3).click()
  await blueprint.titleInput(page).fill('雾钟改名')
  await stage.saveWithCtrlS(page)
}

async function switchToEnglish(page) {
  await stage.openSettings(page)
  await stage.showSettingsPage(page, '外观')
  await page.getByLabel('界面语言').selectOption('en-US')
  await page.keyboard.press('Escape')
  await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })
}

async function continueCandidate(page, { card, confirm }) {
  const entry = runSheet.recovery(page).getByRole('article').filter({ hasText: card })
  await entry.getByRole('checkbox', { disabled: false }).first().check()
  await entry.getByRole('button', { name: confirm }).click()
}

const ZH = { card: /第3章候选/, confirm: '确认继续已选正文' }
const EN = { card: /Chapter 3 candidate/, confirm: 'Confirm selected draft continuation' }

const blocked = (labels, english) => async context => {
  await leaveDraftCandidate(context)
  const { app, page } = context
  await renameChapter3Blueprint(page)
  await recoveryListed(app, page)
  if (english) await switchToEnglish(page)
  await continueCandidate(page, labels)
  const alert = runSheet.recovery(page).getByRole('alert')
  await alert.waitFor({ state: 'visible', timeout: 30_000 })
  const shown = await alert.innerText()
  await context.shoot(english ? 'ru702-blueprint-continue-en' : 'ru702-blueprint-continue')
  return { shown }
}

export const RU702_SCENARIOS = {
  /** #702：第 3 章恢复稿生成后改了第 3 章蓝图，再点「确认继续已选正文」：说明恢复稿没法继续、作品没改、来源有了变化，叫作者先复制再点「不再恢复」。修复前是「出了意外问题，暂时说不清原因。请再试一次。」 */
  'ru702-blueprint-continue': { model: true, shell: 'stage', setup: context => seedStageSample(context, { landOnChapter3: false, beforeReload: deleteChapter3Drafts }),
    run: async context => {
      const measured = await blocked(ZH, false)(context)
      assert.equal(measured.shown, '这份恢复稿没法继续，作品没有改动。它生成之后，所依据的蓝图、设定、前文或模型设置等有了变化。需要的内容先复制，再点「不再恢复」。')
      return measured
    } },
  'ru702-blueprint-continue-en': { model: true, shell: 'stage', setup: context => seedStageSample(context, { landOnChapter3: false, beforeReload: deleteChapter3Drafts }),
    run: async context => {
      const measured = await blocked(EN, true)(context)
      assert.match(measured.shown, /^This recovery draft can’t continue, and your book is unchanged\..*“Dismiss”\.$/u)
      assert.doesNotMatch(measured.shown, /\p{Script=Han}|GENERATION_/u)
      return measured
    } },
  /** 同一份恢复稿，来源没改：点「确认继续已选正文」照常沿原候选继续写，上一次运行是「第 3 章 · 继续正文」，「可恢复」里没有报错。 */
  'ru702-unchanged-continue': { model: true, shell: 'stage', setup: context => seedStageSample(context, { landOnChapter3: false, beforeReload: deleteChapter3Drafts }),
    run: async context => {
      await leaveDraftCandidate(context)
      const { app, page, fake } = context
      const before = fake.requests.length
      await recoveryListed(app, page)
      await continueCandidate(page, ZH)
      await runSheet.lastRun(page).filter({ hasText: /第 3 章\s*\S\s*继续正文/ }).waitFor({ state: 'visible', timeout: 60_000 })
      assert.equal(await runSheet.recovery(page).getByRole('alert').count(), 0, '来源没改时不报错')
      assert.ok(fake.requests.length > before, '继续后又向模型发了请求')
      await context.shoot('ru702-unchanged-continue')
      return { requestsAfterContinue: fake.requests.length - before }
    } },
}
