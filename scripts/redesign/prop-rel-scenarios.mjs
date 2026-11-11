import assert from 'node:assert/strict'
import path from 'node:path'

import * as architecture from './pages/architecture.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
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
    await page.waitForTimeout(1500)
    const suggestions = stage.root(page).getByRole('region', { name: '待处理的角色建议' })
    measured.listed = await suggestions.count() ? (await suggestions.innerText()).replace(/\s+/gu, ' ').trim() : null
    await shoot('prop-rel-1-listed')
    assert.ok(measured.listed, '角色页出现待处理的角色建议')
    assert.match(measured.listed, /1 项待处理的角色建议/u)
    assert.match(measured.listed, /第 13 章蓝图的新角色（1 位）/u)

    const card = suggestions.locator('[data-kind="decision"]')
    await card.getByRole('button', { name: '检查蓝图角色决策' }).click()
    const relation = card.getByRole('checkbox', { name: /雾灯人 → 林岚：暗中守护/u })
    await relation.waitFor({ state: 'visible' })
    measured.relationEnabled = await relation.isEnabled()
    measured.relationChecked = await relation.isChecked()
    assert.equal(measured.relationEnabled, true, '关系的目标是已有角色林岚，可以勾选')
    assert.equal(measured.relationChecked, true, '默认随新角色一起采用')
    await shoot('prop-rel-2-review')

    await card.getByRole('button', { name: '接受这些决策' }).click()
    await suggestions.waitFor({ state: 'detached', timeout: 15_000 })
    measured.adopted = await readProject(samplePath)
    assert.ok(measured.adopted.characters.includes('雾灯人'), '雾灯人进了角色名单')
    assert.ok(measured.adopted.relations.includes('雾灯人 → 林岚：暗中守护'), `关系写进名单。实际：${JSON.stringify(measured.adopted.relations)}`)
    assert.equal(measured.adopted.directory[0].status, 'approved')
    await architecture.castRow(page, '雾灯人').waitFor({ state: 'visible' })
    await shoot('prop-rel-3-adopted')
    return measured
  } },
}
