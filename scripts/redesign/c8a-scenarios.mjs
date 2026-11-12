import assert from 'node:assert/strict'

import * as blueprint from './pages/blueprint.mjs'
import * as stage from './pages/stage.mjs'
import { seedKeeperRelation } from './c6-scenarios.mjs'
import { seedStageSample, untilGateHolds } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const AUTHOR_RELATION = '素不相识'
const CHAPTER = 5
const LAST_CHAPTER = STAGE_SAMPLE.titles.length
const FIRST = { issue: '第 5 章写林岚和守塔人是多年好友，时间线上两人素不相识。', suggestion: '改成两人初次见面。' }
const SECOND = { issue: '第 5 章还写守塔人叫得出林岚的小名。', suggestion: '改成守塔人先问她叫什么。' }
const checkRequests = fake => fake.requests.filter(kind => kind === 'review').length

const seedConflict = async context => {
  await seedKeeperRelation(context)
  const { page, invoke, path, session } = context
  const current = await invoke(page, 'db:blueprint-get', CHAPTER, path, session)
  assert.equal((await invoke(page, 'db:blueprint-upsert', { ...current, keyEvents: '林岚和守塔人是多年的好友，守塔人喊她小名' }, path, session)).success, true)
}

function twoPointReply(prompt) {
  if (!prompt.includes('"timeline":[')) return null
  const id = new RegExp(`"id":"(e\\d+)","character":"林岚","aspect":"relation","target":"守塔人","value":"${AUTHOR_RELATION}"`, 'u').exec(prompt)?.[1]
  assert.ok(id, '发给模型的时间线里有林岚和守塔人的节点')
  return JSON.stringify({ findings: [FIRST, SECOND].map(point => ({ chapterNumber: CHAPTER, eventIds: [id], ...point })) })
}

const openBlueprintsAt = async (page, chapterNumber) => {
  await stage.stageButton(page, '蓝图').click()
  await stage.tab(page, '蓝图').waitFor({ state: 'visible' })
  await blueprint.planItem(page, chapterNumber).click()
}

export const C8A_SCENARIOS = {
  'c8a-check-rejoin': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: seedConflict }), run: async ({ page, fake, shoot }) => {
    fake.replyReview(twoPointReply)
    await openBlueprintsAt(page, CHAPTER)
    fake.gate.hold()
    await page.getByRole('button', { name: 'AI 检查', exact: true }).click()
    await untilGateHolds(fake.gate)
    await stage.stageButton(page, '正文').click()
    await stage.prose(page).waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('button', { name: /^(AI 检查|检查中…)$/u }).count(), 0, '蓝图页已卸载')
    await openBlueprintsAt(page, CHAPTER)
    const running = page.getByRole('button', { name: '检查中…', exact: true })
    await running.waitFor({ state: 'visible' })
    assert.equal(await running.isDisabled(), true, '回到蓝图页按钮仍是检查中，点不了')
    assert.equal(fake.gate.waiting, 1, '只有一个检查请求在等模型')
    await shoot('c8a-1-running-after-return')

    fake.gate.release()
    const root = stage.root(page)
    await root.getByText(`AI 检查到第 ${LAST_CHAPTER} 章，这些章和时间线矛盾。`, { exact: true }).waitFor({ state: 'visible' })
    await root.getByText(FIRST.issue, { exact: true }).waitFor({ state: 'visible' })
    await root.getByText(SECOND.issue, { exact: true }).waitFor({ state: 'visible' })
    await root.getByText(`建议：${SECOND.suggestion}`, { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await root.locator('.stage-bp-ai-item').count(), 1, '两条矛盾在同一张结论卡里')
    assert.equal(checkRequests(fake), 1, '只发一次请求')
    await shoot('c8a-2-done')
  } },
}
