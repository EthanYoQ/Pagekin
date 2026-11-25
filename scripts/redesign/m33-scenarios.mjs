import assert from 'node:assert/strict'

import * as refs from './pages/refs.mjs'
import * as stage from './pages/stage.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import { importMaterials } from './refs-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'

const EMBEDDING_MODEL = Object.freeze({ ...FAKE_MODEL, id: 'm33-embedding', name: '驱动检索模型', modelName: 'text-embedding-3-small', purposes: ['embedding'] })
const GENERIC_SHOWN = '保存失败：这次操作没有完成，出了意外问题。请再试一次；还不行，请把这条提示反馈给我们。'

export const M33_SCENARIOS = {
  'm33-ipc-generic-failure': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke }) => {
    assert.equal((await invoke(page, 'llm:save-model', EMBEDDING_MODEL)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-embedding-model', EMBEDDING_MODEL.id)).success, true)
  } }), run: async context => {
    const { app, page, shoot } = context
    await importMaterials(context)
    await app.evaluate(({ ipcMain }) => {
      globalThis.__m33Logged = []
      const log = console.error
      console.error = (...args) => {
        globalThis.__m33Logged.push(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
        log(...args)
      }
      const registered = ipcMain._invokeHandlers.get('kb:save-document-copy')
      ipcMain._invokeHandlers.set('kb:save-document-copy', (event, docId, _content, ...rest) => registered(event, docId, null, ...rest))
    })
    await refs.materialButton(page, '守塔人小传').click()
    await refs.copyEditor(page).fill('守塔人姓周，在灯塔守了三十年。')
    await page.keyboard.press('ControlOrMeta+S')
    const toast = stage.toastStack(page).locator(stage.LIVE_TOAST).filter({ hasText: '保存失败' }).last()
    await toast.waitFor({ state: 'visible', timeout: 15_000 })
    await shoot('m33-ipc-generic-failure')
    const shown = (await toast.innerText()).trim()
    assert.equal(shown, GENERIC_SHOWN)
    assert.doesNotMatch(shown, /IPC_HANDLER_FAILED|[A-Z]{3,}_/u)
    const logged = await app.evaluate(() => globalThis.__m33Logged)
    assert.ok(logged.some(line => line.includes('kb:save-document-copy') && line.includes('KNOWLEDGE_BASE_COPY_REQUEST_INVALID')), '主进程日志留下原始失败')
    return { shown, logged: logged.filter(line => line.includes('kb:save-document-copy')) }
  } },
}
