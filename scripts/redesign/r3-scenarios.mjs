/** #279 R3：检索模型页的重排分区，以及重排失败时知识库页的回退小字。 */

import assert from 'node:assert/strict'

import { FAKE_MODEL } from './fake-model.mjs'
import * as refs from './pages/refs.mjs'
import * as stage from './pages/stage.mjs'
import { importMaterials } from './refs-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'

const FALLBACK_NOTE = '这次没能重排，结果按原顺序显示。'
const RERANK_ID = 'r3-rerank'
const RERANK_NAME = '驱动重排模型'

const seedRerank = context => seedStageSample(context, { beforeReload: async ({ page, invoke }) => {
  const profile = {
    id: RERANK_ID, name: RERANK_NAME, provider: 'custom', protocol: 'openai', modelName: 'fixture-reranker',
    apiKey: FAKE_MODEL.apiKey, baseUrl: `http://127.0.0.1:${context.fake.port}/v1`, temperature: 0.7, maxTokens: 4096, purposes: ['rerank'],
  }
  assert.equal((await invoke(page, 'llm:save-model', profile)).success, true)
  assert.equal((await invoke(page, 'llm:set-default-rerank-model', RERANK_ID)).success, true)
} })

async function searchWithRerank(context) {
  const { page, fake } = context
  await importMaterials(context)
  const before = fake.requests.filter(kind => kind === 'rerank').length
  await refs.search(page, '守塔人')
  const reranks = fake.requests.filter(kind => kind === 'rerank').length - before
  assert.equal(reranks, 1, `这次查找应发出 1 次重排请求，实际 ${reranks} 次`)
  const count = await refs.results(page).getByRole('listitem').count()
  assert.ok(count > 0, '查找应有结果')
  return { reranks, count }
}

const fallbackNote = page => stage.root(page).getByRole('status').filter({ hasText: FALLBACK_NOTE })

const rerankSection = page => stage.root(page).locator('[data-rerank-section]')
const openRetrievalSettings = async page => {
  await stage.openSettings(page)
  await stage.showSettingsPage(page, '检索模型')
  await rerankSection(page).waitFor({ state: 'visible' })
}
const summary = page => rerankSection(page).locator('.stage-set-rerank-head')

export const R3_SCENARIOS = {
  'r3-rerank-fallback': { model: true, shell: 'stage', setup: seedRerank, run: async context => {
    const { page, fake, shoot } = context
    fake.failRerank()
    const measured = await searchWithRerank(context)
    await fallbackNote(page).waitFor({ state: 'visible' })
    assert.equal(await fallbackNote(page).count(), 1)
    await shoot('knowledge-fallback')
    return measured
  } },

  'r3-rerank-ok': { model: true, shell: 'stage', setup: seedRerank, run: async context => {
    const { page, shoot } = context
    const measured = await searchWithRerank(context)
    assert.equal(await fallbackNote(page).count(), 0, '重排成功时不显示小字')
    await shoot('knowledge-ok')
    return measured
  } },

  'r3-settings-collapsed': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    await openRetrievalSettings(page)
    assert.equal(await summary(page).getAttribute('aria-expanded'), 'false')
    assert.match(await rerankSection(page).innerText(), /提升取材精度/)
    await rerankSection(page).scrollIntoViewIfNeeded()
    await shoot('settings-collapsed')
    return { text: await summary(page).innerText() }
  } },

  'r3-settings-enabled': { model: true, shell: 'stage', setup: seedRerank, run: async ({ page, shoot }) => {
    await openRetrievalSettings(page)
    assert.match(await rerankSection(page).innerText(), new RegExp(`已启用：${RERANK_NAME}`))
    await summary(page).click()
    assert.equal(await summary(page).getAttribute('aria-expanded'), 'true')
    await rerankSection(page).getByText('最多 40 段稿件').waitFor({ state: 'visible' })
    await rerankSection(page).scrollIntoViewIfNeeded()
    await shoot('settings-enabled')
    return { text: await summary(page).innerText() }
  } },

  'r3-settings-form': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    await openRetrievalSettings(page)
    await summary(page).click()
    await rerankSection(page).getByRole('button', { name: '添加重排模型' }).click()
    const options = await rerankSection(page).locator('select').first().locator('option').allInnerTexts()
    assert.equal(options.length, 3, `服务商只列有重排模型的两家和自定义，实际 ${options.join('、')}`)
    await rerankSection(page).scrollIntoViewIfNeeded()
    await shoot('settings-form')
    return { options }
  } },
}
