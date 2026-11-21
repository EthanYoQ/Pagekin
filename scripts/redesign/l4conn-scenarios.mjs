import assert from 'node:assert/strict'

import * as stage from './pages/stage.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import { seedStageSample } from './scenarios.mjs'

const UNKNOWN_HOST = 'nosuchhostzz9'

async function testConnection(page) {
  await page.getByRole('button', { name: '测试连接', exact: true }).click()
  const result = page.getByText(/^连接失败/u)
  await result.waitFor({ state: 'visible', timeout: 60_000 })
  const shown = (await result.innerText()).trim()
  assert.doesNotMatch(shown, /fetch failed|E[A-Z]{3,}|UND_ERR/u, '连接失败的说明不露英文原文和错误码')
  return shown
}

async function editFixtureModel(page) {
  await stage.openSettings(page)
  await page.getByRole('button', { name: `编辑「${FAKE_MODEL.name}」`, exact: true }).click()
}

export const L4CONN_SCENARIOS = {
  'l4conn-refused': { model: true, setup: seedStageSample, run: async ({ page, fake, shoot }) => {
    await editFixtureModel(page)
    await fake.close()
    const shown = await testConnection(page)
    assert.match(shown, /没有服务在响应/u)
    await shoot('l4conn-refused')
    return { shown }
  } },
  'l4conn-host-not-found': { model: true, setup: seedStageSample, run: async ({ app, page, shoot }) => {
    // 夹具的 fetch 守卫拒绝一切外部地址；这台主机名先交给系统解析器，用它真实的 ENOTFOUND 照 undici 的形状报出。
    await app.evaluate((_, host) => {
      const guarded = globalThis.fetch
      globalThis.fetch = async (input, options) => {
        if (new URL(String(input instanceof Request ? input.url : input)).hostname !== host) return guarded(input, options)
        const dns = process.getBuiltinModule('node:dns')
        const cause = await dns.promises.lookup(host).then(() => null, error => error)
        if (!cause) throw new Error(`${host} unexpectedly resolved`)
        throw new TypeError('fetch failed', { cause })
      }
    }, UNKNOWN_HOST)
    await editFixtureModel(page)
    const baseUrl = page.getByText('base_url', { exact: true }).locator('xpath=..').getByRole('textbox')
    await baseUrl.fill(`http://${UNKNOWN_HOST}/v1`)
    const shown = await testConnection(page)
    assert.match(shown, /找不到/u)
    await shoot('l4conn-host-not-found')
    return { shown }
  } },
}
