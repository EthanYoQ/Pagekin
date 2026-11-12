// #653 多处批注统一修改：新构建里逐处审阅并保存批注历史；旧版本（schema 9）造的作品库用新构建打开后正文与版本历史不变。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE } from './stage-sample.mjs'

const HEAD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const PARAGRAPHS = [
  '守塔人的屋子在灯塔背风的一侧，窗玻璃上积着经年的盐。',
  '他给林岚倒了一杯很淡的茶，自己却只是捧着杯子，看着炉火。',
  '「你父亲也问过钟的事。」他说完这句话，就再也没有开口。',
]
const NOTES = ['把盐写得更具体', '改成第一人称', '结尾留一点动作']
const REVISED = [
  '守塔人的屋子在灯塔背风的一侧，窗玻璃上积着厚厚一层白霜。',
  '他给我倒了一杯很淡的茶，自己却只是捧着杯子，看着炉火。',
  '「你父亲也问过钟的事。」他说完这句话，就再也没有开口，只是望着塔顶。',
]
const REROLLED = '，只是抬头望向塔顶'
const EXPECTED = [
  REVISED[0],
  '他给她倒了一杯很淡的茶，自己却只是捧着杯子，看着炉火。',
  `「你父亲也问过钟的事。」他说完这句话，就再也没有开口${REROLLED}。`,
].join('\n\n')

const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16)

async function readProjectDb(projectPath, read) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(projectPath, '.ai-novel', 'project.db'), { readOnly: true })
  try { return read(db) } finally { db.close() }
}

const draftFacts = projectPath => readProjectDb(projectPath, db => ({
  userVersion: db.prepare('PRAGMA user_version').get().user_version,
  drafts: db.prepare('SELECT d.chapter_number AS chapter, d.version, d.status, c.body AS content FROM drafts d JOIN contents c ON c.id = d.content_id ORDER BY d.chapter_number, d.version').all()
    .map(row => `${row.chapter}-v${row.version}-${row.status}-${sha(row.content)}`),
}))

const seedFourthChapterVersion = context => seedStageSample(context, {
  beforeReload: async ({ page, invoke, path: projectPath, session }) => {
    context.projectPath = projectPath
    const text = PARAGRAPHS.join('\n\n')
    const created = await invoke(page, 'db:draft-create', { chapterNumber: 4, version: 2, source: 'rewrite', content: text, wordCount: countUnits(text) }, projectPath, session)
    assert.equal(created.success, true, created.error)
  },
})

async function annotate(page, paragraph, note) {
  await chapterView.prose(page).getByText(paragraph).first().click({ clickCount: 3 })
  const toolbar = page.getByRole('toolbar', { name: '选中文字的操作' })
  await toolbar.getByRole('button', { name: '添加批注' }).click()
  await toolbar.getByRole('textbox', { name: '批注意见' }).fill(note)
  await toolbar.getByRole('button', { name: '添加批注' }).click()
  await toolbar.waitFor({ state: 'hidden' })
}

export const EXT653_SCENARIOS = {
  /** 第 4 章三段各加一条批注，统一修改；逐处审阅里接受第 1 处、编辑第 2 处、重新生成第 3 处，再接受全部。重启后批注历史仍可读。 */
  'ext653-annotations': { model: true, shell: 'stage', setup: seedFourthChapterVersion, run: async context => {
    const { fake } = context
    fake.replyReview(prompt => prompt.includes('重新改写所选片段') ? REROLLED
      : NOTES.every(note => prompt.includes(note)) ? REVISED.join('\n\n') : null)
    const measured = {}
    let page = context.page
    await chapterView.open(page, 4)
    for (const [index, paragraph] of PARAGRAPHS.entries()) await annotate(page, paragraph, NOTES[index])
    const panel = page.getByRole('region', { name: '本章批注' })
    measured.panelTitle = await panel.locator('.cm-selbar-title').innerText()
    assert.equal(measured.panelTitle, '本章批注 · 3')
    measured.marks = await chapterView.prose(page).locator('.cm-editor-annotation').count()
    assert.equal(measured.marks, 3, '三处批注在正文里都有底色')
    await context.shoot('ext653-1-annotations')

    await panel.getByRole('button', { name: '统一修改（3）' }).click()
    const review = page.getByRole('region', { name: '批注修改对比' })
    await review.waitFor({ state: 'visible', timeout: 60_000 })
    measured.changes = await review.getByRole('button', { name: /^查看修改 \d+$/ }).count()
    assert.equal(measured.changes, 3, '三处批注各成一处修改')
    measured.removed = await review.locator('del').allInnerTexts()
    measured.added = await review.locator('ins').allInnerTexts()

    await review.getByRole('button', { name: '查看修改 1' }).click()
    await review.getByRole('button', { name: '接受', exact: true }).click()
    await review.getByRole('button', { name: '查看修改 2' }).click()
    await review.getByRole('button', { name: '编辑', exact: true }).click()
    await review.getByRole('textbox', { name: '编辑修改 2' }).fill('她')
    await review.getByRole('button', { name: '查看修改 3' }).click()
    await review.getByRole('button', { name: '重新生成' }).click()
    await review.locator('ins').filter({ hasText: REROLLED }).waitFor({ state: 'visible', timeout: 60_000 })
    measured.rerollRequests = fake.chats.filter(chat => JSON.stringify(chat.messages).includes('重新改写所选片段')).length
    assert.equal(measured.rerollRequests, 1)
    await context.shoot('ext653-2-review')

    await review.getByRole('button', { name: '接受全部' }).click()
    await review.waitFor({ state: 'hidden', timeout: 30_000 })
    await chapterView.prose(page).getByText(`就再也没有开口${REROLLED}。`).waitFor({ state: 'visible' })
    const history = page.locator('.annotation-revision-history')
    await history.locator('summary').first().waitFor({ state: 'visible', timeout: 30_000 })
    measured.historyTitle = await history.locator('summary').first().innerText()
    assert.equal(measured.historyTitle, '批注历史版本（1）')
    const saved = await readProjectDb(context.projectPath, db => ({
      body: db.prepare('SELECT c.body FROM drafts d JOIN contents c ON c.id = d.content_id WHERE d.chapter_number = 4 AND d.version = 2').get().body,
      history: db.prepare('SELECT before_text AS before, after_text AS after, annotations_json AS annotations FROM annotation_history').all(),
    }))
    assert.equal(saved.body, EXPECTED, '库里第 4 章正文是逐处审阅后的结果')
    assert.equal(saved.history.length, 1)
    assert.equal(saved.history[0].before, PARAGRAPHS.join('\n\n'), '历史前快照是批注时的正文')
    assert.equal(saved.history[0].after, EXPECTED, '历史后快照与正文同一份')
    assert.deepEqual(JSON.parse(saved.history[0].annotations).map(item => item.instruction), NOTES)

    await context.restart()
    page = context.page
    await stage.openAfterRestart(page, STAGE_SAMPLE.name)
    await chapterView.open(page, 4)
    await chapterView.prose(page).getByText(`就再也没有开口${REROLLED}。`).waitFor({ state: 'visible', timeout: 30_000 })
    const reopened = page.locator('.annotation-revision-history')
    await reopened.locator('summary').first().click()
    await reopened.locator('details summary').first().click()
    measured.historyEntry = await reopened.locator('details summary').first().innerText()
    measured.historyNotes = await reopened.locator('details p b').allInnerTexts()
    assert.equal(measured.historyNotes.length, 3, '重开后三条批注都在历史里')
    await reopened.scrollIntoViewIfNeeded()
    return measured
  } },

  /**
   * 旧版本（--app-root 指向已构建的 origin/master，schema 9）造示例作品，第 4 章两稿；读库记下正文与版本。
   * 换本工作树的构建重启打开同一作品：迁到 schema 10，正文与版本哈希逐条相同，版本切换器仍列出两稿。
   */
  'ext653-old-library': { model: false, shell: 'stage', setup: seedFourthChapterVersion, run: async context => {
    const measured = {}
    measured.before = await draftFacts(context.projectPath)
    assert.equal(measured.before.userVersion, 9, '旧版本造的是 schema 9 的库')
    await chapterView.open(context.page, 4)
    measured.versionsBefore = await chapterView.versions(context.page)

    await context.restart({ appRoot: HEAD_ROOT })
    const { page } = context
    await stage.openAfterRestart(page, STAGE_SAMPLE.name)
    await chapterView.open(page, 4)
    await chapterView.prose(page).getByText(PARAGRAPHS[2]).first().waitFor({ state: 'visible', timeout: 30_000 })
    measured.versionsAfter = await chapterView.versions(page)
    measured.after = await draftFacts(context.projectPath)
    assert.equal(measured.after.userVersion, 10, '新构建打开后迁到 schema 10')
    assert.deepEqual(measured.after.drafts, measured.before.drafts, '每一稿的章节、版本、状态与正文哈希都不变')
    assert.deepEqual(measured.versionsAfter, measured.versionsBefore, '版本切换器列出的版本不变')
    measured.historyTable = await readProjectDb(context.projectPath, db => db.prepare('SELECT COUNT(*) AS n FROM annotation_history').get().n)
    assert.equal(measured.historyTable, 0)
    return measured
  } },
}
