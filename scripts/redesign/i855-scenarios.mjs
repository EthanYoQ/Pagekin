import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { EMPTY_BOOK, inferenceReply, readBook, seedEmptyBook, trackOpenedSession } from './import-infer-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')
const settle = page => page.waitForTimeout(400)
const KEPT_FIELDS = ['genre', 'subGenre', 'targetAudience', 'coreOutline', 'worldSetting', 'protagonistProfile', 'premise', 'worldbuilding', 'synopsis']

const NEW_BOOK = '雾港新书'
const GLOBAL_PROMPT = '逆向推演出这部小说的完整设定体系'
const AUTHOR_EDITS = { genre: '武侠', total_chapters: 40 }
const newBookDbFile = roots => path.join(roots.projects, NEW_BOOK, '.ai-novel', 'project.db')

function readNewBook(roots, read) {
  const db = new Database(newBookDbFile(roots), { readonly: true, fileMustExist: true })
  try { return read(db) } finally { db.close() }
}

const latestRun = db => db.prepare('SELECT id, stage, status FROM import_runs ORDER BY rowid DESC LIMIT 1').get()

async function untilRunStatus(roots, statuses) {
  for (const deadline = Date.now() + 3 * 60_000; ; await new Promise(resolve => setTimeout(resolve, 500))) {
    const run = fs.existsSync(newBookDbFile(roots)) ? readNewBook(roots, latestRun) : undefined
    if (run && statuses.includes(run.status)) return run
    assert.ok(Date.now() < deadline, `3 分钟内导入没有到 ${statuses.join('/')}：${JSON.stringify(run)}`)
  }
}

async function newBookImportFailsThenAuthorEdits(context) {
  const { app, page, roots, fake } = context
  let globalBroken = true
  fake.replyReview(prompt => {
    if (!prompt.includes(GLOBAL_PROMPT)) return inferenceReply(prompt)
    if (globalBroken) return '{"novelConfig":'
    const inferred = JSON.parse(inferenceReply(prompt))
    return JSON.stringify({ ...inferred, novelConfig: { ...inferred.novelConfig, plotStructure: 'heros_journey', narrativePOV: 'first_person' } })
  })
  const file = path.join(roots.temp, 'reference-new-book.txt')
  fs.writeFileSync(file, '第1章 旧港\n旧港的潮水刚退，青石上还留着一层薄薄的盐霜。\n\n第2章 北堤\n北堤上的风很大，灯塔的光扫过雨幕。\n')
  await app.evaluate(({ dialog }, picks) => {
    dialog.showOpenDialog = async (first, second) => ({
      canceled: false,
      filePaths: [(second ?? first)?.properties?.includes('openDirectory') ? picks.folder : picks.file],
    })
  }, { folder: roots.projects, file })

  await stage.openWorkMenuItem(page, EMPTY_BOOK, '小说拆解与仿写…')
  const dialog = page.getByRole('dialog', { name: '小说拆解与仿写' })
  await dialog.getByPlaceholder('拆解后创建的新项目名称').fill(NEW_BOOK)
  await dialog.getByPlaceholder('选择项目保存目录').locator('xpath=following-sibling::button').click()
  await dialog.getByTestId('import-source-choose').click()
  await dialog.getByRole('button', { name: '导入当前项目（2 章）', disabled: false }).click()
  await dialog.waitFor({ state: 'hidden' })
  const failed = await untilRunStatus(roots, ['failed'])
  assert.equal(failed.stage, 'global', `失败停在全局反推：${JSON.stringify(failed)}`)
  const created = readNewBook(roots, db => db.prepare('SELECT genre, total_chapters, words_per_chapter, plot_structure, narrative_pov FROM project_core').get())
  assert.deepEqual(created, { genre: '', total_chapters: 100, words_per_chapter: 3000, plot_structure: 'three_act', narrative_pov: 'third_limited' },
    '失败时新作品仍是建库默认值')

  const db = new Database(newBookDbFile(roots), { fileMustExist: true, timeout: 10_000 })
  try { db.prepare("UPDATE project_core SET genre = ?, total_chapters = ? WHERE id = 'main'").run(AUTHOR_EDITS.genre, AUTHOR_EDITS.total_chapters) } finally { db.close() }
  globalBroken = false
  return failed
}

async function resumeNewBookImport(context, button, shotName) {
  const { page, roots, shoot } = context
  const failed = await newBookImportFailsThenAuthorEdits(context)
  await stage.openWorkMenuItem(page, NEW_BOOK, '小说拆解与仿写…')
  const dialog = page.getByRole('dialog', { name: '小说拆解与仿写' })
  await dialog.getByTestId('import-target-current').click()
  const action = dialog.getByRole('button', { name: button, disabled: false })
  await action.waitFor({ state: 'visible' })
  await action.click()
  await dialog.waitFor({ state: 'hidden' })
  const done = await untilRunStatus(roots, ['completed'])
  await runSheet.waitUntilOpen(page)
  await runSheet.lastRun(page).filter({ hasText: '小说拆解与仿写' }).getByText(/已完成|Complete/).waitFor({ state: 'visible' })
  await settle(page)
  await shoot(shotName)
  const core = readNewBook(roots, db => db.prepare(`SELECT genre, sub_genre, total_chapters, words_per_chapter, plot_structure, narrative_pov,
    writing_style, core_outline FROM project_core`).get())
  assert.equal(core.genre, AUTHOR_EDITS.genre, '作者改过的类型不变')
  assert.equal(core.total_chapters, AUTHOR_EDITS.total_chapters, '作者改过的总章数不变')
  assert.equal(core.sub_genre, '本格推理', '空白的子类型补上反推值')
  assert.notEqual(core.words_per_chapter, 3000, '仍是默认值的每章字数换成反推值')
  assert.equal(core.plot_structure, 'heros_journey', '仍是默认值的故事结构换成反推值')
  assert.equal(core.narrative_pov, 'first_person', '仍是默认值的叙事视角换成反推值')
  assert.ok(core.writing_style.length > 0 && core.core_outline.length > 0, '空白的文风与大纲补上')
  return { failedRun: failed, finishedRun: done, core }
}

export const I855_SCENARIOS = {
  'i855-new-book-continue': { model: true, shell: 'stage', setup: seedEmptyBook,
    run: context => resumeNewBookImport(context, '继续导入', 'i855-new-book-continue-done') },
  'i855-new-book-restart': { model: true, shell: 'stage', setup: seedEmptyBook,
    run: context => resumeNewBookImport(context, '重新开始', 'i855-new-book-restart-done') },
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
