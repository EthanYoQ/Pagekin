import assert from 'node:assert/strict'

import * as chapterView from './pages/chapter-view.mjs'
import { seedKeeperRelation } from './c6-scenarios.mjs'
import { openChapter } from './f491-scenarios.mjs'
import { appendSentence, finalizeReopened, reopen, trackOpenedSession, uiSession } from './reopen-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'

// 第 2 章替换后林岚和守塔人反目；第 4 章（有草稿）和第 6 章的蓝图还写两人是好友，其余章不提两人。
const REPLACED_LINE = '守塔人当着全港的人撕了她父亲的地图，林岚从此和他反目成仇。'
const NEW_RELATION = '反目成仇'
const FRIENDLY = '林岚和守塔人是多年的好友，一起修好了雾钟'
const PATCHED = '林岚和守塔人在雾钟下对峙，各自修钟，互不相让'
const CONFLICTING = [4, 6]
const ISSUE = chapterNumber => `第 ${chapterNumber} 章写林岚和守塔人是多年好友，第 2 章改写后两人已反目成仇。`
const suggestRequests = fake => fake.chats.filter(chat => chat.kind === 'review' && JSON.stringify(chat.messages).includes('连续性编辑')).length

const seedFriendlyBlueprints = async context => {
  await seedKeeperRelation(context)
  const { page, invoke, path, session } = context
  for (const chapterNumber of CONFLICTING) {
    const current = await invoke(page, 'db:blueprint-get', chapterNumber, path, session)
    assert.equal((await invoke(page, 'db:blueprint-upsert', { ...current, keyEvents: FRIENDLY }, path, session)).success, true)
  }
}

const setup = async context => {
  await trackOpenedSession(context.app)
  await seedStageSample(context, { beforeReload: seedFriendlyBlueprints })
}

function relationReply(prompt) {
  const id = name => new RegExp(`"characterId": "([^"]+)",\\s*"name": "${name}"`, 'u').exec(prompt)?.[1]
  const relations = prompt.includes(REPLACED_LINE) ? [{ source: id('林岚'), target: id('守塔人'), relation: NEW_RELATION, evidence: { text: REPLACED_LINE } }] : []
  return JSON.stringify({ updates: [], relations })
}

function suggestReply(prompt) {
  if (!prompt.includes('连续性编辑') || !prompt.includes('"timeline":[')) return null
  const id = new RegExp(`"id":"(e\\d+)","character":"林岚","aspect":"relation","target":"守塔人","value":"${NEW_RELATION}"`, 'u').exec(prompt)?.[1]
  assert.ok(id, '发给模型的时间线里有第 2 章派生的反目节点')
  return JSON.stringify({ suggestions: CONFLICTING.map(chapterNumber => ({ chapterNumber, eventIds: [id], issue: ISSUE(chapterNumber), patch: { keyEvents: PATCHED } })) })
}

/** 重开第 2 章、补一句反目、再定稿；等后处理做完，「检查后续蓝图」可点。 */
async function replaceChapterTwo({ page, fake }) {
  fake.replyCharacterState(relationReply)
  fake.replyReview(suggestReply)
  await openChapter(page, 2)
  await reopen(page, 2)
  await appendSentence(page, REPLACED_LINE)
  await finalizeReopened(page, 2)
  const notice = chapterView.view(page).locator('.pi-notice').filter({ hasText: '第 2 章已修改' })
  await notice.waitFor({ state: 'visible', timeout: 30_000 })
  const check = notice.getByRole('button', { name: '检查后续蓝图', exact: true })
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '检查后续蓝图' && !button.disabled), null, { timeout: 30_000 })
  assert.equal(suggestRequests(fake), 0, '不点按钮不发请求')
  await check.click()
  const section = page.getByRole('region', { name: '后续蓝图的修改建议' })
  await section.getByText(ISSUE(6), { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
  assert.equal(suggestRequests(fake), 1, '只发一次请求')
  return section
}

const cardOf = (section, chapterNumber) => section.locator('.stage-ch-suggest-card').filter({ has: section.page().locator('h3', { hasText: new RegExp(`^第 ${chapterNumber} 章$`, 'u') }) })

async function blueprintOf(context, chapterNumber) {
  const session = await uiSession(context.app)
  return context.invoke(context.page, 'db:blueprint-get', chapterNumber, session.projectPath, session)
}

export const C8B_SCENARIOS = {
  'c8b-suggest-accept': { model: true, shell: 'stage', setup, run: async context => {
    const section = await replaceChapterTwo(context)
    const measured = {
      cards: await section.locator('.stage-ch-suggest-card h3').allInnerTexts(),
      draftNote: await cardOf(section, 4).locator('.stage-ch-suggest-note').allInnerTexts(),
      sixDraftNote: await cardOf(section, 6).locator('.stage-ch-suggest-note').count(),
      removed: await cardOf(section, 6).locator('del').allInnerTexts(),
      added: await cardOf(section, 6).locator('ins').allInnerTexts(),
    }
    assert.deepEqual(measured.cards, ['第 4 章', '第 6 章'])
    assert.deepEqual(measured.draftNote, ['第 4 章已有草稿，蓝图改了正文不会跟着变。'])
    assert.equal(measured.sixDraftNote, 0, '第 6 章没有草稿，不出这一行')
    await cardOf(section, 6).scrollIntoViewIfNeeded()
    await context.shoot('c8b-1-suggestions')

    await cardOf(section, 6).getByRole('button', { name: '接受', exact: true }).click()
    await cardOf(section, 6).getByText('已接受，蓝图已改。', { exact: true }).waitFor({ state: 'visible' })
    measured.sixAfter = (await blueprintOf(context, 6)).keyEvents
    measured.fourAfter = (await blueprintOf(context, 4)).keyEvents
    assert.equal(measured.sixAfter, PATCHED, '接受后第 6 章蓝图写成建议')
    assert.equal(measured.fourAfter, FRIENDLY, '没接受的第 4 章不动')
    await context.shoot('c8b-2-accepted')
    return measured
  } },
  'c8b-stale-after-edit': { model: true, shell: 'stage', setup, run: async context => {
    const section = await replaceChapterTwo(context)
    const session = await uiSession(context.app)
    const current = await blueprintOf(context, 6)
    const edited = '林岚独自修好了雾钟，守塔人不知所踪'
    assert.equal((await context.invoke(context.page, 'db:blueprint-upsert', { ...current, keyEvents: edited }, session.projectPath, session)).success, true)

    await cardOf(section, 6).getByRole('button', { name: '接受', exact: true }).click()
    await section.getByText('第 6 章的蓝图在建议之后改过，没有写入。再点“检查后续蓝图”。', { exact: true }).waitFor({ state: 'visible' })
    await cardOf(section, 6).getByText('这章蓝图在建议之后改过，这条不再适用。重新检查一次。', { exact: true }).waitFor({ state: 'visible' })
    const measured = { sixAfter: (await blueprintOf(context, 6)).keyEvents }
    assert.equal(measured.sixAfter, edited, '过期的建议不写入，作者改的蓝图保住')
    await cardOf(section, 6).scrollIntoViewIfNeeded()
    await context.shoot('c8b-3-stale')
    return measured
  } },
}
