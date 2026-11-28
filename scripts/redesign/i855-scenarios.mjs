import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { inferenceReply, readBook, trackOpenedSession } from './import-infer-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const settle = page => page.waitForTimeout(400)
const KEPT_FIELDS = ['genre', 'subGenre', 'targetAudience', 'coreOutline', 'worldSetting', 'protagonistProfile', 'premise', 'worldbuilding', 'synopsis']

export const I855_SCENARIOS = {
  'i855-reference-into-existing': { model: true, shell: 'stage', setup: context => seedStageSample(context, {
    landOnChapter3: false, beforeReload: async ({ page, invoke, path: projectPath, session }) => {
      assert.equal((await invoke(page, 'db:blueprint-delete', 2, projectPath, session)).success, true)
      await trackOpenedSession(context.app)
    },
  }), run: async context => {
    const { app, page, roots, fake, shoot } = context
    fake.replyReview(inferenceReply)
    const before = await readBook(context)
    const file = path.join(roots.temp, 'reference-novel.txt')
    fs.writeFileSync(file, '第1章 旧港\n旧港的潮水刚退，青石上还留着一层薄薄的盐霜。\n\n第2章 北堤\n北堤上的风很大，灯塔的光扫过雨幕。\n')
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, file)

    await stage.root(page).getByRole('banner').getByRole('button', { name: `《${STAGE_SAMPLE.name}》作品菜单` }).click()
    await page.getByRole('menuitem', { name: '小说拆解与仿写…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '小说拆解与仿写' })
    await dialog.getByTestId('import-target-current').click()
    await dialog.getByRole('button', { name: '选择', exact: true }).click()
    await dialog.getByRole('button', { name: '导入当前项目（2 章）', disabled: false }).click()
    await dialog.waitFor({ state: 'hidden' })
    await runSheet.waitUntilOpen(page)
    await runSheet.waitForRunDone(page, 120_000)

    const { core, blueprints } = await readBook(context)
    const filled = KEPT_FIELDS.filter(field => before.core[field])
    for (const field of filled) assert.equal(core[field], before.core[field], `已有的 ${field} 一字不变`)
    assert.ok(before.core.genre && before.core.coreOutline, '示例作品原本就有类型和大纲')
    assert.equal(before.core.writingStyle, '', '示例作品原本没有文风')
    assert.ok(core.writingStyle.length > 0, '空的文风被反推值补上')
    const beforeByChapter = new Map(before.blueprints.map(item => [item.chapterNumber, item.title]))
    const byChapter = new Map(blueprints.map(item => [item.chapterNumber, item.title]))
    assert.equal(byChapter.get(1), beforeByChapter.get(1), '已有蓝图的第 1 章不变')
    assert.equal(byChapter.get(2), '反推第2章', '没有蓝图的第 2 章写入反推蓝图')

    const suggestions = runSheet.sheet(page).getByRole('region', { name: '反推建议' })
    await suggestions.waitFor({ state: 'visible' })
    const suggested = await suggestions.locator('.run-suggestion-name').allInnerTexts()
    assert.ok(suggested.includes('类型'), `与已有类型不同的反推值进建议：${suggested.join('、')}`)
    await suggestions.scrollIntoViewIfNeeded()
    await settle(page)
    await shoot('i855-reference-suggestions')

    const genre = suggestions.getByRole('button', { name: '采用「类型」的反推结果' })
    await genre.click()
    await genre.waitFor({ state: 'detached' })
    const adopted = (await readBook(context)).core.genre
    assert.notEqual(adopted, before.core.genre, '采用后才写入反推的类型')
    return {
      keptFilledFields: filled,
      writingStyleFilled: core.writingStyle.length > 0,
      blueprints: [1, 2].map(number => byChapter.get(number)),
      suggested,
      adoptedGenre: adopted,
    }
  } },
}
