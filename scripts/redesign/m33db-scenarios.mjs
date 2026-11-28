import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as runSheet from './pages/run-sheet.mjs'
import { seedWithCandidate } from './run-scenarios.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')
const CARD = '原始候选 · 第5章 潮汐表'

function withBook(projectRoot, action) {
  const database = new Database(path.join(projectRoot, '.ai-novel', 'project.db'), { fileMustExist: true })
  try {
    return action(database)
  } finally {
    database.close()
  }
}

export const M33DB_SCENARIOS = {
  'm33db-discard-write-failed': { model: false, shell: 'stage', setup: async context => {
    await seedWithCandidate(context)
    withBook(context.samplePath, database => database.exec(`CREATE TRIGGER m33db_fail BEFORE UPDATE ON recovery_candidates
      BEGIN SELECT RAISE(ABORT, 'database disk image is malformed'); END;`))
  }, run: async ({ page, samplePath }) => {
    await runSheet.openFromPalette(page)
    const card = runSheet.recovery(page).getByRole('article', { name: CARD })
    await card.waitFor({ state: 'visible' })
    const candidates = () => withBook(samplePath, database => database.prepare('SELECT * FROM recovery_candidates ORDER BY rowid').all())
    const before = candidates()
    await card.getByRole('button', { name: '放弃…' }).click()
    await card.getByRole('group').getByRole('button', { name: '放弃', exact: true }).click()
    const alert = runSheet.recovery(page).getByRole('alert')
    await alert.waitFor({ state: 'visible' })
    const shown = (await alert.innerText()).trim()
    assert.equal(shown, '原来的内容没有改动。恢复稿没能写进作品，请再试一次。')
    const cardsListed = await card.count()
    assert.equal(cardsListed, 1, '写入失败后恢复稿仍列着')
    assert.deepEqual(candidates(), before, '放弃没写进库，恢复稿记录不变')
    return { shown, cardsListed, candidates: before.length }
  }, after: ({ samplePath }) => withBook(samplePath, database => database.exec('DROP TRIGGER m33db_fail')) },
}
