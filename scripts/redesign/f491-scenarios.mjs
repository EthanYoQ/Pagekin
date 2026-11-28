import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import * as architecture from './pages/architecture.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { FIXTURE_PROSE } from './fake-model.mjs'
import { countUnits, STAGE_SAMPLE, stageChapterTitle } from './stage-sample.mjs'
import { firstLine, seedStageSample } from './scenarios.mjs'

const CHAPTER_UPDATES = [
  { marker: '灯室的门没有锁', evidence: '林岚把纸条夹进父亲的地图里。',
    currentState: { location: '灯塔顶层灯室', keyItems: '父亲的地图、钟绳上的纸条', recentEvents: '在灯室找到「别在涨潮时敲钟」的纸条' } },
  { marker: '守塔人的屋子在灯塔背风的一侧', evidence: '「你父亲也问过钟的事。」',
    currentState: { location: '守塔人的屋子', recentEvents: '守塔人说父亲也问过钟的事' } },
]

export function characterStateReply(prompt) {
  const id = /"characterId": "([^"]+)",\s*"name": "林岚"/u.exec(prompt)?.[1]
  const update = CHAPTER_UPDATES.find(item => prompt.includes(item.marker))
  if (!id || !update) return '{"updates":[]}'
  return JSON.stringify({ updates: [{ characterId: id, currentState: update.currentState, evidence: { text: update.evidence } }] })
}

async function openForDriver({ page, invoke }, projectPath) {
  const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  return { projectId: opened.project.id, projectPath, leaseId: opened.project.sessionLease }
}

async function stubDialogs(app, { save, open }) {
  await app.evaluate(({ dialog }, paths) => {
    globalThis.__f491Dialogs ??= { save: dialog.showSaveDialog, open: dialog.showOpenDialog }
    if (paths.save) dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.save })
    if (paths.open) dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.open] })
  }, { save, open })
}

export async function exportAndRestore(context, projectPath, label) {
  const { app, page, invoke, roots } = context
  const session = await openForDriver(context, projectPath)
  const archive = path.join(roots.projects, `${label}.ainovel`)
  await stubDialogs(app, { save: archive })
  const exportGrant = await invoke(page, 'dialog:select-project-archive-export', STAGE_SAMPLE.name)
  const exported = await invoke(page, 'project:archive-export', { targetArchiveGrantId: exportGrant.grantId, projectSession: session })
  assert.equal(exported.success, true, JSON.stringify(exported))
  await stubDialogs(app, { open: archive })
  const archiveGrant = await invoke(page, 'dialog:select-project-archive')
  const parent = path.join(roots.projects, label)
  fs.mkdirSync(parent)
  await stubDialogs(app, { open: parent })
  const targetGrant = await invoke(page, 'dialog:select-project-restore-target', STAGE_SAMPLE.name)
  const restored = await invoke(page, 'project:archive-restore', { archiveGrantId: archiveGrant.grantId, targetGrantId: targetGrant.grantId })
  assert.equal(restored.success, true, JSON.stringify(restored))
  return restored.receipt.targetProjectRoot
}

export async function openInUi({ app, page }, projectPath) {
  await stubDialogs(app, { open: projectPath })
  await page.keyboard.press('ControlOrMeta+O')
  await stage.spine(page).waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForTimeout(2000)
}

export async function openCharacterState(page) {
  await architecture.open(page)
  await architecture.openCast(page)
  await architecture.castRow(page, '林岚').click()
  await stage.root(page).getByRole('group', { name: '档案视图' }).getByRole('button', { name: '当前状态', exact: true }).click()
}

export async function stateFields(page) {
  return stage.root(page).locator('.cast-grid .cast-field').evaluateAll(fields => fields.map(field => ({
    label: field.querySelector('label')?.textContent?.trim(),
    hint: field.querySelector('.cast-field-hint')?.textContent?.trim() ?? null,
    value: field.querySelector('textarea')?.value ?? null,
    history: field.querySelector('.cast-field-history')?.textContent?.trim() ?? null,
  })))
}

const settled = page => page.waitForFunction(() => {
  const rows = [...document.querySelectorAll('[aria-label="定稿后处理"] li')]
  return rows.some(row => row.querySelector('b')?.textContent === '角色状态更新')
    && rows.every(row => row.dataset.state === 'success' || row.dataset.state === 'failed')
    && !document.querySelector('.stage-capsule:not([data-tone="ok"])')
}, null, { timeout: 90_000 })

export async function openChapter(page, chapterNumber) {
  if (!await stage.chapterButton(page, chapterNumber).isVisible()) await stage.stageButton(page, '正文').click()
  await chapterView.open(page, chapterNumber)
}

export async function finalizeChapter(page, chapterNumber) {
  await openChapter(page, chapterNumber)
  await chapterView.finalize(page, chapterNumber)
  await settled(page)
}

export const postDetail = page => chapterView.postProcess(page).locator('li[data-state="failed"]').filter({ has: page.locator('b', { hasText: /^角色状态更新$/u }) })
  .locator('.stage-ch-post-detail')

async function continuityNodes(projectPath) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(projectPath, '.ai-novel', 'project.db'), { readOnly: true })
  try {
    return db.prepare(`SELECT e.aspect,e.value,e.effective_chapter,e.provenance_json,e.evidence_json,d.chapter_number,d.status
      FROM character_continuity_events e JOIN drafts d ON d.id=e.draft_id ORDER BY e.effective_chapter,e.aspect`).all().map(row => ({ ...row }))
  } finally { db.close() }
}

const seedHandEditedState = context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path, session }) => {
  const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(), chapters: [3, 4].map(number => {
    const content = STAGE_SAMPLE.drafts[number].text
    return { chapterNumber: number, title: stageChapterTitle(number), content, wordCount: countUnits(content) }
  }) }, path, session)
  assert.equal(imported.success, true, imported.failure?.code)
  assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: 5, title: stageChapterTitle(5), role: '发展', purpose: '推进灯塔与沉船的线索',
    keyEvents: '林岚在灯塔里找到新的线索', characters: ['林岚'] }, path, session)).success, true)
  const roster = await invoke(page, 'db:character-roster-read', path, session)
  const entries = roster.entries.map(entry => entry.name === '林岚' ? { ...entry, currentState: { powerLevel: '', physicalState: '', mentalState: '', keyItems: '', recentEvents: '', updatedAtChapter: 4, ...entry.currentState, location: '钟楼顶层' } } : entry)
  assert.equal((await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
    expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit', entries }, path, session)).success, true)
} })

async function readAuthorNodes(projectPath) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(projectPath, '.ai-novel', 'project.db'), { readOnly: true })
  try {
    return db.prepare("SELECT aspect,value,effective_chapter FROM character_continuity_events WHERE json_extract(provenance_json,'$.kind')='author'").all().map(row => ({ ...row }))
  } finally { db.close() }
}

export const F491_SCENARIOS = {
  'c4-timeline-draft-prompt': { model: true, shell: 'stage', setup: seedHandEditedState, run: async ({ page, fake }) => {
    await chapterView.open(page, 5)
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    await chapterView.prose(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 90_000 })
    const prose = fake.chats.filter(chat => chat.kind === 'prose')
    assert.equal(prose.length, 1, '写第 5 章只发一次正文请求')
    const prompt = prose[0].messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
    const profile = prompt.split('\n').find(line => line.startsWith('林岚 (')) ?? ''
    assert.match(profile, /作者设定（自第5章起）位置：钟楼顶层/u, '手改的状态以时间线的写法进最终提示词')
    assert.doesNotMatch(profile, /location@chapter/u, '档案原来的状态行被替换，不重复')
    return { profile }
  } },

  'c2-continuity-nodes-finalize': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    context.fake.replyCharacterState(characterStateReply)
    await finalizeChapter(context.page, 3)
    await finalizeChapter(context.page, 4)
    const nodes = await continuityNodes(context.samplePath)
    const expected = CHAPTER_UPDATES.flatMap((update, index) => Object.entries(update.currentState).map(([aspect, value]) =>
      ({ aspect, value, chapter: 3 + index, quote: update.evidence })))
    const summary = list => list.map(item => JSON.stringify(item)).sort()
    assert.deepEqual(summary(nodes.map(node => ({ aspect: node.aspect, value: node.value, chapter: node.effective_chapter, quote: JSON.parse(node.evidence_json).quote.text }))),
      summary(expected), '定稿写入的派生节点与模型回复逐字段一致')
    assert.ok(nodes.every(node => JSON.parse(node.provenance_json).kind === 'derived' && node.chapter_number === node.effective_chapter && node.status === 'finalized'),
      `节点来历为派生，绑定本章定稿。实际：${JSON.stringify(nodes)}`)
    return { nodes: nodes.map(node => `${node.effective_chapter}:${node.aspect}`) }
  } },

  'c3-character-timeline': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    context.fake.replyCharacterState(characterStateReply)
    await finalizeChapter(context.page, 3)
    await finalizeChapter(context.page, 4)
    const { page } = context
    await openCharacterState(page)
    const profile = stage.root(page).locator('.cast-profile')
    const summary = profile.locator('.cast-timeline-summary')
    await summary.waitFor({ state: 'visible' })
    const measured = { summary: await summary.innerText() }
    assert.equal(measured.summary.trim(), '时间线 · 5 处变化', '第 3 章三个字段加第 4 章两个字段')
    assert.equal(await profile.locator('.cast-timeline-list').isVisible(), false, '默认收起')
    await context.shoot('c3-1-collapsed')

    await summary.click()
    const headings = () => profile.locator('.cast-timeline-chapter h3').allInnerTexts()
    measured.chapters = await headings()
    assert.deepEqual(measured.chapters, ['第 4 章', '第 3 章'], '按章倒序')
    await profile.locator('.cast-timeline-quote summary').first().click()
    measured.quote = await profile.locator('.cast-timeline-quote blockquote').first().innerText()
    assert.equal(measured.quote, CHAPTER_UPDATES[1].evidence, '第 4 章的原文证据')
    await context.shoot('c3-2-expanded')

    const location = profile.locator('.cast-grid textarea').first()
    await location.fill('灯塔外的礁石')
    const note = profile.locator('.cast-state-chapter')
    await note.waitFor({ state: 'visible' })
    measured.defaultNote = await note.innerText()
    assert.match(measured.defaultNote, /手改的状态从第 5 章起生效/u, '已定稿到第 4 章，默认下一章')
    await note.getByRole('button', { name: '改章号' }).click()
    await note.locator('input').fill('7')
    measured.chosenNote = await note.innerText()
    assert.match(measured.chosenNote, /手改的状态从第 7 章起生效/u, '所选章号进说明')
    await context.shoot('c3-3-chosen-chapter')

    await profile.getByRole('button', { name: '保存角色' }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('.cast-timeline-chapter h3')].some(item => item.textContent === '第 7 章'), null, { timeout: 15_000 })
    measured.afterSave = await headings()
    assert.deepEqual(measured.afterSave, ['第 7 章', '第 4 章', '第 3 章'], '节点按所选章写入并显示')
    await context.shoot('c3-4-after-save')
    const authored = (await readAuthorNodes(context.samplePath)).filter(node => node.aspect === 'location')
    assert.deepEqual(authored.map(node => [node.value, node.effective_chapter]), [['灯塔外的礁石', 7]], '库里的节点')
    return measured
  } },
}
