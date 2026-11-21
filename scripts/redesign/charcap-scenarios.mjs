import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { seedArch } from './arch-scenarios.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import { openAuthorImport } from './import-infer-scenarios.mjs'
import * as arch from './pages/architecture.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { runsStarted, trackOpenedSession } from './real-scenarios.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')
const OUT = process.env.CHARCAP_OUT || path.resolve('.runtime', 'charcap')
const WAIT = 40 * 60_000
const RUNNING = '.stage-capsule:not([data-tone="ok"])'

export const CAST = ['沈砚秋', '沈伯钧', '沈墨林', '柳如棠', '柳承宗', '顾怀瑾', '顾青梧', '陆九', '阿蘅', '韩铁衣', '方鹤年', '苏晚晴', '赵德全', '许仲谋']
const CORE_OUTLINE = '清末淮扬盐商沈家与柳家的恩怨。重要人物共十四位，都要有角色卡：'
  + '沈砚秋（主角，沈家次子）；沈伯钧（沈家家主，砚秋与墨林之父）；沈墨林（沈家长子，与砚秋争家业）；'
  + '柳如棠（柳家长女，砚秋的未婚妻）；柳承宗（柳家家主，如棠之父，沈伯钧的生意对手兼亲家）；'
  + '顾怀瑾（盐运使司同知，幕后反派，多年前陷害过许仲谋）；顾青梧（顾怀瑾之女，如棠的闺中密友，暗中倾心砚秋）；'
  + '陆九（码头把头，砚秋的结义兄弟）；阿蘅（沈家丫鬟，陆九的亲妹妹）；韩铁衣（私盐盐枭首领，与沈墨林暗中勾结）；'
  + '方鹤年（沈家账房，实为顾怀瑾的眼线）；苏晚晴（戏班名伶，沈墨林的情人，韩铁衣的旧相识）；'
  + '赵德全（钱庄掌柜，柳承宗的债主）；许仲谋（砚秋的老师，前任盐运使幕僚，知道顾怀瑾的旧案）。'
const PREMISE = '光绪末年，淮扬盐河两岸，沈家与柳家靠一纸盐引联姻。沈家次子沈砚秋奉父亲沈伯钧之命接手盐栈，长兄沈墨林不甘失势，暗中勾结盐枭韩铁衣走私，并把情人苏晚晴安排进戏班传递消息。'
  + '未婚妻柳如棠的父亲柳承宗欠下钱庄掌柜赵德全的巨债，盐运使司同知顾怀瑾借机设局，要一口吞下两家的盐引；他的女儿顾青梧是如棠的密友，却暗中倾心砚秋。'
  + '沈家账房方鹤年是顾怀瑾的眼线，码头把头陆九与妹妹阿蘅是砚秋仅有的帮手。老师许仲谋握着顾怀瑾旧案的证据。沈砚秋必须在新盐引换发之前查清账目、保住两家，否则沈柳两族都会被抄没。'

/** 记下发往模型的对话请求体与回复原文（请求体不含凭据）。 */
async function teeChat(app) {
  await app.evaluate(() => {
    if (globalThis.__charcapLog) return
    const log = globalThis.__charcapLog = []
    const inner = globalThis.fetch
    globalThis.fetch = async (input, options) => {
      const url = String(input?.url ?? input)
      if (!url.includes('/chat/completions')) return inner(input, options)
      const entry = { started: Date.now() }
      try { entry.request = JSON.parse(options.body) } catch { entry.request = null }
      log.push(entry)
      const response = await inner(input, options)
      entry.status = response.status
      response.clone().text().then(text => { entry.response = text; entry.ms = Date.now() - entry.started }, error => { entry.responseError = String(error) })
      return response
    }
  })
}

function ledger(projectPath) {
  const database = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try {
    return database.prepare('SELECT attempt_json, usage_receipt_json FROM generation_attempts ORDER BY rowid').all()
      .map(row => ({ attempt: JSON.parse(row.attempt_json), receipt: row.usage_receipt_json ? JSON.parse(row.usage_receipt_json) : null }))
  } finally { database.close() }
}

async function sheetText(page) {
  await runSheet.openFromPalette(page)
  return runSheet.sheet(page).innerText()
}

/** 等运行结束；停在「等你确认」时先记下作者看到的卡片再确认。 */
async function untilDone(page, before, seen) {
  const started = Date.now()
  for (;;) {
    const state = await page.evaluate(({ before, selector }) => ({
      started: window.__realRunsStarted.count > before,
      running: [...document.querySelectorAll(selector)].map(node => node.textContent ?? ''),
    }), { before, selector: RUNNING })
    if (state.started && state.running.length === 0) return Date.now() - started
    if (state.running.some(text => text.includes('等你确认'))) {
      await runSheet.openFromPalette(page)
      const card = runSheet.anyCard(page).filter({ hasText: '等你确认' }).first()
      const confirm = card.getByRole('button', { name: /确认/ }).first()
      if (await confirm.isVisible()) {
        seen.push({ at: Date.now() - started, sheet: await runSheet.sheet(page).innerText() })
        await confirm.click()
      }
    }
    if (Date.now() - started > WAIT) throw new Error(`运行 ${WAIT / 60_000} 分钟没有结束\n${(await sheetText(page)).slice(0, 4000)}`)
    await page.waitForTimeout(1000)
  }
}

function save(name, result) {
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${name}-${new Date().toISOString().replace(/[:.]/gu, '')}.json`)
  fs.writeFileSync(file, JSON.stringify(result, null, 2))
  return file
}

async function roster(context, session) {
  const read = await context.invoke(context.page, 'db:character-roster-read', session.projectPath, session)
  return (read.entries ?? []).map(card => ({ name: card.name, role: card.role, relationships: card.relationships ?? [] }))
}

/** 导入反推的角色是待作者批准的提议，不直接进名单：读这份提议里的人物与关系。 */
async function importedProposal(context, session) {
  const pending = await context.invoke(context.page, 'character-proposal:list-pending-finalized', session)
  const batches = await Promise.all(pending.filter(item => item.importOperationId).map(item =>
    context.invoke(context.page, 'character-proposal:read-pending-finalized', { proposalBatchId: item.proposalBatchId }, session)))
  return batches.flatMap(batch => batch.items.map(item => ({ name: item.fields.name, role: item.fields.role, relationships: item.relationships ?? [] })))
}

/** 物理请求数按台账里的尝试计（不按 fetch 计，重试与修复也算）。 */
function requestsByPurpose(rows) {
  const counts = {}
  for (const row of rows) {
    const purpose = row.receipt?.purpose ?? row.attempt?.purpose ?? 'unknown'
    counts[purpose] = (counts[purpose] ?? 0) + 1
  }
  return counts
}

async function seedEmpty(context, core) {
  const { app, page, roots, invoke, reload } = context
  await trackOpenedSession(app)
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name: '盐河旧事', genre: core ? '历史' : '', targetAudience: core ? '成年读者' : '', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  context.samplePath = created.projectPath
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  await context.installRealModels()
  if (core) {
    const session = { projectId: created.projectId, projectPath: created.projectPath, leaseId: opened.project.sessionLease }
    const updated = await invoke(page, 'db:project-core-update', core, created.projectPath, session)
    assert.equal(updated.success, true, updated.error)
  }
  await reload()
  await stage.openFromLibrary(page, '盐河旧事')
}

const OLD_BOOK_CAST = ['韩潮', '沈砚', '何婆婆', '周叔', '沈舟', '阿潮', '老秦']

const SURNAMES = ['沈', '柳', '顾', '陆', '韩', '方', '苏', '赵', '许', '周']
const GIVEN = ['砚', '棠', '梧', '衡']
const FORTY = Array.from({ length: 40 }, (_, index) => `${SURNAMES[index % 10]}${GIVEN[Math.floor(index / 10)]}${'一二三四五六七八九十'[index % 10]}`)
const fortySlot = index => ({ slotId: `s${index + 1}`, name: FORTY[index], role: index === 0 ? 'protagonist' : index === 1 ? 'antagonist' : 'supporting',
  narrativeDuty: '牵动盐引案', relations: [{ targetSlotId: `s${(index + 1) % 40 + 1}`, relation: '欠下人情' }] })

/** 假模型按名单合同回 40 位，按详情合同只回本批点到的 slotId。 */
function fortyReply(prompt) {
  if (prompt.includes('【身份清单合同】')) return JSON.stringify({ slots: FORTY.map((_, index) => fortySlot(index)) })
  const batch = /【本批必须完整生成的 slotId】\n([^\n]+)/u.exec(prompt)
  if (!batch) return null
  return JSON.stringify({ entries: batch[1].split(', ').map(slotId => {
    const slot = fortySlot(Number(slotId.slice(1)) - 1)
    return { slotId, name: slot.name, role: slot.role, gender: '男', age: 30, appearance: '青衫布鞋', personality: '谨慎', background: `${slot.name}在盐河码头谋生。`,
      abilities: '记账', motivation: '保住生计', arc: '从旁观到出手', notes: '无', currentState: { location: '扬州', powerLevel: '普通', physicalState: '健康',
        mentalState: '警觉', keyItems: '一本旧账', recentEvents: '盐引换发在即', updatedAtChapter: 0 } }
  }) })
}

/** 与真实模型测试同样的输出上限 8192。 */
const WIDE_MODEL = Object.freeze({ ...FAKE_MODEL, id: 'charcap-wide', name: '8192 输出夹具', modelName: 'gpt-4.1-mini', maxTokens: 8192,
  capabilities: { contextWindowTokens: 131_072, maxOutputTokens: 8192, reasoning: false, structuredOutput: true, usage: true },
  capabilitySources: { contextWindowTokens: 'manual', maxOutputTokens: 'manual', reasoning: 'preset', structuredOutput: 'preset', usage: 'preset' } })

const seedFortyBook = (model = WIDE_MODEL) => async context => {
  const { app, page, roots, invoke, reload } = context
  await trackOpenedSession(app)
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name: '盐河四十人', genre: '历史', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  context.samplePath = created.projectPath
  assert.equal((await invoke(page, 'llm:save-model', model)).success, true)
  assert.equal((await invoke(page, 'llm:set-default-model', model.id)).success, true)
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const session = { projectId: created.projectId, projectPath: created.projectPath, leaseId: opened.project.sessionLease }
  const updated = await invoke(page, 'db:project-core-update', { premise: PREMISE, coreOutline: `${CORE_OUTLINE}另有盐河两岸二十六位相关人物，共四十位。`,
    totalChapters: 120, wordsPerChapter: 3000 }, created.projectPath, session)
  assert.equal(updated.success, true, updated.error)
  await reload()
  await stage.openFromLibrary(page, '盐河四十人')
}

async function confirmFortyCast(context, shot) {
  const { page, fake } = context
  fake.replyReview(fortyReply)
  await arch.open(page)
  await arch.primary(page).click()
  await arch.dialog(page).waitFor({ state: 'visible' })
  await arch.selectOnly(page, ['characters'])
  await arch.startGenerate(page)
  await runSheet.openFromPalette(page)
  const card = runSheet.anyCard(page).filter({ hasText: '等你确认' }).first()
  await card.waitFor({ state: 'visible', timeout: 180_000 })
  const adoption = card.getByRole('combobox', { name: /^采用方式：/u })
  const candidates = await adoption.count()
  const lastName = await adoption.last().getAttribute('aria-label')
  const relations = await card.getByRole('checkbox').filter({ hasText: '' }).count()
  await card.scrollIntoViewIfNeeded()
  await context.shoot(shot)
  const physical = fake.chats.length
  const promptBytes = fake.chats.map(chat => Buffer.byteLength(chat.messages.map(message => message.content).join(''), 'utf8'))
  await card.getByRole('button', { name: /确认/ }).first().click()
  await runSheet.waitForRunDone(page)
  await page.keyboard.press('Escape')
  const session = await context.app.evaluate(() => globalThis.__driveOpened)
  const cards = await roster(context, session)
  const measured = { candidates, lastName, relations, requests: physical, maxPromptBytes: Math.max(...promptBytes), cards: cards.length,
    cardRelationships: cards.reduce((sum, item) => sum + item.relationships.length, 0) }
  assert.equal(candidates, 40, `确认卡列出 40 位：${JSON.stringify(measured)}`)
  assert.equal(cards.length, 40, `确认后名单 40 张卡：${JSON.stringify(measured)}`)
  return measured
}

export const CHARCAP_SCENARIOS = {
  'real-charcap-arch': { real: true, setup: context => seedEmpty(context, { premise: PREMISE, coreOutline: CORE_OUTLINE, totalChapters: 120, wordsPerChapter: 3000,
    protagonistProfile: '沈砚秋，沈家次子，二十三岁，读过新学，沉稳而倔强。', worldSetting: '光绪末年的淮扬盐区，盐引决定盐商生死，盐运使司握着换发盐引的权柄。' }), run: async context => {
    const { app, page } = context
    await teeChat(app)
    await arch.open(page)
    const seen = []
    const before = await runsStarted(page)
    await arch.primary(page).click()
    await arch.dialog(page).waitFor({ state: 'visible' })
    await arch.selectOnly(page, ['characters'])
    await arch.startGenerate(page)
    const ms = await untilDone(page, before, seen)
    const sheet = await sheetText(page)
    await page.keyboard.press('Escape')
    await arch.waitReady(page)
    await context.shoot('real-charcap-arch-section')
    const session = await app.evaluate(() => globalThis.__driveOpened)
    const cards = await roster(context, session)
    const rows = ledger(context.samplePath)
    const missing = CAST.filter(name => !cards.some(card => card.name === name))
    const relationships = cards.reduce((sum, card) => sum + card.relationships.length, 0)
    const measured = { ms, cardCount: cards.length, missing, relationships, requests: rows.length, byPurpose: requestsByPurpose(rows) }
    const file = save('arch', { ...measured, seen, sheet, cards, chat: await app.evaluate(() => globalThis.__charcapLog), ledger: rows })
    assert.deepEqual(missing, [], `设定点名的人物都有卡：${file}`)
    return { file, ...measured }
  } },

  'real-charcap-import': { real: true, setup: context => seedEmpty(context, null), run: async context => {
    const { app, page } = context
    assert.ok(process.env.CHARCAP_MANUSCRIPT, '要用 CHARCAP_MANUSCRIPT 指向 14 位人物的原稿')
    await teeChat(app)
    const dialog = await openAuthorImport(app, page, '盐河旧事', process.env.CHARCAP_MANUSCRIPT)
    assert.equal(await dialog.getByRole('checkbox', { name: /同时反推设定、架构、角色和蓝图/u }).isChecked(), true, '反推默认勾选')
    const seen = []
    const before = await runsStarted(page)
    await dialog.getByRole('button', { name: /^确认导入（\d+ 章）$/u, disabled: false }).click()
    await dialog.waitFor({ state: 'hidden' })
    const ms = await untilDone(page, before, seen)
    await runSheet.openFromPalette(page)
    await runSheet.tab(page, '诊断').click()
    await page.waitForTimeout(500)
    const sheet = await runSheet.sheet(page).innerText()
    await context.shoot('real-charcap-import-sheet')
    await page.keyboard.press('Escape')
    const session = await app.evaluate(() => globalThis.__driveOpened)
    const cards = await importedProposal(context, session)
    const rows = ledger(context.samplePath)
    const missing = CAST.filter(name => !cards.some(card => card.name === name))
    const relationships = cards.reduce((sum, card) => sum + card.relationships.length, 0)
    const dropped = /已丢弃 (\d+) 条关系/u.exec(sheet)?.[1] ?? '0'
    const unfilled = /(\d+) 位人物没有补出角色卡/u.exec(sheet)?.[1] ?? '0'
    const measured = { ms, cardCount: cards.length, missing, relationships, droppedRelationships: Number(dropped), unfilled: Number(unfilled), requests: rows.length, byPurpose: requestsByPurpose(rows) }
    const file = save('import', { ...measured, seen, sheet, cards, chat: await app.evaluate(() => globalThis.__charcapLog), ledger: rows })
    assert.deepEqual(missing, [], `原稿里的人物都有卡：${file}`)
    return { file, ...measured }
  } },

  /** 名单 40 位、输出上限 8192：确认卡列出全部 40 位候选，确认后名单里 40 张卡。截图停在确认卡。 */
  'charcap-arch-forty': { model: true, shell: 'stage', setup: seedFortyBook(), run: context => confirmFortyCast(context, 'charcap-arch-forty-confirm') },

  /** 输出上限 4096：详情每张单独一次请求，根预算按名单 40 位算（70 次），照样走到确认卡、40 张卡。 */
  'charcap-arch-forty-4096': { model: true, shell: 'stage', setup: seedFortyBook(FAKE_MODEL), run: context => confirmFortyCast(context, 'charcap-arch-forty-4096-confirm') },

  /** 名单三次都撞输出上限：运行卡写明已有角色没动、人物太多、去哪调、用哪个按钮补。 */
  'charcap-arch-truncated': { model: true, shell: 'stage', setup: seedFortyBook(), run: async context => {
    const { page, fake } = context
    const manifest = prompt => prompt.includes('【身份清单合同】')
    fake.replyReview(prompt => manifest(prompt) ? JSON.stringify({ slots: FORTY.map((_, index) => fortySlot(index)) }).slice(0, 900) : null)
    fake.stopAtLength(manifest)
    await arch.open(page)
    await arch.primary(page).click()
    await arch.dialog(page).waitFor({ state: 'visible' })
    await arch.selectOnly(page, ['characters'])
    await arch.startGenerate(page)
    await runSheet.openFromPalette(page)
    const message = runSheet.sheet(page).getByText(/人物太多，模型一次写不下/u).first()
    await message.waitFor({ state: 'visible', timeout: 120_000 })
    const shown = await message.innerText()
    await message.scrollIntoViewIfNeeded()
    await context.shoot('charcap-arch-truncated')
    const manifestRequests = fake.chats.filter(chat => manifest(chat.messages.map(item => item.content).join('\n'))).length
    const measured = { shown, manifestRequests }
    assert.equal(manifestRequests, 3, `名单请求 1 次加整份重写 2 次：${JSON.stringify(measured)}`)
    assert.match(shown, /已有角色没有变动。人物太多，模型一次写不下：到「设置」里模型的「高级设置」调大「最大输出 Tokens」再生成，或在角色名单用「粘贴 \/ 导入角色卡」补上。/u)
    assert.doesNotMatch(shown, /[A-Z_]{8,}/u, '不露原始错误码')
    return measured
  } },

  /** 老书：已有蓝图和 8 张卡。重新生成被守卫拦住，但「新建角色」与「粘贴 / 导入角色卡」照常能加人。 */
  'charcap-oldbook-entries': { model: true, shell: 'stage', setup: seedArch({ characters: OLD_BOOK_CAST }), run: async context => {
    const { page, fake, invoke } = context
    const session = await context.app.evaluate(() => globalThis.__driveOpened)
    const blueprints = await invoke(page, 'db:blueprint-get-all', context.samplePath, session)
    if (await arch.page(page).count() === 0) await arch.open(page)
    else await arch.waitReady(page)
    await arch.openCast(page)
    const names = () => arch.castRoster(page).locator('.cast-row-name').allInnerTexts()
    const before = await names()
    await arch.castRoster(page).getByRole('button', { name: '新建角色' }).click()
    await page.getByLabel('姓名', { exact: true }).fill('白鹭')
    await stage.root(page).locator('.cast-save-state').filter({ hasText: '未保存' }).waitFor()
    await page.keyboard.press('ControlOrMeta+S')
    await stage.root(page).locator('.cast-save-state').filter({ hasText: '已保存' }).waitFor({ timeout: 20_000 })
    fake.replyCharacterCards(1)
    await arch.castRoster(page).getByRole('button', { name: '粘贴 / 导入角色卡' }).click()
    const dialog = page.getByRole('dialog', { name: '粘贴 / 导入角色卡' })
    await dialog.getByLabel('角色卡全文').fill('姓名：守灯人\n身份：北堤灯塔的老看守。')
    await dialog.getByRole('button', { name: 'AI 提取并预览' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '发送并提取' }).click()
    await runSheet.waitUntilOpen(page)
    const card = runSheet.anyCard(page).filter({ hasText: '等你确认' }).first()
    await card.waitFor({ state: 'visible', timeout: 60_000 })
    await card.getByRole('button', { name: /确认/ }).first().click()
    await runSheet.waitForRunDone(page)
    const after = (await roster(context, session)).map(item => item.name)
    await page.keyboard.press('Escape')
    await context.shoot('charcap-oldbook-entries')
    const measured = { blueprints: blueprints.length, before, after }
    assert.ok(blueprints.length > 0, '老书已有蓝图')
    assert.equal(before.length, 8, `老书有 8 张卡：${JSON.stringify(measured)}`)
    assert.ok(after.includes('白鹭') && after.includes('守塔人'), `新建与粘贴导入的人都进了名单：${JSON.stringify(measured)}`)
    assert.equal(after.length, 10, `新建 1 位、粘贴导入 1 位：${JSON.stringify(measured)}`)
    return measured
  } },
}
