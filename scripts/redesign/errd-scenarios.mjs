import assert from 'node:assert/strict'

import * as arch from './pages/architecture.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { seedArch } from './arch-scenarios.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import { untilGateHolds } from './scenarios.mjs'

const settle = page => page.waitForTimeout(400)

export const ERRD_SCENARIOS = {
  // 英文界面下情节大纲途中改模型设置：失败卡给出「去架构页重新生成」，说明全英文、不露码。
  'errd-outline-model-change-en': { model: true, shell: 'stage', setup: seedArch({ clear: ['synopsis'], totalChapters: 24 }), run: async ({ page, invoke, fake, shoot }) => {
    await arch.open(page)
    await arch.primary(page).click()
    await arch.selectOnly(page, ['synopsis'])
    await arch.setRange(page, 1, 5)
    await arch.startGenerate(page)
    if (await runSheet.tab(page, '进行中').waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) await runSheet.waitForRunDone(page, 120_000)
    await arch.badge(page, 'synopsis').filter({ hasText: '部分完成 · 5 / 24 章' }).waitFor({ timeout: 30_000 })
    if (await runSheet.sheet(page).count() > 0) await page.keyboard.press('Escape')

    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('en-US')
    await page.keyboard.press('Escape')
    await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })

    await stage.root(page).getByRole('button', { name: 'Continue from ch. 6' }).click()
    const dialog = page.getByRole('dialog', { name: 'Generate architecture' })
    await dialog.getByRole('spinbutton', { name: 'First chapter of this batch' }).fill('6')
    await dialog.getByRole('spinbutton', { name: 'Last chapter of this batch' }).fill('10')
    fake.gate.hold()
    await dialog.getByRole('button', { name: /^Generate \d+$/ }).click()
    await dialog.waitFor({ state: 'hidden' })
    await untilGateHolds(fake.gate, 60_000)
    assert.equal((await invoke(page, 'llm:save-model', { ...FAKE_MODEL, modelName: 'gpt-4.1-mini' })).success, true)
    fake.gate.release()

    const last = runSheet.lastRun(page)
    await last.getByRole('button', { name: 'Open Architecture' }).waitFor({ state: 'visible', timeout: 60_000 })
    const notice = await last.locator('.pi-notice-body').innerText()
    await settle(page)
    await shoot('errd-outline-model-change-en')
    assert.match(notice, /The model settings were changed during generation, so this outline batch stopped at chapter 7 without sending another request\./)
    assert.match(notice, /Chapter 6, already generated in this batch, is kept in the outline recovery draft/)
    assert.match(notice, /Open Architecture and generate the plot outline again from chapter 6\./)
    assert.doesNotMatch(notice, /\p{Script=Han}/u, '英文界面的失败说明不夹中文（卡头的模型名是夹具数据，不在说明里）')
    assert.doesNotMatch(notice, /GENERATION_SOURCE_CHANGED|[A-Z]+_[A-Z_]+|Error invoking remote method/u, '不露码')
    assert.equal(await last.getByRole('button', { name: 'Continue the plot outline', exact: true }).count(), 0, '不提供必然被拒的断点续写')
    return { notice }
  } },
}
