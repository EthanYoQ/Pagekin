import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as blueprint from './pages/blueprint.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')
const SAVE_FAILED_EN = ['Could not save the blueprint.', 'Could not save the chapter blueprint.']

function withBook(projectRoot, action) {
  const database = new Database(path.join(projectRoot, '.ai-novel', 'project.db'), { fileMustExist: true })
  try {
    return action(database)
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

const chapterTitle = (samplePath, chapterNumber) => withBook(samplePath, database =>
  database.prepare('SELECT title FROM blueprints WHERE chapter_number = ?').get(chapterNumber)?.title)

export const M33DB910_SCENARIOS = {
  'm33db910-blueprint-save-failed-en': { model: false, shell: 'stage', setup: async context => {
    await seedStageSample(context)
    withBook(context.samplePath, database => database.exec(`
      CREATE TRIGGER m33db910_fail_update BEFORE UPDATE ON blueprints BEGIN SELECT RAISE(ABORT, 'database disk image is malformed'); END;
      CREATE TRIGGER m33db910_fail_insert BEFORE INSERT ON blueprints BEGIN SELECT RAISE(ABORT, 'database disk image is malformed'); END;`))
  }, run: async ({ page, shoot, samplePath }) => {
    const before = chapterTitle(samplePath, 3)
    await blueprint.open(page)
    await blueprint.planItem(page, 3).click()
    await blueprint.card(page).waitFor({ state: 'visible' })
    await setInterfaceLocale(page, 'en-US')
    await page.getByRole('textbox', { name: 'Chapter title' }).fill('Tide Gate Rewritten')
    await page.getByRole('button', { name: 'Save chapter' }).click()
    const toast = page.locator('.pi-toast-body').filter({ hasText: 'Could not save the blueprint.' }).first()
    await toast.waitFor({ state: 'visible', timeout: 20_000 })
    const shown = (await toast.locator('p').allInnerTexts()).map(line => line.trim())
    await shoot('m33db910-blueprint-save-failed-en')
    assert.deepEqual(shown, SAVE_FAILED_EN)
    assert.doesNotMatch(shown.join(' '), /malformed|SqliteError|SQLITE_/u)
    assert.equal(chapterTitle(samplePath, 3), before, '第 3 章蓝图标题没有被改')
    return { shown, title: before }
  }, after: ({ samplePath }) => withBook(samplePath, database => database.exec('DROP TRIGGER m33db910_fail_update; DROP TRIGGER m33db910_fail_insert;')) },
}
