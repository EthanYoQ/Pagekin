import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as chapterView from './pages/chapter-view.mjs'
import { seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE, stageChapterTitle } from './stage-sample.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')
const PLAN = { title: '父亲的旧信', type: '伏笔', targetStartChapter: 3, targetEndChapter: 5, authorIntent: '第五章林岚读到父亲的旧信。' }

function withBook(projectRoot, action) {
  const database = new Database(path.join(projectRoot, '.ai-novel', 'project.db'), { fileMustExist: true })
  try {
    action(database)
  } finally {
    database.close()
  }
}

const seed = context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path: projectPath, session }) => {
  const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(), chapters: [3, 4].map(number => {
    const content = STAGE_SAMPLE.drafts[number].text
    return { chapterNumber: number, title: stageChapterTitle(number), content, wordCount: countUnits(content) }
  }) }, projectPath, session)
  assert.equal(imported.success, true, imported.failure?.code)
  const created = await invoke(page, 'db:narrative-thread-plan-create', PLAN, projectPath, session)
  assert.equal(created.success, true, JSON.stringify(created.failure))
} })

export const M33DBT_SCENARIOS = {
  'm33dbt-defer-write-failed': { model: false, shell: 'stage', setup: async context => {
    await seed(context)
    withBook(context.samplePath, database => database.exec(`CREATE TRIGGER m33dbt_fail BEFORE INSERT ON narrative_thread_assignments
      BEGIN SELECT RAISE(ABORT, 'database disk image is malformed'); END;`))
  }, run: async ({ page }) => {
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    const row = popover.getByRole('listitem').filter({ hasText: PLAN.title })
    await chapterView.open(page, 5)
    await chapterView.view(page).getByRole('button', { name: '本章要处理 1 条线索' }).click()
    await row.getByText('本章到期').waitFor({ state: 'visible' })
    await row.getByRole('button', { name: '延后一章' }).click()
    const alert = popover.getByRole('alert')
    await alert.waitFor({ state: 'visible' })
    const shown = (await alert.innerText()).trim()
    assert.equal(shown, '线索还在本章任务里。延后没保存上，再点一次试试。')
    assert.equal(await row.getByText('本章到期').isVisible(), true, '延后没写进去，线索仍是本章到期')
    return { shown, stillDue: true }
  }, after: ({ samplePath }) => withBook(samplePath, database => database.exec('DROP TRIGGER m33dbt_fail')) },
}
