import assert from 'node:assert/strict'

import { characterStateReply, finalizeChapter } from './f491-scenarios.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import { seedStageSample } from './scenarios.mjs'

// #702：后处理步骤记下了步骤表之外的失败原因（已登记的码，裸码或带 IPC 包装），重开本章后按报错目录说明。
const STORED = {
  chapter_notes: "Error invoking remote method 'project-session:invoke': Error: GENERATION_KNOWLEDGE_BUSY",
  character_cards: 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE',
}

async function trackOpenedSession(app) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('project:open')
    handlers.set('project:open', async (event, projectPath, ...rest) => {
      const result = await original(event, projectPath, ...rest)
      if (result?.success) globalThis.__driveOpened = { projectId: result.project.id, projectPath, leaseId: result.project.sessionLease }
      return result
    })
  })
}

export const PP702_SCENARIOS = {
  'pp702-unlisted-step-error': { model: true, shell: 'stage', setup: async context => {
    await trackOpenedSession(context.app)
    await seedStageSample(context)
  }, run: async context => {
    const { app, page, invoke, shoot } = context
    context.fake.replyCharacterState(characterStateReply)
    await finalizeChapter(page, 3)
    const session = await app.evaluate(() => globalThis.__driveOpened)
    const call = (channel, ...args) => invoke(page, channel, ...args, context.samplePath, session)
    const run = await call('db:post-process-get-latest-run', 'chapter_finalize', '3')
    assert.ok(run?.id, '第 3 章有后处理记录')
    for (const [stepKey, error] of Object.entries(STORED)) {
      const marked = await call('db:post-process-mark-step-failed', run.id, stepKey, error)
      assert.equal(marked.success, true, marked.error)
    }
    await chapterView.open(page, 4)
    await chapterView.open(page, 3)
    const failed = chapterView.postProcess(page).locator('li[data-state="failed"]')
    await failed.nth(1).waitFor({ state: 'visible', timeout: 60_000 })
    const rows = await failed.evaluateAll(items => items.map(item => ({
      label: item.querySelector('b')?.textContent, detail: item.querySelector('.stage-ch-post-detail')?.textContent ?? '',
    })))
    await chapterView.postProcess(page).scrollIntoViewIfNeeded()
    await shoot('pp702-unlisted-step-error')
    for (const row of rows) assert.doesNotMatch(row.detail, /[A-Z]+_[A-Z_]+|Error invoking/u, `${row.label}：失败说明不是原始错误码`)
    return { rows }
  } },
}
