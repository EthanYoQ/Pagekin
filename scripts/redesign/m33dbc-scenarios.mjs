import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as architecture from './pages/architecture.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')
const ROSTER_WRITE_FAILED_EN = 'Could not save the character cards. The character cards were not changed. This change could not be saved to the project. Try again.'

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

export const M33DBC_SCENARIOS = {
  'm33dbc-roster-save-failed-en': { shell: 'stage', setup: async context => {
    await seedStageSample(context)
    withBook(context.samplePath, database => database.exec(`CREATE TRIGGER m33dbc_fail BEFORE INSERT ON character_identity_approvals
      BEGIN SELECT RAISE(ABORT, 'database disk image is malformed'); END;`))
  }, run: async ({ page, shoot }) => {
    await architecture.open(page)
    await architecture.openCast(page)
    await architecture.castRow(page, '林岚').click()
    await setInterfaceLocale(page, 'en-US')
    const background = stage.root(page).getByRole('textbox', { name: /^Background/u })
    await background.fill('林岚在灯塔下长大，记得每一次涨潮。')
    await stage.root(page).getByRole('button', { name: 'Save character' }).click()
    const alert = stage.root(page).locator('.cast-profile-error')
    await alert.waitFor({ state: 'visible', timeout: 20_000 })
    const shown = (await alert.innerText()).trim()
    await shoot('m33dbc-roster-save-failed-en')
    assert.equal(shown, ROSTER_WRITE_FAILED_EN)
    assert.doesNotMatch(shown, /malformed|SqliteError|SQLITE_/u)
    assert.equal(await background.inputValue(), '林岚在灯塔下长大，记得每一次涨潮。', '作者的修改还在编辑框里')
    return { shown }
  }, after: ({ samplePath }) => withBook(samplePath, database => database.exec('DROP TRIGGER m33dbc_fail')) },
}
