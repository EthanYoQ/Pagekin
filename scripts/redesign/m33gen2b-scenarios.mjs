import assert from 'node:assert/strict'

import * as stage from './pages/stage.mjs'
import { seedKeeperRelation } from './c6-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const FALLBACK = 'Your blueprints are unchanged. The check did not finish. Choose AI check again.'
const checkReply = prompt => prompt.includes('"timeline":[') ? '{"findings":[]}' : null
const checkRequests = fake => fake.requests.filter(kind => kind === 'review').length

export const M33GEN2B_SCENARIOS = {
  'm33gen2b-blueprint-check-failed-en': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: seedKeeperRelation }),
    run: async ({ app, page, invoke, reload, shoot, fake }) => {
      assert.equal((await invoke(page, 'config:set', { locale: 'en-US' })).success, true)
      await reload()
      await stage.openFromLibraryEn(page, STAGE_SAMPLE.name)
      fake.replyReview(checkReply)
      // 只伪造入参，让主进程 owner 真实拒绝，失败仍走 handle()。
      assert.ok(await app.evaluate(({ ipcMain }) => {
        const handlers = ipcMain._invokeHandlers
        const original = handlers.get('graph-generation:execute')
        if (!original) return false
        globalThis.__m33gen2bExecute = original
        globalThis.__m33gen2bCalls = 0
        handlers.set('graph-generation:execute', (event, request, context) => {
          globalThis.__m33gen2bCalls++
          return original(event, { ...request, handle: { ...request.handle, rootActionId: 'forged-root' } }, context)
        })
        return true
      }), '能在主进程里改写 graph-generation:execute 的句柄')
      const requestsBefore = checkRequests(fake)
      const spine = page.getByRole('navigation', { name: 'Writing flow' })
      await spine.getByRole('button', { name: /^Blueprint/ }).click()
      await page.getByRole('button', { name: 'AI check', exact: true }).click()
      const shown = stage.root(page).getByText(FALLBACK, { exact: true })
      await shown.waitFor({ state: 'visible', timeout: 30_000 })
      await page.waitForTimeout(400)
      await shoot('m33gen2b-blueprint-check-failed-en')
      const body = await page.locator('body').innerText()
      assert.doesNotMatch(body, /Error invoking|graph-generation:|[A-Z][A-Z0-9]*_[A-Z0-9_]+/u, '英文界面的蓝图检查失败不露 IPC 前缀和码')
      assert.doesNotMatch(body, /something unexpected went wrong/u, '显示这里的兜底句，不是通用句')
      const executeCalls = await app.evaluate(() => globalThis.__m33gen2bCalls)
      assert.equal(executeCalls, 1, '伪造句柄的 execute 到达主进程一次，兜底句来自它被拒')
      const checkRequestsSent = checkRequests(fake) - requestsBefore
      assert.equal(checkRequestsSent, 0, '被拒的检查没有发出模型请求')
      return { shown: FALLBACK, executeCalls, checkRequestsSent }
    }, after: async ({ app, fake }) => {
      fake.replyReview(null)
      await app.evaluate(({ ipcMain }) => {
        ipcMain._invokeHandlers.set('graph-generation:execute', globalThis.__m33gen2bExecute)
        delete globalThis.__m33gen2bExecute
        delete globalThis.__m33gen2bCalls
      })
    } },
}
