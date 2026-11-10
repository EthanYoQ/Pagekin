import assert from 'node:assert/strict'

import * as blueprint from './pages/blueprint.mjs'
import * as stage from './pages/stage.mjs'
import { seedKeeperRelation } from './c6-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const AUTHOR_RELATION = '素不相识'
const CONFLICTING_EVENTS = '林岚和守塔人是多年的好友，一起修好了雾钟'
const CONFLICTING_CHAPTERS = [5, 7]
const LAST_CHAPTER = STAGE_SAMPLE.titles.length
const ISSUE = chapterNumber => `第 ${chapterNumber} 章写林岚和守塔人是多年好友，时间线上两人素不相识。`
const SUGGESTION = '改成两人初次见面。'
const checkRequests = fake => fake.requests.filter(kind => kind === 'review').length

const seedConflicts = async context => {
  await seedKeeperRelation(context)
  const { page, invoke, path, session } = context
  for (const chapterNumber of CONFLICTING_CHAPTERS) {
    const current = await invoke(page, 'db:blueprint-get', chapterNumber, path, session)
    assert.equal((await invoke(page, 'db:blueprint-upsert', { ...current, keyEvents: CONFLICTING_EVENTS }, path, session)).success, true)
  }
}

function conflictReply(prompt) {
  if (!prompt.includes('"timeline":[')) return null
  const id = new RegExp(`"id":"(e\\d+)","character":"林岚","aspect":"relation","target":"守塔人","value":"${AUTHOR_RELATION}"`, 'u').exec(prompt)?.[1]
  assert.ok(id, '发给模型的时间线里有林岚和守塔人的节点')
  return JSON.stringify({ findings: CONFLICTING_CHAPTERS.map(chapterNumber => ({ chapterNumber, eventIds: [id], issue: ISSUE(chapterNumber), suggestion: SUGGESTION })) })
}

const cleanReply = prompt => prompt.includes('"timeline":[') ? '{"findings":[]}' : null

const openBlueprintsAt = async (page, chapterNumber) => {
  await stage.stageButton(page, '蓝图').click()
  await stage.tab(page, '蓝图').waitFor({ state: 'visible' })
  await blueprint.planItem(page, chapterNumber).click()
}

const checkButton = page => page.getByRole('button', { name: 'AI 检查', exact: true })

export const C7_SCENARIOS = {
  'c7-check-finds-conflicts': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: seedConflicts }), run: async ({ page, fake, shoot }) => {
    fake.replyReview(conflictReply)
    await openBlueprintsAt(page, 5)
    assert.equal(checkRequests(fake), 0, '不点按钮不发请求')
    await checkButton(page).click()
    const root = stage.root(page)
    const summary = root.getByText(`AI 检查到第 ${LAST_CHAPTER} 章，这些章和时间线矛盾。`, { exact: true })
    await summary.waitFor({ state: 'visible' })
    const basis = root.getByText(`依据：第 3 章 · 林岚和守塔人：${AUTHOR_RELATION}`, { exact: true })
    await root.getByText(ISSUE(5), { exact: true }).waitFor({ state: 'visible' })
    await basis.waitFor({ state: 'visible' })
    assert.equal(checkRequests(fake), 1, '只发一次请求')
    assert.equal(await root.getByText(ISSUE(7), { exact: true }).count(), 0, '别的章的结论不在这一章显示')
    const body = await page.locator('body').innerText()
    assert.doesNotMatch(body, /relation:add|GENERATION_/u, '不露 eventId 和错误码')
    await shoot('c7-1-chapter-5')
    await root.getByRole('button', { name: '第 7 章', exact: true }).click()
    await root.getByText(ISSUE(7), { exact: true }).waitFor({ state: 'visible' })
  } },
  'c7-check-clean': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: seedKeeperRelation }), run: async ({ page, fake }) => {
    fake.replyReview(cleanReply)
    await openBlueprintsAt(page, 5)
    await checkButton(page).click()
    await stage.root(page).getByText(`没发现和时间线矛盾的地方。检查到第 ${LAST_CHAPTER} 章。`, { exact: true }).waitFor({ state: 'visible' })
    assert.equal(checkRequests(fake), 1, '只发一次请求')
  } },
}
