import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')
const DELETE_FAILED_EN = ['Delete failed', 'Your saved drafts are all still there. This change did not finish saving. Try again.']

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

const chapterDrafts = (samplePath, chapterNumber) => withBook(samplePath, database =>
  database.prepare('SELECT id FROM drafts_all WHERE chapter_number = ? ORDER BY id').all(chapterNumber).map(row => row.id))

export const M33DB7_SCENARIOS = {
  'm33db7-draft-delete-failed-en': { shell: 'stage', setup: async context => {
    await seedStageSample(context)
    withBook(context.samplePath, database => database.exec(`CREATE TRIGGER m33db7_fail BEFORE DELETE ON drafts_all
      BEGIN SELECT RAISE(ABORT, 'database disk image is malformed'); END;`))
  }, run: async ({ page, shoot, samplePath }) => {
    const before = chapterDrafts(samplePath, 3)
    await chapterView.open(page, 3)
    await setInterfaceLocale(page, 'en-US')
    await chapterView.view(page).getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'Delete this draft…' }).click()
    await page.getByRole('dialog', { name: /^Delete chapter 3 v\d+\?$/iu }).getByRole('button', { name: 'Delete this draft', exact: true }).click()
    const toast = page.locator('.pi-toast-body').filter({ hasText: 'Delete failed' }).first()
    await toast.waitFor({ state: 'visible', timeout: 20_000 })
    const shown = (await toast.locator('p').allInnerTexts()).map(line => line.trim())
    await shoot('m33db7-draft-delete-failed-en')
    assert.deepEqual(shown, DELETE_FAILED_EN)
    assert.doesNotMatch(shown.join(' '), /malformed|SqliteError|SQLITE_/u)
    assert.deepEqual(chapterDrafts(samplePath, 3), before, '第 3 章的各稿都还在')
    return { shown, drafts: before.length }
  }, after: ({ samplePath }) => withBook(samplePath, database => database.exec('DROP TRIGGER m33db7_fail')) },
}
