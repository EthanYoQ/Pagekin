import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'
import * as blueprint from './pages/blueprint.mjs'

/** 保存通道照旧版 Agent 子稿的样子失败：主进程对这种运行报的就是这个码。 */
const legacyAgentSave = app => app.evaluate(({ ipcMain }) => {
  ipcMain._invokeHandlers.set('generation:commit-draft', async () => { throw new Error('GENERATION_AGENT_SOURCE_CHANGED') })
})

export const AL702_SCENARIOS = {
  /**
   * #702：旧版 Agent 留下的写稿恢复稿保存时，主进程报 GENERATION_AGENT_SOURCE_CHANGED（v1.2.x Preview 的书，见 agent-generation.test.ts）。
   * 当前代码已造不出这种运行，场景把保存通道换成抛这个码，第 3 章写完存不进去，留下候选，看作者在运行侧页读到的说明。
   */
  'al702-agent-legacy-draft': { model: true, shell: 'stage', setup: context => seedStageSample(context, { landOnChapter3: false,
    beforeReload: async ({ page, invoke, path: projectPath, session }) => {
      for (const draft of await invoke(page, 'db:draft-list', 3, projectPath, session))
        if (!(await invoke(page, 'db:draft-delete', draft.id, projectPath, session)).success) throw new Error('删不掉第 3 章草稿')
    } }), run: async context => {
    const { shoot } = context
    let page = context.page
    await legacyAgentSave(context.app)
    await blueprint.open(page)
    await blueprint.writeNext(page)
    await runSheet.waitUntilOpen(page)
    await runSheet.anyCard(page).filter({ hasText: /^上一次运行/ }).getByText(/失败|出错|未完成/).first().waitFor({ state: 'visible', timeout: 60_000 })
    await context.restart()
    page = context.page
    await stage.openAfterRestart(page, STAGE_SAMPLE.name)
    await legacyAgentSave(context.app)
    await runSheet.openFromPalette(page)
    const card = runSheet.recovery(page).getByRole('article').filter({ hasText: /第3章候选/ })
    await card.waitFor({ state: 'visible', timeout: 30_000 })
    await card.getByRole('button', { name: '确认继续已选正文' }).click()
    const failure = runSheet.sheet(page).getByText(/旧版 Agent/).first()
    await failure.waitFor({ state: 'visible', timeout: 60_000 })
    await failure.scrollIntoViewIfNeeded()
    await shoot('al702-agent-legacy-draft-failed')
    return { message: await failure.innerText() }
  } },
}
