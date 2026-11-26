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

const PROXY_TYPO_HOST = 'proxy-host-typo'
const REMOTE_HOST = 'model-probe.test'

async function proxyHostTypoConnection({ app, page, shoot }, locale) {
  const en = locale === 'en-US'
  await app.evaluate((_, { proxyHost, remoteHost }) => {
    const guarded = globalThis.fetch
    globalThis.fetch = async (input, options) => {
      if (new URL(String(input instanceof Request ? input.url : input)).hostname !== remoteHost) return guarded(input, options)
      const dns = process.getBuiltinModule('node:dns')
      const cause = await dns.promises.lookup(proxyHost).then(() => null, error => error)
      if (!cause) throw new Error(`${proxyHost} unexpectedly resolved`)
      throw new TypeError('fetch failed', { cause })
    }
  }, { proxyHost: PROXY_TYPO_HOST, remoteHost: REMOTE_HOST })
  await stage.openSettings(page)
  if (en) {
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('en-US')
  }
  const nav = page.getByRole('navigation', { name: en ? 'Settings sections' : '设置分组' })
  await nav.getByRole('button', { name: en ? 'Network proxy' : '网络代理', exact: true }).click()
  await page.getByRole('switch', { name: en ? 'Use a proxy' : '启用代理' }).locator('xpath=ancestor::label[1]').click()
  await page.getByLabel(en ? 'Host' : '主机地址', { exact: true }).fill(PROXY_TYPO_HOST)
  await page.getByRole('button', { name: en ? 'Save proxy settings' : '保存代理设置', exact: true }).click()
  await page.locator('.stage-set-saved').filter({ hasText: en ? 'Saved' : '已保存' }).waitFor({ state: 'visible' })
  await nav.getByRole('button', { name: en ? 'AI models' : 'AI 模型', exact: true }).click()
  await page.getByRole('button', { name: en ? `Edit “${FAKE_MODEL.name}”` : `编辑「${FAKE_MODEL.name}」`, exact: true }).click()
  await page.getByText('base_url', { exact: true }).locator('xpath=..').getByRole('textbox').fill(`https://${REMOTE_HOST}/v1`)
  await page.getByRole('button', { name: en ? 'Test connection' : '测试连接', exact: true }).click()
  const result = page.getByText(en ? /^Connection failed/u : /^连接失败/u)
  await result.waitFor({ state: 'visible', timeout: 60_000 })
  const shown = (await result.innerText()).trim()
  await shoot(en ? 'l4conn-proxy-host-typo-en' : 'l4conn-proxy-host-typo')
  return { shown }
}

export const L4CONN_SCENARIOS = {
  'l4conn-proxy-host-typo': { model: true, setup: seedStageSample, run: async context => {
    const observed = await proxyHostTypoConnection(context, 'zh-CN')
    assert.equal(observed.shown, '连接失败：连不上「网络代理」里设置的代理。请检查「主机地址」和「端口」，打开代理软件，或关掉「启用代理」。')
    return observed
  } },
  'l4conn-proxy-host-typo-en': { model: true, setup: seedStageSample, run: async context => {
    const observed = await proxyHostTypoConnection(context, 'en-US')
    assert.equal(observed.shown, 'Connection failed: Could not reach the proxy set in Network proxy. Check the Host and Port, start your proxy app, or turn off Use a proxy.')
    return observed
  } },
  'l4conn-refused': { model: true, setup: seedStageSample, run: async ({ page, fake, shoot }) => {
    await editFixtureModel(page)
    await fake.close()
    const shown = await testConnection(page)
    assert.match(shown, /没有服务在响应/u)
    await shoot('l4conn-refused')
    return { shown }
  } },
  'l4conn-host-not-found': { model: true, setup: seedStageSample, run: async ({ app, page, shoot }) => {
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
