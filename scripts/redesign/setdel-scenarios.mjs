import assert from 'node:assert/strict'

import * as stage from './pages/stage.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import { seedStageSample } from './scenarios.mjs'

const EXTRA = Object.freeze({ ...FAKE_MODEL, id: 'setdel-extra', name: '待删备用模型', modelName: 'gpt-4.1-mini' })

async function holdDeletes(app) {
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('llm:delete-model')
    let release
    globalThis.__setdelGate = new Promise(resolve => { release = resolve })
    globalThis.__setdelRelease = release
    globalThis.__setdelCalls = 0
    ipcMain._invokeHandlers.set('llm:delete-model', async (event, ...args) => {
      globalThis.__setdelCalls += 1
      await globalThis.__setdelGate
      return original(event, ...args)
    })
  })
}

const modelIds = async ({ page, invoke }) => (await invoke(page, 'llm:list-models')).map(model => model.id)

export const SETDEL_SCENARIOS = {
  'setdel-edit-during-delete': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke }) => {
    assert.equal((await invoke(page, 'llm:save-model', EXTRA)).success, true)
  } }), run: async context => {
    const { app, page, shoot } = context
    const root = stage.root(page)
    await holdDeletes(app)
    await stage.openSettings(page)
    await stage.showSettingsPage(page, 'AI 模型')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await root.getByRole('button', { name: `「${EXTRA.name}」更多操作` }).click()
      await page.getByRole('menuitem', { name: '删除模型…' }).click()
      await page.getByRole('dialog').getByRole('button', { name: '删除模型', exact: true }).click()
      await page.getByRole('dialog').waitFor({ state: 'detached' })
    }
    await root.getByRole('button', { name: `编辑「${EXTRA.name}」` }).click()
    const save = root.getByRole('button', { name: '保存配置' })
    await save.waitFor({ state: 'visible' })
    await shoot('setdel-form-while-deleting')

    await app.evaluate(() => globalThis.__setdelRelease())
    const deadline = Date.now() + 10_000
    while ((await modelIds(context)).includes(EXTRA.id)) {
      assert.ok(Date.now() < deadline, '10 秒内主进程没有删掉模型')
      await page.waitForTimeout(100)
    }
    await root.getByRole('button', { name: `编辑「${FAKE_MODEL.name}」` }).waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
    const formAfterDelete = await save.isVisible()
    await shoot('setdel-after-delete')
    if (formAfterDelete) {
      await save.click()
      await page.waitForTimeout(1500)
    }
    const storedAfterSave = (await modelIds(context)).includes(EXTRA.id)
    const listed = await root.getByRole('button', { name: `编辑「${EXTRA.name}」` }).count()
    await shoot('setdel-final')
    const deleteCalls = await app.evaluate(() => globalThis.__setdelCalls)
    const dialogs = await page.getByRole('dialog').count()
    const measured = { formAfterDelete, storedAfterSave, listed, deleteCalls, dialogs }
    assert.deepEqual(measured, { formAfterDelete: false, storedAfterSave: false, listed: 0, deleteCalls: 2, dialogs: 0 }, JSON.stringify(measured))
    return measured
  } },
}
