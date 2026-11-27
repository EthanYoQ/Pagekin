import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')
const toasts = page => page.locator('#ai-novel-ink-toasts')

function withBook(projectRoot, action) {
  const database = new Database(path.join(projectRoot, '.ai-novel', 'project.db'), { fileMustExist: true })
  try {
    action(database)
  } finally {
    database.close()
  }
}

export const M33CHAP_SCENARIOS = {
  'm33chap-reopen-failed-en': { model: false, shell: 'stage', setup: async context => {
    await seedStageSample(context, { landOnChapter3: false })
  }, run: async context => {
    const { invoke } = context
    assert.equal((await invoke(context.page, 'config:set', { locale: 'en-US' })).success, true)
    await context.reload()
    const { page } = context
    await stage.openFromLibraryEn(page, STAGE_SAMPLE.name)
    const spine = page.getByRole('navigation', { name: 'Writing flow' })
    const chapters = spine.getByRole('list', { name: 'Chapters' })
    if (!await chapters.isVisible()) await spine.locator('[data-stage="manuscript"]').click()
    await chapters.getByRole('button', { name: /^2\D/u }).click()
    // 打开作品时会核对库结构，触发器要等作品打开后再加。
    withBook(context.samplePath, database => database.exec(`CREATE TRIGGER m33chap_fail BEFORE INSERT ON drafts_all
      BEGIN SELECT RAISE(ABORT, 'database disk image is malformed'); END;`))
    const view = stage.root(page).locator('.stage-ch')
    await view.getByRole('button', { name: 'Reopen to edit', exact: true }).click()
    await page.getByRole('dialog', { name: 'Reopen chapter 2?' }).getByRole('button', { name: 'Reopen', exact: true }).click()
    const toast = toasts(page).getByText(/^Could not reopen chapter 2:/u)
    await toast.waitFor({ state: 'visible', timeout: 30_000 })
    const shown = (await toast.innerText()).trim()
    await page.waitForTimeout(400)
    await context.shoot('m33chap-reopen-failed-en')
    assert.equal(shown, 'Could not reopen chapter 2: That action did not finish because something unexpected went wrong. Try again; if it keeps happening, send us this message.')
    assert.doesNotMatch(await toasts(page).innerText(), /malformed|SqliteError|SQLITE_/u, '英文界面的重开失败提示不露 SQLite 原文')
    assert.equal(await view.getByRole('button', { name: 'Reopen to edit', exact: true }).isVisible(), true, '重开没写进去，第 2 章仍是定稿')
    return { shown }
  }, after: ({ samplePath }) => withBook(samplePath, database => database.exec('DROP TRIGGER m33chap_fail')) },
}
