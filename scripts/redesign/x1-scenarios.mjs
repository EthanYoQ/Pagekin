import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { proseRequest } from './blueprint-scenarios.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as refs from './pages/refs.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { importMaterials, MATERIALS } from './refs-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE, stageChapterTitle } from './stage-sample.mjs'

export const HARBOR = '港口'
const SKILL_URL = 'https://github.com/owner/skill'

export async function holdChannel(app, channel, { times = 1, after = false } = {}) {
  const ok = await app.evaluate(({ ipcMain }, [channel, times, after]) => {
    const handlers = ipcMain._invokeHandlers
    if (!(handlers instanceof Map) || !handlers.has(channel)) return false
    const original = handlers.get(channel)
    const gate = Promise.withResolvers()
    const state = { remaining: times, waiting: 0, release: gate.resolve }
    ;(globalThis.__driveHolds ??= {})[channel] = state
    handlers.set(channel, async (event, ...args) => {
      if (state.remaining <= 0) return original(event, ...args)
      state.remaining--
      const result = after ? await original(event, ...args) : undefined
      state.waiting++
      try { await gate.promise } finally { state.waiting-- }
      return after ? result : original(event, ...args)
    })
    return true
  }, [channel, times, after])
  assert.ok(ok, `能在主进程里卡住 ${channel}`)
}

export async function untilHeld(app, channel, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (await app.evaluate((_, channel) => globalThis.__driveHolds[channel].waiting, channel) === 0) {
    assert.ok(Date.now() < deadline, `${timeoutMs} ms 内 ${channel} 没有卡在门上`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

export const releaseChannel = (app, channel) => app.evaluate((_, channel) => globalThis.__driveHolds[channel].release(), channel)

async function holdRecentListAfterOpen(app) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const open = handlers.get('project:open')
    const recent = handlers.get('project:recent-list')
    const gate = Promise.withResolvers()
    const state = { waiting: 0, release: gate.resolve }
    ;(globalThis.__driveHolds ??= {})['project:recent-list'] = state
    let opened = false
    handlers.set('project:open', async (...args) => {
      handlers.set('project:open', open)
      opened = true
      return open(...args)
    })
    handlers.set('project:recent-list', async (...args) => {
      if (!opened) return recent(...args)
      handlers.set('project:recent-list', recent)
      state.waiting++
      try { await gate.promise } finally { state.waiting-- }
      return recent(...args)
    })
  })
}

export async function recordCalls(app, channels) {
  const missing = await app.evaluate(({ ipcMain }, channels) => {
    const handlers = ipcMain._invokeHandlers
    const missing = channels.filter(channel => !handlers.has(channel))
    if (missing.length > 0) return missing
    const calls = globalThis.__driveCalls = []
    for (const channel of channels) {
      const original = handlers.get(channel)
      handlers.set(channel, (event, ...args) => {
        calls.push({ channel, projectPath: args.at(-1)?.projectPath ?? null, at: Date.now() })
        return original(event, ...args)
      })
    }
    return []
  }, channels)
  assert.deepEqual(missing, [], `主进程里有要记录的通道：${missing.join('、')}`)
}

const recordedCalls = app => app.evaluate(() => globalThis.__driveCalls)

export async function stubChannel(app, channel, reply) {
  const ok = await app.evaluate(({ ipcMain }, [channel, reply]) => {
    if (!ipcMain._invokeHandlers.has(channel)) return false
    const counts = globalThis.__driveStubs ??= {}
    counts[channel] = 0
    ipcMain._invokeHandlers.set(channel, () => { counts[channel]++; return reply })
    return true
  }, [channel, reply])
  assert.ok(ok, `能在主进程里替换 ${channel}`)
}

const stubCalls = (app, channel) => app.evaluate((_, channel) => globalThis.__driveStubs[channel], channel)

async function untilStubCalls(app, channel, count, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (await stubCalls(app, channel) < count) {
    assert.ok(Date.now() < deadline, `${timeoutMs} ms 内 ${channel} 没有调到第 ${count} 次`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

const discardDialog = page => page.getByRole('dialog', { name: '放弃未保存的修改？' })

function findDirectory(root, name) {
  const found = readdirSync(root, { withFileTypes: true, recursive: true })
    .find(entry => entry.isDirectory() && entry.name === name)
  assert.ok(found, `${root} 下没有 ${name} 目录`)
  return join(found.parentPath, found.name)
}

async function dirtySkillsPage(page) {
  await stage.showSettingsPage(page, '写作 Skills')
  const url = stage.root(page).getByRole('textbox', { name: 'GitHub Skill 地址' })
  await url.fill(SKILL_URL)
  return url
}

async function paletteAction(page, query) {
  await page.keyboard.press('ControlOrMeta+K')
  await stage.paletteInput(page).waitFor({ state: 'visible' })
  await stage.paletteInput(page).fill(query)
  await page.keyboard.press('Enter')
}

export async function seedHarbor(context) {
  const { app, page, roots, invoke } = context
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name: HARBOR, genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const harbor = created.projectPath
  const session = { projectId: created.projectId, projectPath: harbor, leaseId: opened.project.sessionLease }
  for (const [index, title] of STAGE_SAMPLE.titles.slice(0, 3).entries()) {
    assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: index + 1, title, role: '发展', purpose: '港口的线索',
      keyEvents: '林岚在港口找到新的线索', characters: [] }, harbor, session)).success, true)
  }
  const chapters = [1, 2, 3].map(number => {
    const content = number === 3 ? STAGE_SAMPLE.drafts[3].text : STAGE_SAMPLE.finalized[number]
    return { chapterNumber: number, title: stageChapterTitle(number), content, wordCount: countUnits(content) }
  })
  const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(), chapters }, harbor, session)
  assert.equal(imported.success, true, imported.failure?.code)
  const [finalized] = (await invoke(page, 'db:draft-list', 3, harbor, session)).filter(draft => draft.status === 'finalized')
  const full = await invoke(page, 'db:draft-get-full', finalized.id, harbor, session)
  const review = await invoke(page, 'db:review-create', { baseDraftId: full.id, content: STAGE_SAMPLE.drafts[3].review,
    expectedSource: { id: full.id, chapterNumber: 3, version: full.version, status: full.status, content: full.content } }, harbor, session)
  assert.equal(review.success, true, review.failure?.code)
  context.harbor = { path: harbor, chapter3DraftId: full.id }
}

const seedTwoBooks = (options = {}) => async context => {
  await seedHarbor(context)
  await seedStageSample(context, { ...options, beforeReload: async args => {
    const [draft] = await args.invoke(args.page, 'db:draft-list', 3, args.path, args.session)
    context.lighthouseChapter3DraftId = draft.id
    await options.beforeReload?.(args)
  } })
}

const keeperInChapter3 = async ({ page, invoke, path: projectPath, session }) => {
  assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: 3, title: STAGE_SAMPLE.titles[2], role: '发展',
    purpose: '推进灯塔与沉船的线索', keyEvents: '林岚在灯塔里找到新的线索', characters: ['林岚', '守塔人'] }, projectPath, session)).success, true)
}

async function injectDeadKeeper(app) {
  await app.evaluate(({ ipcMain }) => {
    ipcMain._invokeHandlers.set('db:continuity-list-before', () => [{
      draftId: 1, chapterNumber: 1, chapterTitle: '旧港', chapterNotes: '守塔人死于第一章的风暴。',
      source: { draftId: 1, finalizationId: 'drive-fixture', chapterNumber: 1, contentHash: 'a'.repeat(64) },
      sourceStatus: 'current',
      facts: [{ category: 'character-state', entities: ['守塔人'], statement: '守塔人已经死亡。', sourceChapter: 1, evidence: '守塔人在风暴里没有再回来。' }],
    }])
  })
}

async function enterWorkAfterOpening(page) {
  const resume = stage.overview(page, STAGE_SAMPLE.name).getByRole('button', { name: /^继续写作/ })
  await Promise.race([stage.spine(page).waitFor({ state: 'visible' }), resume.waitFor({ state: 'visible' })])
  if (!await stage.spine(page).isVisible()) await resume.click()
  await stage.spine(page).waitFor({ state: 'visible' })
}

async function openWithSlowRecentList(app, page) {
  await stage.previewBook(page, STAGE_SAMPLE.name)
  await holdRecentListAfterOpen(app)
  await stage.overview(page, STAGE_SAMPLE.name).getByRole('button', { name: `打开《${STAGE_SAMPLE.name}》` }).click()
  await untilHeld(app, 'project:recent-list')
  await enterWorkAfterOpening(page)
}

async function lockFile(path) {
  const child = spawn('powershell.exe', ['-NoProfile', '-Command',
    `$f = [System.IO.File]::Open($env:DRIVE_LOCK_PATH, 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Seconds 600`],
  { env: { ...process.env, DRIVE_LOCK_PATH: path }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  const exited = new Promise(resolve => child.once('exit', resolve))
  await Promise.race([
    new Promise(resolve => child.stdout.on('data', chunk => { if (String(chunk).includes('locked')) resolve() })),
    exited.then(code => { throw new Error(`占住文件的进程提前退出：${code}`) }),
  ])
  return () => {
    child.kill()
    return exited
  }
}

export const X1_SCENARIOS = {
  'x1-kb-late-read': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const { app, page } = context
    await importMaterials(context)
    await holdChannel(app, 'kb:read-document-copy')
    await refs.materialButton(page, '守塔人小传').click()
    await untilHeld(app, 'kb:read-document-copy')
    await refs.open(page, 'history')
    await refs.historyChapters(page).waitFor({ state: 'visible' })
    await stage.tab(page, '知识库').click()
    await refs.materialButton(page, '沉船名录').click()
    await assert.doesNotReject(() => page.waitForFunction(text => document.querySelector('textarea[aria-label="项目副本内容"]')?.value === text,
      MATERIALS['沉船名录.txt'], { timeout: 10_000 }), '切回后点的资料读出来了')
    const edited = `${MATERIALS['沉船名录.txt']}启明号的船钟停在三点。`
    await refs.copyEditor(page).fill(edited)
    await releaseChannel(app, 'kb:read-document-copy')
    await page.waitForTimeout(1500)
    const after = { text: await refs.copyEditor(page).inputValue(), dirty: await page.getByText('有未保存的修改').isVisible() }
    assert.deepEqual(after, { text: edited, dirty: true }, '迟到的读取没有盖掉另一份资料的修改')
    return after
  } },

  'x1-setup-leave': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    await stage.stageButton(page, '设定').click()
    await stage.setupOutline(page).waitFor({ state: 'visible' })
    await stage.dirtySetup(page)
    await holdChannel(app, 'project:save')
    await stage.setupNext(page).click()
    await untilHeld(app, 'project:save')
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    await releaseChannel(app, 'project:save')
    await page.waitForTimeout(2000)
    const after = { library: await stage.shelf(page).isVisible(), spine: await stage.spine(page).isVisible() }
    assert.deepEqual(after, { library: true, spine: false }, '保存完成后仍在书房')
    return after
  } },

  'x1-setup-save-remount': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    await stage.stageButton(page, '设定').click()
    await stage.setupOutline(page).waitFor({ state: 'visible' })
    await stage.dirtySetup(page)
    await recordCalls(app, ['project:save'])
    await holdChannel(app, 'project:save')
    await page.keyboard.press('ControlOrMeta+S')
    await untilHeld(app, 'project:save')
    await stage.tab(page, /^第 3 章/).click()
    await stage.setupOutline(page).waitFor({ state: 'hidden' })
    await stage.tab(page, '设定').click()
    await stage.setupOutline(page).waitFor({ state: 'visible' })
    const nextDisabled = await stage.setupNext(page).isDisabled()
    await page.keyboard.press('ControlOrMeta+S')
    await page.waitForTimeout(500)
    await releaseChannel(app, 'project:save')
    await page.waitForTimeout(2000)
    const after = { nextDisabled, saves: (await recordedCalls(app)).length }
    assert.deepEqual(after, { nextDisabled: true, saves: 1 }, '切回后下一步仍不可点，保存只写一次')
    return after
  } },

  'x1-settings-section': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.openSettings(page)
    const url = await dirtySkillsPage(page)
    await paletteAction(page, '设置')
    await discardDialog(page).waitFor({ state: 'visible', timeout: 5000 })
    await discardDialog(page).getByRole('button', { name: '继续编辑' }).click()
    const kept = { page: await stage.currentSettingsPage(page), url: await url.inputValue() }
    assert.deepEqual(kept, { page: '写作 Skills', url: SKILL_URL }, '继续编辑后留在原分区，输入还在')
    await stage.openWorkMenuItem(page, STAGE_SAMPLE.name, '项目备份')
    await discardDialog(page).waitFor({ state: 'visible', timeout: 5000 })
    await discardDialog(page).getByRole('button', { name: '放弃修改' }).click()
    await stage.root(page).getByRole('heading', { level: 1, name: '项目备份', exact: true }).waitFor({ state: 'visible' })
    return kept
  } },

  'skills-import-local': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ app, page, roots, fake, shoot }) => {
    const folder = join(roots.temp, 'scene-voice')
    mkdirSync(join(folder, 'references'), { recursive: true })
    mkdirSync(join(folder, 'scripts'), { recursive: true })
    writeFileSync(join(folder, 'SKILL.md'), [
      '---', 'name: scene-voice', 'description: >-', '  让每一场戏保持统一的叙述声音。', '  起草和修稿时使用。', 'license: Apache-2.0', '---',
      '遵循 [声音规则](references/voice.md)。格式参照 [表单说明](FORMS.md)。收尾前再读一遍 [声音规则](References/Voice.md)。节奏见 [节奏][pace]。',
      '', '[pace]: ./pace.md',
    ].join('\n'))
    writeFileSync(join(folder, 'references', 'voice.md'), '使用第三人称近距离视角，动作先于心理。[返回](../SKILL.md)')
    writeFileSync(join(folder, 'pace.md'), '短句推进动作，长句留给回想。')
    writeFileSync(join(folder, 'scripts', 'lint.py'), 'print("lint")')
    await app.evaluate(({ dialog }, picked) => {
      globalThis.__skillsImportDialog = dialog.showOpenDialog
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })
    }, folder)
    const card = stage.root(page).getByRole('group', { name: '待安装的 Skill' })
    try {
      await stage.openSettings(page)
      await stage.showSettingsPage(page, '写作 Skills')
      await stage.root(page).getByRole('button', { name: '选择文件夹' }).click()
      await card.waitFor({ state: 'visible' })
    } finally {
      await app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = globalThis.__skillsImportDialog
        delete globalThis.__skillsImportDialog
      })
    }
    const inspected = await card.innerText()
    assert.match(inspected, /^并入提示词: references\/voice\.md、pace\.md$/mu, '回链的 SKILL.md 与大小写不同的同一文件只算一次；引用式链接定义指向的 pace.md 也并入')
    assert.match(inspected, /scripts\/lint\.py/u, '检查卡列出不会安装的脚本')
    assert.match(inspected, /模型看不到：FORMS\.md/u, '检查卡列出没有随 Skill 安装的普通链接')
    await shoot('skills-import-local-inspected')
    await card.getByRole('button', { name: '确认安装' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click()
    await card.waitFor({ state: 'hidden' })
    assert.deepEqual(await stage.root(page).getByRole('alert').allInnerTexts(), [], '安装没有报错')
    const drafting = stage.root(page).getByLabel('章节正文 Skill')
    await drafting.selectOption('user:scene-voice')
    await page.waitForFunction(() => document.querySelector('select[aria-label="章节正文 Skill"]')?.value === 'user:scene-voice', null, { timeout: 10_000 })
    const alerts = await stage.root(page).getByRole('alert').allInnerTexts()
    assert.deepEqual(alerts, [], '绑定没有报错')
    const bound = await drafting.inputValue()
    assert.equal(bound, 'user:scene-voice', '安装后的文件夹 Skill 兼容，可以绑定到章节正文')

    const installed = findDirectory(roots.canonical, 'scene-voice')
    const legacy = join(dirname(installed), 'legacy-forms')
    mkdirSync(legacy)
    writeFileSync(join(legacy, 'SKILL.md'), '---\nname: legacy-forms\nlanguage: zh-CN\n---\n按 [表单](forms.md) 的格式写。')
    writeFileSync(join(legacy, 'forms.md'), 'Use the bash tool. 使用搜索工具。')
    await stage.closeSettings(page)
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '写作 Skills')
    const draftingOptions = stage.root(page).getByLabel('章节正文 Skill').locator('option')
    await draftingOptions.filter({ hasText: 'scene-voice' }).waitFor({ state: 'attached' })
    const options = await draftingOptions.evaluateAll(nodes => nodes.map(node => node.value))
    assert.ok(options.includes('user:legacy-forms'), '没有清单的旧 Skill 仍按 master 判为兼容，可以绑定')
    const manifest = JSON.parse(readFileSync(join(installed, '.pagekin-bundle.json'), 'utf8'))
    assert.deepEqual(manifest.files.map(file => file.path), ['references/voice.md', 'pace.md'], '安装清单只列并入的 voice.md 与 pace.md')
    await page.waitForFunction(() => document.querySelector('select[aria-label="章节正文 Skill"]')?.value === 'user:scene-voice', null, { timeout: 10_000 })
    await shoot('skills-import-local-bound')

    await stage.closeSettings(page)
    await blueprint.open(page)
    await blueprint.writeNext(page)
    await runSheet.waitUntilOpen(page)
    const chats = await proseRequest(fake, 60_000)
    const prose = JSON.stringify(chats.find(chat => chat.kind === 'prose').messages)
    assert.ok(prose.includes('使用第三人称近距离视角'), '写正文的请求带上了按清单并入的 voice.md')
    assert.ok(prose.includes('短句推进动作'), '写正文的请求带上了引用式链接指向的 pace.md')
    assert.ok(!prose.includes('print(\\"lint\\")'), '没有安装的脚本不进提示词')
    await runSheet.waitForRunDone(page)
    return { inspected, bound, manifest: manifest.files.map(file => file.path), legacyBindable: true, proseHasBundledFile: true }
  } },

  'x1-write-switch': { model: true, shell: 'stage', setup: seedTwoBooks({ beforeReload: keeperInChapter3 }), run: async context => {
    const { app, page, fake } = context
    await injectDeadKeeper(app)
    await blueprint.open(page)
    await blueprint.writeNext(page)
    await blueprint.preflight(page).waitFor({ state: 'visible' })
    await recordCalls(app, ['db:draft-authority-sequence', 'db:continuity-list-before'])
    await holdChannel(app, 'db:consistency-exemption-save', { after: true })
    await blueprint.preflight(page).getByRole('button', { name: '这是有意安排' }).click()
    await untilHeld(app, 'db:consistency-exemption-save')
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    await stage.openFromPalette(page, HARBOR)
    await page.waitForTimeout(1500)
    const released = Date.now()
    await releaseChannel(app, 'db:consistency-exemption-save')
    await page.waitForTimeout(2500)
    const inHarbor = (await recordedCalls(app)).filter(call => call.at >= released && call.projectPath === context.harbor.path)
    const after = { launchCallsInHarbor: inHarbor.map(call => call.channel), proseRequests: fake.chats.filter(chat => chat.kind === 'prose').length }
    assert.deepEqual(after, { launchCallsInHarbor: [], proseRequests: 0 }, '换到港口后没有按灯塔的蓝图开始写')
    return after
  } },

  'x1-waive-all': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    await chapterView.open(page, 4)
    await chapterView.review(page)
    const sheet = chapterView.reviewSheet(page)
    await sheet.waitFor({ state: 'visible' })
    const waive = sheet.getByRole('button', { name: '不修改此项' })
    await waive.first().waitFor({ state: 'visible' })
    while (await waive.count() > 0) await waive.first().click()
    const confirm = chapterView.view(page).getByRole('button', { name: '确认不修改', exact: true })
    await confirm.waitFor({ state: 'visible', timeout: 5000 })
    await shoot('x1-waive-all-confirm')
    await confirm.click()
    const confirmed = chapterView.hint(page).filter({ hasText: '已确认不修改' })
    await confirmed.waitFor({ state: 'visible' })
    await chapterView.open(page, 3)
    await chapterView.open(page, 4)
    await confirmed.waitFor({ state: 'visible' })
    return { reopened: await chapterView.hint(page).innerText() }
  } },

  'x1-cleanup-retry': { model: true, shell: 'stage', requires: { platform: 'win32' }, setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke, path: projectPath, session }) => {
    const text = `${STAGE_SAMPLE.drafts[3].text}\n\n堤脚的刻痕旁边，又多了一道新刻的线。`
    assert.equal((await invoke(page, 'db:draft-create', { chapterNumber: 3, version: 2, source: 'write', content: text, wordCount: countUnits(text) },
      projectPath, session)).success, true)
  } }), run: async ({ page, shoot, samplePath }) => {
    await chapterView.open(page, 3)
    await chapterView.finalize(page, 3)
    await chapterView.postProcess(page).getByText('4 / 4 完成').waitFor({ state: 'visible', timeout: 90_000 })
    const manuscript = readdirSync(samplePath).find(name => name.startsWith('第3章') && name.endsWith('.txt'))
    assert.ok(manuscript, '定稿写出了第 3 章的正文文件')
    const file = join(samplePath, manuscript)
    const release = await lockFile(file)
    try {
      await chapterView.more(page, '删除正文…')
      await page.getByRole('button', { name: '删除', exact: true }).click()
      const legacy = page.getByRole('button', { name: '我已人工核对/清理，继续删除' })
      if (await legacy.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) await legacy.click()
      const notice = chapterView.view(page).getByText('删除正文后的清理没有完成')
      await notice.waitFor({ state: 'visible', timeout: 15_000 })
      const onDraft = await chapterView.versionButton(page).innerText()
      assert.match(onDraft, /草稿 v1/, '落在第 3 章的未定稿 v1 上')
      const failure = await chapterView.view(page).locator('[role="alert"], [role="status"]').filter({ hasText: '删除正文后的清理没有完成' }).innerText()
      assert.match(failure, /出了意外问题，暂时说不清原因/u, '清理失败的系统原文换成通用说明')
      assert.doesNotMatch(failure, /EBUSY|resource busy/u, '提示里不露系统原文')
      await shoot('x1-cleanup-retry-notice')
      await release()
      await chapterView.view(page).getByRole('button', { name: '重试清理' }).click()
      await notice.waitFor({ state: 'hidden', timeout: 15_000 })
      assert.equal(existsSync(file), false, '重试清理后正文文件已删除')
      return { onDraft, failure: failure.replace(/\s+/g, ' ').slice(0, 200), fileRemoved: true }
    } finally {
      await release()
    }
  } },

  'x1-run-recovery': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake }) => {
    fake.failProse()
    await blueprint.open(page)
    await blueprint.writeNext(page)
    await runSheet.waitUntilOpen(page)
    await runSheet.anyCard(page).filter({ hasText: /^上一次运行/ }).getByText(/失败|出错|未完成/).first().waitFor({ state: 'visible', timeout: 60_000 })
    const entry = runSheet.recovery(page).getByRole('article').filter({ hasText: /第3章候选/ })
    await entry.waitFor({ state: 'visible', timeout: 10_000 })
    return { recovery: await runSheet.recovery(page).getByRole('article').allInnerTexts() }
  } },

  'x1-review-sheet-switch': { model: false, shell: 'stage', setup: seedTwoBooks(), run: async context => {
    const { page } = context
    assert.equal(context.harbor.chapter3DraftId, context.lighthouseChapter3DraftId, '两部作品第 3 章的稿 id 相同')
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    await stage.openFromPalette(page, HARBOR)
    await stage.findChapter(page, '3')
    await chapterView.view(page).waitFor({ state: 'visible' })
    await chapterView.view(page).getByText('已定稿，只读', { exact: true }).waitFor({ state: 'visible' })
    await page.waitForTimeout(1000)
    const after = { reviewSheet: await chapterView.reviewSheet(page).isVisible() }
    assert.deepEqual(after, { reviewSheet: false }, '港口的已定稿章不带着灯塔的审稿侧页')
    return after
  } },

  'x1-waiver-switch': { model: true, shell: 'stage', setup: seedTwoBooks(), run: async ({ app, page }) => {
    await chapterView.open(page, 4)
    await chapterView.review(page)
    const sheet = chapterView.reviewSheet(page)
    const waive = sheet.getByRole('button', { name: '不修改此项' })
    await waive.first().waitFor({ state: 'visible' })
    while (await waive.count() > 0) await waive.first().click()
    const confirm = chapterView.view(page).getByRole('button', { name: '确认不修改', exact: true })
    await confirm.waitFor({ state: 'visible', timeout: 5000 })
    await holdChannel(app, 'db:review-get-full')
    await confirm.click()
    await untilHeld(app, 'db:review-get-full')
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    await stage.openFromPalette(page, HARBOR)
    await runSheet.openFromPalette(page)
    await releaseChannel(app, 'db:review-get-full')
    await page.waitForTimeout(1500)
    const after = { runSheet: await runSheet.sheet(page).isVisible(), reviewSheet: await sheet.isVisible() }
    assert.deepEqual(after, { runSheet: true, reviewSheet: false }, '确认回来后港口里作者开的运行侧页还开着')
    return after
  } },

  'x1-generate-slow-warning': { model: true, shell: 'stage', setup: context => seedStageSample(context, { totalChapters: 16 }), run: async ({ app, page }) => {
    await blueprint.open(page)
    await holdChannel(app, 'db:project-core-get')
    const generating = blueprint.generateRange(page, 13, 16)
    await untilHeld(app, 'db:project-core-get')
    await page.waitForTimeout(4500)
    await releaseChannel(app, 'db:project-core-get')
    assert.equal(await generating, true, '等到了晚出现的警告并点了继续生成')
    await runSheet.waitUntilOpen(page)
    return { warned: true, runSheet: await runSheet.sheet(page).isVisible() }
  } },

  'x1-generate-no-warning': { model: true, shell: 'stage', setup: context => seedStageSample(context, { totalChapters: 16 }), run: async ({ app, page }) => {
    await app.evaluate(({ ipcMain }, cast) => {
      const handlers = ipcMain._invokeHandlers
      const original = handlers.get('db:project-core-get')
      handlers.set('db:project-core-get', async (event, ...args) => ({ ...await original(event, ...args), charactersArch: cast }))
    }, `林岚：守塔人的女儿，沿着父亲的地图寻找沉船。守塔人：在灯塔里守了三十年，知道雾钟坏过的那一次，也知道那条船的名字。`)
    await blueprint.open(page)
    const started = Date.now()
    const warned = await blueprint.generateRange(page, 13, 16)
    const elapsedMs = Date.now() - started
    assert.equal(warned, false, '架构齐全时没有警告')
    return { warned, elapsedMs, runSheet: await runSheet.sheet(page).isVisible() }
  } },

  'x1-import-settings': { model: false, shell: 'stage', setup: seedTwoBooks({ open: false }), run: async context => {
    const { app, page } = context
    await stubChannel(app, 'dialog:select-legacy-project', { grantId: 'drive-legacy', displayName: '旧港口' })
    await stubChannel(app, 'dialog:select-project-restore-target', { grantId: 'drive-target', displayName: '港口' })
    await stubChannel(app, 'project:import-legacy-copy', { state: 'ready', projectId: 'drive-harbor', targetRoot: context.harbor.path })
    await holdChannel(app, 'project:import-legacy-copy')
    await stage.root(page).getByRole('button', { name: /^导入/ }).click()
    await page.getByRole('menuitem', { name: '导入旧项目副本…' }).click()
    await untilHeld(app, 'project:import-legacy-copy')
    await stage.root(page).getByRole('banner').getByRole('button', { name: '设置', exact: true }).click()
    await stage.settingsNav(page).waitFor({ state: 'visible' })
    const url = await dirtySkillsPage(page)
    await releaseChannel(app, 'project:import-legacy-copy')
    await discardDialog(page).waitFor({ state: 'visible', timeout: 10_000 })
    await discardDialog(page).getByRole('button', { name: '继续编辑' }).click()
    await page.waitForTimeout(1000)
    const after = { url: await url.inputValue(), page: await stage.currentSettingsPage(page), spine: await stage.spine(page).isVisible() }
    assert.deepEqual(after, { url: SKILL_URL, page: '写作 Skills', spine: false }, '继续编辑后设置页与输入都在，作品没有打开')
    return after
  } },

  'x1-import-overlap': { model: false, shell: 'stage', setup: seedTwoBooks({ open: false }), run: async context => {
    const { app, page } = context
    await stubChannel(app, 'dialog:select-legacy-project', { grantId: 'drive-legacy', displayName: '旧港口' })
    await stubChannel(app, 'dialog:select-project-restore-target', { grantId: 'drive-target', displayName: '港口' })
    await stubChannel(app, 'project:import-legacy-copy', { state: 'ready', projectId: 'drive-harbor', targetRoot: context.harbor.path })
    await holdChannel(app, 'project:import-legacy-copy')
    const importMenu = stage.root(page).getByRole('button', { name: /^导入/ })
    await importMenu.click()
    await page.getByRole('menuitem', { name: '导入旧项目副本…' }).click()
    await untilHeld(app, 'project:import-legacy-copy')
    await stage.root(page).getByRole('banner').getByRole('button', { name: '设置', exact: true }).click()
    await stage.settingsNav(page).waitFor({ state: 'visible' })
    const url = await dirtySkillsPage(page)
    await releaseChannel(app, 'project:import-legacy-copy')
    await discardDialog(page).waitFor({ state: 'visible', timeout: 10_000 })
    await page.keyboard.press('ControlOrMeta+N')
    const reminded = await page.locator('.pi-toast-title').filter({ hasText: '请先处理「放弃未保存的修改？」' })
      .waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)
    await discardDialog(page).getByRole('button', { name: '继续编辑' }).click()
    await page.waitForTimeout(1000)
    const dialogs = await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').count()
    const typed = await url.inputValue()
    await url.fill('')
    await stage.root(page).getByRole('button', { name: '返回书房' }).click()
    await importMenu.click()
    const importItem = page.getByRole('menuitem', { name: '导入旧项目副本…' })
    await importItem.waitFor({ state: 'visible' })
    const after = { reminded, dialogs, url: typed, importEnabled: await importItem.isEnabled() }
    await page.keyboard.press('Escape')
    assert.deepEqual(after, { reminded: true, dialogs: 0, url: SKILL_URL, importEnabled: true }, '按 Ctrl N 时提示先处理确认框；继续编辑后没有弹新建，导入入口不再占着')
    return after
  } },

  'x1-open-folder-order': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    await stubChannel(app, 'dialog:select-folder', null)
    await stage.openSettings(page)
    const url = await dirtySkillsPage(page)
    const asked = []
    for (const open of [() => page.keyboard.press('ControlOrMeta+O'), () => stage.openWorkMenuItem(page, STAGE_SAMPLE.name, '打开其他作品…')]) {
      await open()
      await discardDialog(page).waitFor({ state: 'visible', timeout: 5000 })
      asked.push(await stubCalls(app, 'dialog:select-folder'))
      await discardDialog(page).getByRole('button', { name: '继续编辑' }).click()
    }
    const after = { folderDialogsBeforeAnswer: asked, folderDialogs: await stubCalls(app, 'dialog:select-folder'), url: await url.inputValue() }
    assert.deepEqual(after, { folderDialogsBeforeAnswer: [0, 0], folderDialogs: 0, url: SKILL_URL }, '先问放弃，继续编辑就不弹选文件夹')
    return after
  } },

  'x1-open-folder-cancel': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    await stubChannel(app, 'dialog:select-folder', null)
    await stage.openSettings(page)
    const url = await dirtySkillsPage(page)
    const opens = [() => page.keyboard.press('ControlOrMeta+O'), () => stage.openWorkMenuItem(page, STAGE_SAMPLE.name, '打开其他作品…'), async () => {
      await url.fill('')
      await page.keyboard.press('ControlOrMeta+O')
    }]
    const after = []
    for (const [index, open] of opens.entries()) {
      await open()
      const asked = await discardDialog(page).waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)
      if (asked) await discardDialog(page).getByRole('button', { name: '放弃修改' }).click()
      await untilStubCalls(app, 'dialog:select-folder', index + 1)
      await page.waitForTimeout(800)
      after.push({ settings: await stage.settingsNav(page).isVisible(), url: await url.isVisible() ? await url.inputValue() : null })
      if (!after.at(-1).settings) break
    }
    assert.deepEqual(after, [
      { settings: true, url: SKILL_URL },
      { settings: true, url: SKILL_URL },
      { settings: true, url: '' },
    ], '取消选文件夹后设置页还开着，放弃过的输入也还在')
    return after
  } },

  'x1-open-folder-pick': { model: false, shell: 'stage', setup: seedTwoBooks(), run: async context => {
    const { app, page } = context
    await app.evaluate(({ dialog }, selectedPath) => {
      globalThis.__drivePicks = 0
      dialog.showOpenDialog = async () => { globalThis.__drivePicks++; return { canceled: false, filePaths: [selectedPath] } }
    }, context.harbor.path)
    await stage.openSettings(page)
    await dirtySkillsPage(page)
    await page.keyboard.press('ControlOrMeta+O')
    await discardDialog(page).waitFor({ state: 'visible', timeout: 5000 })
    const picksBeforeAnswer = await app.evaluate(() => globalThis.__drivePicks)
    await discardDialog(page).getByRole('button', { name: '放弃修改' }).click()
    const harborMenu = stage.root(page).getByRole('banner').getByRole('button', { name: `《${HARBOR}》作品菜单` })
    await harborMenu.waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(1000)
    const after = { picksBeforeAnswer, picks: await app.evaluate(() => globalThis.__drivePicks),
      settings: await stage.settingsNav(page).isVisible(), askedAgain: await discardDialog(page).isVisible() }
    assert.deepEqual(after, { picksBeforeAnswer: 0, picks: 1, settings: false, askedAgain: false }, '放弃后才选文件夹，选到港口就收起设置页打开它，不再问')
    return after
  } },

  'x1-library-return': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    await holdRecentListAfterOpen(app)
    await page.keyboard.press('ControlOrMeta+K')
    await stage.paletteInput(page).fill(STAGE_SAMPLE.name)
    await stage.palette(page).getByRole('option', { name: `打开《${STAGE_SAMPLE.name}》` }).click()
    await untilHeld(app, 'project:recent-list')
    await enterWorkAfterOpening(page)
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    await releaseChannel(app, 'project:recent-list')
    await page.waitForTimeout(2000)
    const after = { library: await stage.shelf(page).isVisible(), spine: await stage.spine(page).isVisible() }
    assert.deepEqual(after, { library: true, spine: false }, '打开返回后仍在书房')
    return after
  } },

  'x1-run-sheet-keep': { model: false, shell: 'stage', setup: context => seedStageSample(context, { open: false }), run: async ({ app, page }) => {
    await openWithSlowRecentList(app, page)
    await runSheet.openFromPalette(page)
    await releaseChannel(app, 'project:recent-list')
    await page.waitForTimeout(2000)
    const after = { runSheet: await runSheet.sheet(page).isVisible() }
    assert.deepEqual(after, { runSheet: true }, '打开返回后运行侧页仍开着')
    return after
  } },
}
