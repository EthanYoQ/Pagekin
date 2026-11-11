import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import * as blueprint from './pages/blueprint.mjs'
import * as stage from './pages/stage.mjs'
import { finalizeChapter, openCharacterState } from './f491-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const AUTHOR_RELATION = '素不相识'
const NEW_RELATION = '彼此信任'
const EVIDENCE = '他给林岚倒了一杯很淡的茶，自己却只是捧着杯子，看着炉火。'
const CHAPTER_FOUR_MARKER = '守塔人的屋子在灯塔背风的一侧'

export async function seedKeeperRelation({ page, invoke, path: projectPath, session }) {
  const commit = async (roster, entries) => {
    const result = await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
      expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit', entries }, projectPath, session)
    assert.equal(result.success, true, JSON.stringify(result))
  }
  const read = () => invoke(page, 'db:character-roster-read', projectPath, session)
  const first = await read()
  await commit(first, [...first.entries, { characterId: `draft:${randomUUID()}`, name: '守塔人', role: 'supporting', gender: '', age: '', appearance: '',
    personality: '', background: '灯塔的看守。', abilities: '', motivation: '', relationships: [], arc: '', notes: '' }])
  const second = await read()
  const keeper = second.entries.find(entry => entry.name === '守塔人')
  await commit(second, second.entries.map(entry => entry.name === '林岚'
    ? { ...entry, relationships: [{ targetCharacterId: keeper.characterId, target: '守塔人', relation: AUTHOR_RELATION }] } : entry))
}

async function seedKeeperInNextChapter(context) {
  await seedKeeperRelation(context)
  const { page, invoke, path: projectPath, session } = context
  const committed = await invoke(page, 'db:blueprint-commit-range', { mode: 'replace-range', operationId: randomUUID(), startChapter: 5, endChapter: 5, blueprints: [
    { chapterNumber: 5, title: STAGE_SAMPLE.titles[4], role: '发展', purpose: '推进灯塔与沉船的线索', keyEvents: '林岚在灯塔里找到新的线索', characters: ['林岚', '守塔人'],
      suspenseHook: '', userGuidance: '', notes: '', notesUpdatedAt: '', relationshipHints: [] }] }, projectPath, session)
  assert.equal(committed.success, true, committed.error)
}

function relationReply(prompt) {
  const id = name => new RegExp(`"characterId": "([^"]+)",\\s*"name": "${name}"`, 'u').exec(prompt)?.[1]
  const relations = prompt.includes(CHAPTER_FOUR_MARKER)
    ? [{ source: id('林岚'), target: id('守塔人'), relation: NEW_RELATION, evidence: { text: EVIDENCE } }] : []
  return JSON.stringify({ updates: [], relations })
}

async function readRelations(projectPath) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(projectPath, '.ai-novel', 'project.db'), { readOnly: true })
  try {
    return {
      current: db.prepare('SELECT relation FROM character_relationships').all().map(row => row.relation),
      nodes: db.prepare("SELECT value,effective_chapter,json_extract(provenance_json,'$.kind') AS kind FROM character_continuity_events WHERE aspect='relation' ORDER BY effective_chapter,kind").all().map(row => ({ ...row })),
    }
  } finally { db.close() }
}

export const C6_SCENARIOS = {
  'c6-relation-suggestion': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: seedKeeperRelation }), run: async context => {
    const { page, fake, samplePath } = context
    fake.replyCharacterState(relationReply)
    await finalizeChapter(page, 3)
    await finalizeChapter(page, 4)
    const measured = { requests: fake.requests.filter(kind => kind === 'character-state').length, afterFinalize: await readRelations(samplePath) }
    assert.equal(measured.requests, 2, '两章定稿各一次角色状态请求，没有多发')
    assert.deepEqual(measured.afterFinalize.current, [AUTHOR_RELATION], '派生节点不改写当前关系')

    await openCharacterState(page)
    const root = stage.root(page), profile = root.locator('.cast-profile')
    await profile.locator('.cast-timeline-summary').click()
    const fourth = profile.locator('.cast-timeline-chapter').filter({ has: page.locator('h3', { hasText: /^第 4 章$/u }) })
    const row = fourth.locator('.cast-timeline-row').filter({ hasText: NEW_RELATION })
    await row.waitFor({ state: 'visible' })
    await row.locator('.cast-timeline-quote summary').click()
    measured.quote = await row.locator('blockquote').innerText()
    assert.equal(measured.quote, EVIDENCE, '时间线带原文')
    await context.shoot('c6-1-timeline-derived')

    const suggestions = root.getByRole('region', { name: '待处理的角色建议' })
    const card = suggestions.locator('[data-kind="relation"]')
    measured.listed = (await card.innerText()).replace(/\s+/gu, ' ').trim()
    assert.match(measured.listed, /林岚 → 守塔人 · 第 4 章/u, '建议写明两个人和章号')
    assert.match(await suggestions.innerText(), /1 项待处理的角色建议/u, '计入待处理数')
    await context.shoot('c6-2-suggestion-listed')

    await card.getByRole('button', { name: '检查定稿关系建议' }).click()
    await card.locator('blockquote').waitFor({ state: 'visible' })
    measured.opened = (await card.innerText()).replace(/\s+/gu, ' ').trim()
    assert.match(measured.opened, new RegExp(`你的设定：${AUTHOR_RELATION}`, 'u'))
    assert.match(measured.opened, new RegExp(`正文里：${NEW_RELATION}`, 'u'))
    await context.shoot('c6-3-suggestion-open')

    await card.getByRole('button', { name: '采用', exact: true }).click()
    await card.waitFor({ state: 'detached', timeout: 15_000 })
    measured.afterAdopt = await readRelations(samplePath)
    assert.deepEqual(measured.afterAdopt.current, [NEW_RELATION], '采用后当前关系换成新值')
    assert.ok(measured.afterAdopt.nodes.some(node => node.kind === 'author' && node.value === NEW_RELATION && node.effective_chapter === 4), `作者节点自第 4 章起。实际：${JSON.stringify(measured.afterAdopt.nodes)}`)
    await context.shoot('c6-4-adopted')

    const merged = fourth.locator('.cast-timeline-row')
    await merged.filter({ hasText: `${AUTHOR_RELATION} → ${NEW_RELATION}` }).waitFor({ state: 'visible' })
    assert.equal(await merged.count(), 1, '采用后第 4 章只有一行')
    assert.match(await merged.innerText(), /作者设定/u, '合并后的来源是作者设定')
    measured.summary = await profile.locator('.cast-timeline-summary').innerText()
    assert.match(measured.summary, /时间线 · 2 处变化/u, '第 3 章作者设定一行，第 4 章合并后一行')
    await merged.locator('.cast-timeline-quote summary').click()
    measured.mergedQuote = await merged.locator('blockquote').innerText()
    assert.equal(measured.mergedQuote, EVIDENCE, '合并后的行原文还能展开')
    await context.shoot('c6-5-timeline-merged')
    return measured
  } },

  'c56-undecided-relation-warning': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: seedKeeperInNextChapter }), run: async context => {
    const { page, fake, samplePath } = context
    fake.replyCharacterState(relationReply)
    await finalizeChapter(page, 3)
    await finalizeChapter(page, 4)

    await blueprint.open(page)
    await context.shoot('c56-0-before-write')
    await blueprint.writeNext(page)
    const preflight = blueprint.preflight(page)
    await preflight.waitFor({ state: 'visible' })
    await preflight.getByText(`你设定林岚和守塔人是「${AUTHOR_RELATION}」，第 4 章定稿写的是「${NEW_RELATION}」，还没决定用哪个。`).waitFor({ state: 'visible' })
    await preflight.getByText(`依据：第 4 章 · ${EVIDENCE}`).waitFor({ state: 'visible' })
    await preflight.getByText('到角色页的建议里决定。').waitFor({ state: 'visible' })
    const measured = { warning: (await preflight.innerText()).replace(/\s+/gu, ' ').trim() }
    await context.shoot('c56-1-undecided-warning')

    await page.keyboard.press('Escape')
    await openCharacterState(page)
    const card = stage.root(page).getByRole('region', { name: '待处理的角色建议' }).locator('[data-kind="relation"]')
    await card.getByRole('button', { name: '检查定稿关系建议' }).click()
    await card.getByRole('button', { name: '采用', exact: true }).click()
    await card.waitFor({ state: 'detached', timeout: 15_000 })
    measured.afterAdopt = await readRelations(samplePath)
    assert.deepEqual(measured.afterAdopt.current, [NEW_RELATION], '采用后当前关系换成新值')

    await blueprint.open(page)
    const started = fake.requests.length
    await blueprint.writeNext(page)
    for (let waited = 0; fake.requests.length === started && waited < 15_000; waited += 100) await page.waitForTimeout(100)
    assert.ok(fake.requests.length > started, '没有警告时直接开写')
    assert.equal(await page.getByText('还没决定用哪个').count(), 0, '作者决定之后警告消失')
    await context.shoot('c56-2-decided-no-warning')
    return measured
  } },
}
