import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as architecture from './pages/architecture.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as stage from './pages/stage.mjs'
import { generate } from './prop-rel-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')

function withBook(projectRoot, action) {
  const database = new Database(path.join(projectRoot, '.ai-novel', 'project.db'), { fileMustExist: true })
  try {
    action(database)
  } finally {
    database.close()
  }
}

export const M33GEN1_SCENARIOS = {
  'm33gen1-proposal-approve-failed-en': { model: true, shell: 'stage', setup: context => seedStageSample(context, { totalChapters: 16 }), run: async context => {
    await blueprint.open(context.page)
    context.fake.replyDirectoryBlueprints(13)
    await generate(context.page, context.fake, 13, 14)
    assert.equal((await context.invoke(context.page, 'config:set', { locale: 'en-US' })).success, true)
    await context.reload()
    const { page } = context
    await stage.openFromLibraryEn(page, STAGE_SAMPLE.name)
    await page.getByRole('navigation', { name: 'Writing flow' }).locator('[data-stage="architecture"]').click()
    await architecture.waitReady(page)
    await stage.root(page).getByRole('button', { name: 'Open cast' }).click()
    const suggestions = stage.root(page).getByRole('region', { name: 'Pending character suggestions' })
    await suggestions.waitFor({ state: 'visible', timeout: 20_000 })
    await suggestions.getByRole('button', { name: 'Review blueprint character decision' }).click()
    const accept = suggestions.getByRole('button', { name: 'Accept decisions' })
    await accept.waitFor({ state: 'visible' })
    // 打开作品时会核对库结构，触发器要等作品打开后再加。
    withBook(context.samplePath, database => database.exec(`CREATE TRIGGER m33gen1_fail BEFORE INSERT ON characters
      BEGIN SELECT RAISE(ABORT, 'database disk image is malformed'); END;`))
    await accept.click()
    const shownError = suggestions.getByText(/^Some character suggestions could not be read or handled/u)
    await shownError.waitFor({ state: 'visible', timeout: 30_000 })
    const shown = (await shownError.innerText()).trim()
    await page.waitForTimeout(400)
    await context.shoot('m33gen1-proposal-approve-failed-en')
    assert.equal(shown, 'Some character suggestions could not be read or handled this time. You can read them again.')
    assert.doesNotMatch(await suggestions.innerText(), /malformed|SqliteError|SQLITE_|IPC_HANDLER_FAILED|GENERATION_/u, '英文界面的采纳失败提示不露 SQLite 原文和码')
    return { shown }
  }, after: ({ samplePath }) => withBook(samplePath, database => database.exec('DROP TRIGGER IF EXISTS m33gen1_fail')) },
}
