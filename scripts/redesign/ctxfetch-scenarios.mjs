import assert from 'node:assert/strict'

import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { FAKE_MODEL, FIXTURE_ENDPOINT_CONTEXT_WINDOW } from './fake-model.mjs'

const [DECLARED_MODEL, DECLARED_WINDOW] = FIXTURE_ENDPOINT_CONTEXT_WINDOW

export const CTXFETCH_SCENARIOS = {
  'ctx-fetch-window-source': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    await stage.openSettings(page)
    await page.getByRole('button', { name: `编辑「${FAKE_MODEL.name}」`, exact: true }).click()
    const combobox = page.locator('input[role="combobox"]')
    const windowInput = page.getByLabel('上下文窗口', { exact: true })
    const read = async () => ({
      value: await windowInput.inputValue(),
      placeholder: await windowInput.getAttribute('placeholder'),
      source: await page.locator('[data-context-window-source]').innerText(),
    })
    const capture = async name => {
      await combobox.evaluate(element => element.closest('.rounded-xl')?.scrollIntoView({ block: 'start' }))
      await page.mouse.move(0, 0)
      await shoot(name)
      return read()
    }
    const choose = async modelName => {
      await page.getByRole('button', { name: '展开候选模型', exact: true }).click()
      await page.getByRole('listbox', { name: '候选模型' }).getByRole('option', { name: modelName, exact: true }).click()
    }

    await choose(DECLARED_MODEL)
    const endpoint = await capture('ctx-fetch-endpoint')
    assert.deepEqual(endpoint, { value: String(DECLARED_WINDOW), placeholder: String(DECLARED_WINDOW), source: '来自服务商' })

    await windowInput.fill('20000')
    const manual = await capture('ctx-fetch-manual')
    assert.deepEqual(manual, { value: '20000', placeholder: '20000', source: '你填的' })

    await windowInput.fill('')
    assert.deepEqual(await read(), endpoint, '清空后回到服务商声明的值')

    await choose('gateway/model-01')
    const fallback = await capture('ctx-fetch-default')
    assert.deepEqual(fallback, { value: '', placeholder: '32768', source: '默认值' })

    await choose('gpt-4.1')
    const preset = await capture('ctx-fetch-preset')
    assert.equal(preset.source, '内置资料')
    assert.ok(Number(preset.value) > 0, JSON.stringify(preset))

    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await page.getByRole('button', { name: `编辑「${FAKE_MODEL.name}」`, exact: true }).waitFor({ state: 'visible' })
    return { endpoint, manual, fallback, preset }
  } },
}
