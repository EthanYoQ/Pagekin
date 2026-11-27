import assert from 'node:assert/strict'

import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

export const M33GEN2A_SCENARIOS = {
  'm33gen2a-chapter-generation-failed-en': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ app, page, invoke, reload, shoot }) => {
    assert.equal((await invoke(page, 'config:set', { locale: 'en-US' })).success, true)
    await reload()
    await stage.openFromLibraryEn(page, STAGE_SAMPLE.name)
    // 只伪造入参，让主进程 owner 真实拒绝，失败仍走 handle()。
    assert.ok(await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers
      const original = handlers.get('generation:execute')
      if (!original) return false
      handlers.set('generation:execute', (event, request, context) =>
        original(event, { ...request, handle: { ...request.handle, rootActionId: 'forged-root' } }, context))
      return true
    }), '能在主进程里改写 generation:execute 的句柄')
    const spine = page.getByRole('navigation', { name: 'Writing flow' })
    await spine.getByRole('button', { name: /^Blueprint/ }).click()
    await page.getByRole('button', { name: /^Write chapter \d+$/ }).click()
    await runSheet.waitUntilOpen(page)
    const failed = runSheet.lastRun(page)
    await failed.waitFor({ state: 'visible', timeout: 60_000 })
    await failed.getByText(/did not finish/u).first().waitFor({ state: 'visible', timeout: 30_000 })
    const shown = (await failed.innerText()).trim()
    await page.waitForTimeout(400)
    await shoot('m33gen2a-chapter-generation-failed-en')
    assert.doesNotMatch(shown, /Error invoking|generation:|[A-Z][A-Z0-9]*_[A-Z0-9_]+/u, '英文界面的生成失败卡片不露 IPC 前缀和码')
    assert.match(shown, /something unexpected went wrong/u)
    return { shown }
  } },
}
