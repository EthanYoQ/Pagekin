import assert from 'node:assert/strict'

import * as stage from './pages/stage.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import { seedStageSample } from './scenarios.mjs'

const REMOTE_HOST = 'model-401.test'
const SERVICE_BODY = '{"error":{"message":"Invalid API key"}}'

export const M33LLM_SCENARIOS = {
  'm33llm-connection-http-en': { model: true, setup: seedStageSample, run: async ({ app, page, shoot }) => {
    await app.evaluate((_, { host, body }) => {
      const guarded = globalThis.fetch
      globalThis.fetch = async (input, options) => {
        if (new URL(String(input instanceof Request ? input.url : input)).hostname !== host) return guarded(input, options)
        return new Response(body, { status: 401, headers: { 'content-type': 'application/json' } })
      }
    }, { host: REMOTE_HOST, body: SERVICE_BODY })
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('en-US')
    const nav = page.getByRole('navigation', { name: 'Settings sections' })
    await nav.getByRole('button', { name: 'AI models', exact: true }).click()
    await page.getByRole('button', { name: `Edit “${FAKE_MODEL.name}”`, exact: true }).click()
    await page.getByText('base_url', { exact: true }).locator('xpath=..').getByRole('textbox').fill(`https://${REMOTE_HOST}/v1`)
    await page.getByRole('button', { name: 'Test connection', exact: true }).click()
    const result = page.getByText(/^Connection failed/u)
    await result.waitFor({ state: 'visible', timeout: 60_000 })
    const shown = (await result.innerText()).trim()
    await shoot('m33llm-connection-http-en')
    assert.equal(shown, `Connection failed: Model request failed (HTTP 401). Check the Base URL, API key, and model name. The service returned: ${SERVICE_BODY}`)
    assert.doesNotMatch(shown, /\p{Script=Han}|LLM_|IPC_HANDLER_FAILED/u)
    return { shown }
  } },
}
