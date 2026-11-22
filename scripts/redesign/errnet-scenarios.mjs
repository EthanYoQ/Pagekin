import assert from 'node:assert/strict'

import { runsStarted, waitRunDone } from './i686-scenarios.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import { seedStageSample } from './scenarios.mjs'

/** refuse：响应头之前断开；cut：回 200 和半句正文后断开。 */
function breakChats(fake, mode) {
  fake.setScenarioRequestHandler((request, response) => {
    if (request.url !== '/v1/chat/completions') return false
    if (mode === 'refuse') {
      request.socket.destroy()
      return true
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '雾散开一层，' }, finish_reason: null }] })}\n\n`)
    setTimeout(() => response.destroy(), 200)
    return true
  })
}

async function failureNotice(page) {
  const notice = runSheet.lastRun(page).locator('.pi-notice[data-tone="danger"]')
  await notice.waitFor({ state: 'visible', timeout: 90_000 })
  return (await notice.innerText()).trim()
}

const deleteChapter3Drafts = async ({ page, invoke, path: projectPath, session }) => {
  for (const draft of await invoke(page, 'db:draft-list', 3, projectPath, session)) {
    assert.equal((await invoke(page, 'db:draft-delete', draft.id, projectPath, session)).success, true)
  }
}

export const ERRNET_SCENARIOS = {
  /** #702：连不上（响应头前断开）。 */
  'errnet-unreachable': { model: true, shell: 'stage', setup: context => seedStageSample(context, { landOnChapter3: false, beforeReload: deleteChapter3Drafts }),
    run: async context => {
      const { page, fake, shoot } = context
      breakChats(fake, 'refuse')
      await blueprint.open(page)
      await blueprint.writeNext(page)
      await runSheet.waitUntilOpen(page)
      const shown = await failureNotice(page)
      await shoot('errnet-unreachable')
      assert.match(shown, /没连上模型服务/u, '连不上时说明是没连上')
      assert.doesNotMatch(shown, /AI 未正常完成生成|fetch failed|NETWORK_ERROR|UND_ERR/u, '不再只写笼统原因，也不露原码')
      return { shown }
    } },
  /** #702：修稿回复中途断开。 */
  'errnet-interrupted': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const { page, fake, shoot } = context
    await chapterView.open(page, 4)
    const reviewing = await runsStarted(page)
    await chapterView.review(page)
    await waitRunDone(page, reviewing)
    const started = await runsStarted(page)
    breakChats(fake, 'cut')
    await chapterView.reviseButton(page).click()
    await waitRunDone(page, started)
    await runSheet.openFromPalette(page)
    const shown = await failureNotice(page)
    await shoot('errnet-interrupted')
    assert.match(shown, /中途断了/u, '回复中途断开时说明是连接中断')
    assert.doesNotMatch(shown, /AI 未正常完成生成|NETWORK_ERROR|UND_ERR/u, '不再只写笼统原因，也不露原码')
    return { shown }
  } },
}
