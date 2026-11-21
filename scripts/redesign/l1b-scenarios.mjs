import assert from 'node:assert/strict'

import * as stage from './pages/stage.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import { importMaterials } from './refs-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'

const EMBEDDING_MODEL = Object.freeze({ ...FAKE_MODEL, id: 'l1b-embedding', name: '驱动检索模型', modelName: 'text-embedding-3-small', purposes: ['embedding'] })
const UNREGISTERED = 'EMBEDDING_SPACE_VERIFY_FAILED'

export const L1B_SCENARIOS = {
  // #787 的规则落到工作流报错：重建检索时主进程回一个没登记文案的码（vector-store 真会抛的那个），提示只给说明，码只进控制台。
  'l1b-kb-rebuild-unregistered': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke }) => {
    assert.equal((await invoke(page, 'llm:save-model', EMBEDDING_MODEL)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-embedding-model', EMBEDDING_MODEL.id)).success, true)
  } }), run: async context => {
    const { app, page, shoot } = context
    const warnings = []
    page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()) })
    await importMaterials(context)
    await app.evaluate(({ ipcMain }, code) => {
      ipcMain._invokeHandlers.set('kb:backfill-vectors', async () => ({ success: false, processed: 0, failed: 1, error: code }))
    }, UNREGISTERED)
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '检索模型')
    const index = stage.root(page).getByRole('region', { name: '当前作品的检索索引' })
    await index.getByRole('button', { name: '检查并重建向量索引' }).click()
    const toast = stage.toastStack(page).locator(stage.LIVE_TOAST).filter({ hasText: '重建检索' }).last()
    await toast.waitFor({ state: 'visible', timeout: 15_000 })
    await shoot('l1b-kb-rebuild-unregistered')
    const shown = (await toast.innerText()).trim()
    const logged = warnings.filter(text => text.includes(UNREGISTERED))
    assert.equal(shown, '重建检索失败', JSON.stringify({ shown, logged }))
    assert.ok(logged.length > 0, '码记进了渲染端控制台')
    return { shown, logged }
  } },
}
