import assert from 'node:assert/strict'

import * as architecture from './pages/architecture.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const spine = page => page.getByRole('navigation', { name: 'Writing flow' })

const japaneseSample = context => seedStageSample(context, { open: false, beforeReload: async ({ page, invoke }) => {
  assert.equal((await invoke(page, 'config:set', { locale: 'ja-JP' })).success, true)
} })

async function openSample(page) {
  await stage.openFromLibraryEn(page, STAGE_SAMPLE.name)
  await spine(page).waitFor({ state: 'visible', timeout: 20_000 })
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'ja-JP')
}

async function openGenerateDialog(page) {
  await spine(page).getByRole('button', { name: /^Architecture/ }).click()
  await architecture.waitReady(page)
  const next = stage.root(page).locator('.arch-header').getByRole('button', { name: /^Next: chapter blueprint/ })
  if (await next.isEnabled()) {
    await stage.root(page).getByRole('button', { name: 'More for architecture' }).click()
    await page.getByRole('menuitem', { name: 'Generate with AI…' }).click()
  } else await architecture.primary(page).click()
  const dialog = page.getByRole('dialog', { name: 'Generate architecture' })
  await dialog.waitFor({ state: 'visible' })
  return dialog
}

async function selectOnly(dialog, key) {
  for (const step of ['premise', 'characters', 'worldbuilding', 'synopsis']) {
    const box = dialog.locator(`[data-step="${step}"] input[type="checkbox"]`)
    if (await box.isChecked() !== (step === key)) await dialog.locator(`[data-step="${step}"] label.pi-check`).click()
  }
}

export const ERR939_SCENARIOS = {
  'err939-arch-guard-ja': { model: false, shell: 'stage', setup: japaneseSample, run: async context => {
    const { page, shoot } = context
    await openSample(page)
    const dialog = await openGenerateDialog(page)

    await selectOnly(dialog, 'characters')
    await dialog.getByRole('button', { name: /^Generate \d+$/u }).click()
    const guard = dialog.locator('.arch-guard')
    await guard.waitFor({ state: 'visible', timeout: 20_000 })
    const observed = { characters: await guard.innerText() }
    await page.waitForTimeout(400)
    await shoot('err939-arch-characters-ja')

    await selectOnly(dialog, 'synopsis')
    await dialog.getByRole('spinbutton', { name: 'First chapter of this batch' }).fill('1')
    await dialog.getByRole('spinbutton', { name: 'Last chapter of this batch' }).fill('11')
    const alert = dialog.getByRole('alert')
    await alert.waitFor({ state: 'visible' })
    observed.range = await alert.innerText()
    await page.waitForTimeout(400)
    await shoot('err939-arch-range-ja')

    assert.equal(observed.characters, '章のブループリントがすでにあるため、人物カードを再生成できません。再生成すると、既存のブループリントと執筆済みの章が使えなくなります。\n\n人物を変えるには、人物カードを直接編集してください。')
    assert.equal(observed.range, `プロットのアウトラインの範囲が無効です。第1–${STAGE_SAMPLE.totalChapters}章の中から、連続する1–10章を選んでください。`)
    return observed
  } },

}
