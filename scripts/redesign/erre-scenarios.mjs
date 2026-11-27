import assert from 'node:assert/strict'

import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

export const ERRE_SCENARIOS = {
  // 英文界面写下一章，假模型的正文回复以 content_filter 结束：失败说明全英文、不露码。
  'erre-draft-content-filter-en': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, invoke, reload, fake, shoot }) => {
    fake.failProse()
    assert.equal((await invoke(page, 'config:set', { locale: 'en-US' })).success, true)
    await reload()
    await stage.openFromLibraryEn(page, STAGE_SAMPLE.name)
    await page.getByRole('navigation', { name: 'Writing flow' }).getByRole('button', { name: /^Blueprint/ }).click()
    await page.getByRole('button', { name: /^Write chapter \d+$/ }).click()
    await runSheet.waitUntilOpen(page)
    const last = runSheet.lastRun(page)
    await last.waitFor({ state: 'visible', timeout: 90_000 })
    await page.waitForTimeout(400)
    const notice = await last.locator('.pi-notice-body').innerText()
    await shoot('erre-draft-content-filter-en')
    assert.match(notice, /The model safety policy filtered this output\./)
    assert.doesNotMatch(notice, /\p{Script=Han}/u, '英文界面的失败说明不夹中文（卡头的模型名是夹具数据，不在说明里）')
    assert.doesNotMatch(notice, /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|Error invoking remote method/u, '不露码')
    return { notice }
  } },
}
