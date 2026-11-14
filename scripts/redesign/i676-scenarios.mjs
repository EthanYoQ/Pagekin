// #676 实机场景：正文页版本菜单的每一项是两行（版本名、字数与时间），两行都要落在这一项的高亮底里。
import assert from 'node:assert/strict'

import * as chapterView from './pages/chapter-view.mjs'
import { seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE } from './stage-sample.mjs'

const secondDraft = `${STAGE_SAMPLE.drafts[4].text}\n\n这是改写的第二稿，林岚决定先不问钟的事。`

const seedTwoDrafts = context => seedStageSample(context, { beforeReload: async ({ page, invoke, path, session }) => {
  const created = await invoke(page, 'db:draft-create', { chapterNumber: 4, version: 2, source: 'rewrite', content: secondDraft, wordCount: countUnits(secondDraft) }, path, session)
  assert.equal(created.success, true, created.error)
} })

const openVersionMenu = async (page, { hoverSecond }) => {
  await chapterView.open(page, 4)
  await chapterView.versionButton(page).click()
  const rows = page.getByRole('menu', { name: '本章版本' }).getByRole('menuitemradio')
  assert.equal(await rows.count(), 2)
  if (hoverSecond) await rows.nth(1).hover()
  else await page.mouse.move(4, 4)
  const measured = await rows.evaluateAll(items => items.map(item => {
    const box = item.getBoundingClientRect()
    const style = getComputedStyle(item)
    return { text: item.innerText.split('\n'), height: Math.round(box.height), background: style.backgroundColor,
      inside: [...item.children].every(line => { const rect = line.getBoundingClientRect(); return rect.top >= box.top && rect.bottom <= box.bottom }) }
  }))
  assert.ok(measured.every(row => row.inside), JSON.stringify(measured))
  return { rows: measured }
}

export const I676_SCENARIOS = {
  'i676-version-menu': { model: false, shell: 'stage', setup: seedTwoDrafts, run: ({ page }) => openVersionMenu(page, { hoverSecond: true }) },
  'i676-version-menu-idle': { model: false, shell: 'stage', setup: seedTwoDrafts, run: ({ page }) => openVersionMenu(page, { hoverSecond: false }) },
  'i676-tab-menu': { model: false, shell: 'stage', setup: seedTwoDrafts, run: async ({ page }) => {
    await chapterView.open(page, 4)
    await page.getByRole('button', { name: '标签操作' }).click()
    const items = page.getByRole('menu', { name: '标签操作' }).getByRole('menuitem')
    await items.nth(1).hover()
    return { items: await items.allInnerTexts() }
  } },
}
