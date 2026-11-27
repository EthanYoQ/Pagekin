import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')
const REVIEW_WRITE_FAILED_EN = 'The draft text was not changed. This review or annotation could not be saved to the project. Try again.'

function withBook(projectRoot, action) {
  const database = new Database(path.join(projectRoot, '.ai-novel', 'project.db'), { fileMustExist: true })
  try {
    action(database)
  } finally {
    database.close()
  }
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

export const M33DBR_SCENARIOS = {
  'm33dbr-review-confirm-write-failed-en': { model: true, shell: 'stage', setup: async context => {
    await seedStageSample(context)
    withBook(context.samplePath, database => database.exec(`CREATE TRIGGER m33dbr_fail BEFORE INSERT ON reviews
      BEGIN SELECT RAISE(ABORT, 'database disk image is malformed'); END;`))
  }, run: async ({ page, shoot }) => {
    await chapterView.open(page, 3)
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    await setInterfaceLocale(page, 'en-US')
    const sheet = page.getByRole('complementary', { name: 'Review report' })
    await sheet.waitFor({ state: 'visible' })
    await chapterView.view(page).getByRole('button', { name: /^Revise with \d+ notes?$/u }).click()
    const alert = sheet.getByRole('alert')
    await alert.waitFor({ state: 'visible' })
    const shown = (await alert.innerText()).trim()
    await shoot('m33dbr-review-confirm-write-failed-en')
    assert.equal(shown, REVIEW_WRITE_FAILED_EN)
    assert.doesNotMatch(shown, /malformed|SqliteError|SQLITE_/u)
    return { shown }
  }, after: ({ samplePath }) => withBook(samplePath, database => database.exec('DROP TRIGGER m33dbr_fail')) },
}
