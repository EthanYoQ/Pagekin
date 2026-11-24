import assert from 'node:assert/strict'

import * as stage from './pages/stage.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import { importMaterials } from './refs-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'

const EMBEDDING_MODEL = Object.freeze({ ...FAKE_MODEL, id: 'm33-embedding', name: '驱动检索模型', modelName: 'text-embedding-3-small', purposes: ['embedding'] })
const GENERIC_SHOWN = '重建检索失败：这次操作没有完成，出了意外问题。请再试一次；还不行，请把这条提示反馈给我们。'

export const M33_SCENARIOS = {
  // electron/ipc/handle.ts 把没登记的失败换成 IPC_HANDLER_FAILED；这里直接让通道交回 handle() 的这个结果，看作者看到的说明。
  'm33-ipc-generic-failure': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke }) => {
    assert.equal((await invoke(page, 'llm:save-model', EMBEDDING_MODEL)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-embedding-model', EMBEDDING_MODEL.id)).success, true)
  } }), run: async context => {
    const { app, page, shoot } = context
    await importMaterials(context)
    await app.evaluate(({ ipcMain }) => {
      ipcMain._invokeHandlers.set('kb:backfill-vectors', async () => ({ success: false, processed: 0, failed: 1, error: 'IPC_HANDLER_FAILED' }))
    })
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '检索模型')
    const index = stage.root(page).getByRole('region', { name: '当前作品的检索索引' })
    await index.getByRole('button', { name: '检查并重建向量索引' }).click()
    const toast = stage.toastStack(page).locator(stage.LIVE_TOAST).filter({ hasText: '重建检索' }).last()
    await toast.waitFor({ state: 'visible', timeout: 15_000 })
    await shoot('m33-ipc-generic-failure')
    const shown = (await toast.innerText()).trim()
    assert.equal(shown, GENERIC_SHOWN)
    assert.doesNotMatch(shown, /IPC_HANDLER_FAILED|[A-Z]{3,}_/u)
    return { shown }
  } },
}
