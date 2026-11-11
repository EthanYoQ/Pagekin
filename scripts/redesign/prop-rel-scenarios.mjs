import assert from 'node:assert/strict'
import path from 'node:path'

import * as architecture from './pages/architecture.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { finalizeChapter } from './f491-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'

async function generate(page, fake, from, to) {
  const before = fake.chats.length
  await blueprint.generateRange(page, from, to)
  await runSheet.waitUntilOpen(page)
  for (const deadline = Date.now() + 60_000; fake.chats.length === before; await page.waitForTimeout(100))
    assert.ok(Date.now() < deadline, `第 ${from}–${to} 章的蓝图生成没有发出模型请求`)
  await runSheet.sheet(page).getByRole('button', { name: /^取消「/ }).waitFor({ state: 'detached', timeout: 90_000 })
  await runSheet.lastRun(page).locator('.run-card-meta').filter({ hasText: '已完成' }).waitFor({ state: 'visible', timeout: 90_000 })
  await runSheet.sheet(page).getByRole('button', { name: '收起运行侧页' }).first().click()
  await runSheet.sheet(page).waitFor({ state: 'hidden' })
}

async function readProject(projectPath) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(projectPath, '.ai-novel', 'project.db'), { readOnly: true })
  try {
    const batches = db.prepare('SELECT raw_value FROM character_identity_proposals').all().map(row => JSON.parse(row.raw_value).batch)
    return {
      directory: batches.filter(batch => batch.source.kind === 'directory').map(batch => ({ status: batch.status,
        items: batch.items.map(item => ({ name: item.fields.name, relationships: item.relationships.map(relation => `${relation.targetName}：${relation.relation}`) })) })),
      characters: db.prepare('SELECT name FROM characters WHERE retired=0 ORDER BY name').all().map(row => row.name),
      relations: db.prepare(`SELECT s.name AS source,t.name AS target,r.relation FROM character_relationships r
        JOIN characters s ON s.character_id=r.source_character_id JOIN characters t ON t.character_id=r.target_character_id`).all().map(row => `${row.source} → ${row.target}：${row.relation}`),
      relationChapters: db.prepare("SELECT value,effective_chapter AS chapter FROM character_continuity_events WHERE aspect='relation'").all().map(row => `${row.value}@${row.chapter}`),
    }
  } finally { db.close() }
}

export const PROPREL_SCENARIOS = {
  /** 生成第 13–14 章蓝图，第 13 章引入新角色雾灯人和他对林岚的关系；角色页的建议里能看到、批准这条关系。 */
  'prop-rel-blueprint-relation': { model: true, shell: 'stage', setup: context => seedStageSample(context, { totalChapters: 16 }), run: async ({ page, fake, samplePath, shoot }) => {
    await blueprint.open(page)
    fake.replyDirectoryBlueprints(13)
    await generate(page, fake, 13, 14)
    const measured = { staged: await readProject(samplePath) }
    assert.deepEqual(measured.staged.directory, [{ status: 'pending-approval', items: [{ name: '雾灯人', relationships: ['林岚：暗中守护'] }] }], '蓝图提案已暂存，待批准')

    await architecture.open(page)
    await architecture.openCast(page)
    const suggestions = stage.root(page).getByRole('region', { name: '待处理的角色建议' })
    await suggestions.waitFor({ state: 'visible' })
    measured.listed = (await suggestions.innerText()).replace(/\s+/gu, ' ').trim()
    await shoot('prop-rel-1-listed')
    assert.match(measured.listed, /1 项待处理的角色建议/u)
    assert.match(measured.listed, /第 13 章蓝图的新角色（1 位）/u)

    const card = suggestions.locator('[data-kind="decision"]')
    await card.getByRole('button', { name: '检查蓝图角色决策' }).click()
    const relation = card.getByRole('checkbox', { name: /雾灯人 → 林岚：暗中守护/u })
    await relation.waitFor({ state: 'visible' })
    measured.relationEnabled = await relation.isEnabled()
    measured.relationChecked = await relation.isChecked()
    assert.equal(measured.relationEnabled, true, '关系的目标是已有角色林岚，可以勾选')
    assert.equal(measured.relationChecked, false, '名字只是标签，关系默认不勾，作者自己决定')
    await shoot('prop-rel-2-review-default')
    await relation.check()
    await shoot('prop-rel-2-review')

    await card.getByRole('button', { name: '接受这些决策' }).click()
    await suggestions.waitFor({ state: 'detached', timeout: 15_000 })
    measured.adopted = await readProject(samplePath)
    assert.ok(measured.adopted.characters.includes('雾灯人'), '雾灯人进了角色名单')
    assert.ok(measured.adopted.relations.includes('雾灯人 → 林岚：暗中守护'), `关系写进名单。实际：${JSON.stringify(measured.adopted.relations)}`)
    assert.equal(measured.adopted.directory[0].status, 'approved')
    assert.deepEqual(measured.adopted.relationChapters, ['暗中守护@13'], '关系从提出它的第 13 章生效')
    await architecture.castRow(page, '雾灯人').click()
    await architecture.profileName(page).filter({ hasText: '雾灯人' }).waitFor({ state: 'visible' })
    measured.profileRelations = await stage.root(page).locator('.cast-profile textarea').evaluateAll(fields => fields.map(field => field.value).filter(value => value.includes('暗中守护')))
    assert.deepEqual(measured.profileRelations, ['林岚：暗中守护'], '雾灯人的关系网里有这条关系')
    await shoot('prop-rel-3-adopted')
    return measured
  } },
  /** 建议先列出；作者随后改了第 13 章蓝图标题，这条提案接受必然失败，角色页不再列出。 */
  'prop-rel-stale': { model: true, shell: 'stage', setup: context => seedStageSample(context, { totalChapters: 16 }), run: async ({ page, fake, shoot }) => {
    await blueprint.open(page)
    fake.replyDirectoryBlueprints(13)
    await generate(page, fake, 13, 14)
    const suggestions = stage.root(page).getByRole('region', { name: '待处理的角色建议' })
    await architecture.open(page)
    await architecture.openCast(page)
    await suggestions.waitFor({ state: 'visible' })
    await blueprint.open(page)
    await blueprint.planItem(page, 13).click()
    await blueprint.titleInput(page).fill('第十三夜改名')
    await page.keyboard.press('ControlOrMeta+S')
    await stage.saveStatus(page).getByText('已保存').waitFor({ state: 'visible' })
    await architecture.open(page)
    await architecture.openCast(page)
    await page.waitForTimeout(1500)
    const measured = { listed: await suggestions.count() }
    await shoot('prop-rel-4-stale')
    assert.equal(measured.listed, 0, '改过来源蓝图后不再出建议')
    return measured
  } },
  /** 生成蓝图后定稿第 3 章：定稿不碰蓝图提案的来源，建议还在。 */
  'prop-rel-after-finalize': { model: true, shell: 'stage', setup: context => seedStageSample(context, { totalChapters: 16 }), run: async ({ page, fake, shoot }) => {
    await blueprint.open(page)
    fake.replyDirectoryBlueprints(13)
    await generate(page, fake, 13, 14)
    await finalizeChapter(page, 3)
    await architecture.open(page)
    await architecture.openCast(page)
    const suggestions = stage.root(page).getByRole('region', { name: '待处理的角色建议' })
    await suggestions.waitFor({ state: 'visible' })
    const measured = { listed: (await suggestions.innerText()).replace(/\s+/gu, ' ').trim() }
    await shoot('prop-rel-5-after-finalize')
    assert.match(measured.listed, /第 13 章蓝图的新角色（1 位）/u)
    return measured
  } },
}
