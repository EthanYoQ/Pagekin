// #702 大部头卡顿的实机计时：N 章已定稿正文（每章约 3000 字）、200 章蓝图、12 位角色，正文按模板生成。
// 环境变量：
//   PERF702_PROFILE_DIR  录 CPU profile 的目录；PERF702_PROFILE 是标签的正则，只录匹配的操作（不设时全录）。报出的耗时只取不录 profile 的会话。
//   PERF702_LOG          每个计时操作追加一行 JSON，场景中途失败也不丢已量到的数。
//   PERF702_SAVE         批量造书时在 PERF702_CHECKPOINTS（默认 10,50,112）章处退出应用，把作品存到 <SAVE>/<章数>/projects/盐湖。
//   PERF702_FIXTURE      perf702-reuse 复制这份作品（<FIXTURE>/projects/盐湖）进隔离目录再计时；PERF702_FINALIZED 是它的定稿章数。
//   PERF702_BLUEPRINTS   新造作品的蓝图条数，默认 200。
//   perf702-review-cycle 每章审稿、按意见修稿、合并、复核、定稿各一轮，写到 PERF702_FINALIZED（默认 112）章；存档同 PERF702_SAVE。
//   PERF702_SQL=0        不包 SQL 账本（对照账本本身的开销）。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { STAGE_SAMPLE, countUnits } from './stage-sample.mjs'

const BOOK = '盐湖'
const BLUEPRINTS = Number(process.env.PERF702_BLUEPRINTS ?? 200)
const CHAPTER_UNITS = 3000
const CHARACTERS = ['林岚', '守塔人', '沈默', '许青', '老周', '阿禾', '程远', '苏梅', '韩九', '小满', '陆川', '白鹭']
/** 每句都带章号与段号：相邻两章没有相同的句子，过得了「新章节开头重演上一章结尾」的检查。 */
const SENTENCES = [
  (chapter, paragraph) => `风从盐湖的北岸吹过来，第${chapter}夜第${paragraph}阵带着铁锈和旧木头的气味。`,
  (chapter, paragraph) => `她把地图摊在膝头，一格一格数过去，数到第${chapter + paragraph}条堤时停了下来。`,
  (chapter, paragraph) => `守塔人说第${chapter}夜的钟声又早了${paragraph}刻，可潮水没有任何变化。`,
  (chapter, paragraph) => `远处的航标灯亮了${paragraph}盏，一路亮到第${chapter}号海湾。`,
  (chapter, paragraph) => `档案室第${chapter}卷第${paragraph}页受了潮，字迹像被雾气泡软的盐霜。`,
  (chapter, paragraph) => `他沉默了${chapter}息，才把第${paragraph}把铜钥匙放回抽屉最里面。`,
]
export const PROSE_PROBE = '风从盐湖的北岸吹过来'

export const chapterTitle = number => `远航之${number}`
/** 每章开头带章号，计时与角色状态的引文据此认出是哪一章。 */
export const chapterMarker = number => `第${number}夜的潮水退得很慢。`

export function chapterText(number, units = CHAPTER_UNITS) {
  const paragraphs = [chapterMarker(number)]
  for (let index = 1; countUnits(paragraphs.join('\n\n')) < units; index++) {
    const sentences = SENTENCES.map(sentence => sentence(number, index))
    paragraphs.push(`${CHARACTERS[(number + index) % CHARACTERS.length]}在第${number}章第${index}段里想起了这件事。${sentences.join('')}`)
  }
  return paragraphs.join('\n\n')
}

const SEED_CORE = { coreOutline: '测绘师追查父亲留下的失踪地图。', premise: '一座本该停用的灯塔仍在夜里报时。',
  worldbuilding: '旧港靠潮汐与灯塔维持秩序。', synopsis: '三幕：抵达、追查、风暴前夜。' }

/** 新建作品并写满：设定、角色、BLUEPRINTS 章蓝图、前 finalized 章定稿。落在书房，作品没打开。 */
export async function seedLargeBook(context, finalized, { blueprints: withBlueprints = true, core = SEED_CORE } = {}) {
  const { app, page, roots, invoke, reload } = context
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name: BOOK, genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const projectPath = created.projectPath
  const session = { projectId: created.projectId, projectPath, leaseId: opened.project.sessionLease }
  assert.equal((await invoke(page, 'llm:save-model', FAKE_MODEL)).success, true)
  assert.equal((await invoke(page, 'llm:set-default-model', FAKE_MODEL.id)).success, true)
  const roster = await invoke(page, 'db:character-roster-read', projectPath, session)
  const committed = await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
    expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit',
    entries: CHARACTERS.map((name, index) => ({ characterId: `draft:${randomUUID()}`, name, role: index === 0 ? 'protagonist' : 'supporting',
      gender: '', age: '', appearance: '', personality: '', background: `${name}在旧港长大。`, abilities: '', motivation: '查明沉船的来历。',
      relationships: [], arc: '', notes: '' })) }, projectPath, session)
  assert.equal(committed.success, true, committed.error)
  const updated = await invoke(page, 'db:project-core-update', { ...core, totalChapters: BLUEPRINTS, wordsPerChapter: CHAPTER_UNITS }, projectPath, session)
  assert.equal(updated.success, true, updated.error)
  const blueprints = Array.from({ length: BLUEPRINTS }, (_, index) => ({ chapterNumber: index + 1, title: chapterTitle(index + 1), role: '发展',
    purpose: '推进灯塔与沉船的线索', keyEvents: '林岚在灯塔里找到新的线索', characters: CHARACTERS.slice(0, 3), suspenseHook: '', userGuidance: '', notes: '' }))
  if (withBlueprints) assert.equal((await invoke(page, 'db:blueprint-upsert-many', blueprints, projectPath, session)).success, true)
  for (let start = 1; start <= finalized; start += 20) {
    const chapters = Array.from({ length: Math.min(20, finalized - start + 1) }, (_, index) => {
      const content = chapterText(start + index)
      return { chapterNumber: start + index, title: chapterTitle(start + index), content, wordCount: countUnits(content) }
    })
    const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(), chapters }, projectPath, session)
    assert.equal(imported.success, true, imported.error)
  }
  await reload()
  return { projectPath, session }
}

const profileFilter = process.env.PERF702_PROFILE ? new RegExp(process.env.PERF702_PROFILE, 'u') : null

/** 录一段操作期间渲染进程与主进程的 CPU profile，写成可用 DevTools 打开的 .cpuprofile。 */
async function profiled({ app, page }, label, action) {
  const directory = process.env.PERF702_PROFILE_DIR
  if (!directory || (profileFilter && !profileFilter.test(label))) return action()
  fs.mkdirSync(directory, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 250 })
  await cdp.send('Profiler.start')
  await app.evaluate(() => new Promise((resolve, reject) => {
    const inspector = process.getBuiltinModule('node:inspector')
    const session = new inspector.Session()
    session.connect()
    globalThis.__perfProfiler = session
    session.post('Profiler.enable', error => error ? reject(error) : session.post('Profiler.setSamplingInterval', { interval: 250 },
      () => session.post('Profiler.start', started => started ? reject(started) : resolve())))
  }))
  try { return await action() } finally {
    const main = await app.evaluate(() => new Promise((resolve, reject) => globalThis.__perfProfiler.post('Profiler.stop', (error, result) => {
      globalThis.__perfProfiler.disconnect()
      return error ? reject(error) : resolve(JSON.stringify(result.profile))
    })))
    const { profile } = await cdp.send('Profiler.stop')
    await cdp.detach()
    fs.writeFileSync(path.join(directory, `${label}-main.cpuprofile`), main)
    fs.writeFileSync(path.join(directory, `${label}-renderer.cpuprofile`), JSON.stringify(profile))
  }
}

/**
 * 主进程账本：每个 invoke 通道的调用次数与累计耗时；child_process.spawn 的次数与子进程存活总时长（安全文件层每次读写都起一个 PowerShell）；
 * 每条 SQL 的执行次数、返回行数与耗时；事件循环最长一次阻塞。渲染进程记 longtask。
 * 次数与机器快慢无关，章数翻倍时它涨不涨，比毫秒更能说明问题。每次启动后都要重装。
 */
async function installLedger(app, page) {
  await app.evaluate(({ ipcMain, app: electronApp }, wrapSql) => {
    if (globalThis.__perfLedger) return
    const ledger = globalThis.__perfLedger = { channels: {}, spawns: { calls: 0, ms: 0, kinds: {} }, sql: {} }
    const wrap = (channel, handler) => async (...args) => {
      const session = args.at(-1)
      if (session && typeof session === 'object' && typeof session.leaseId === 'string') globalThis.__perfSession = { event: args[0], session }
      const startedAt = performance.now()
      try { return await handler(...args) } finally {
        const entry = ledger.channels[channel] ??= { calls: 0, ms: 0 }
        entry.calls += 1
        entry.ms += performance.now() - startedAt
      }
    }
    for (const [channel, handler] of ipcMain._invokeHandlers) ipcMain._invokeHandlers.set(channel, wrap(channel, handler))
    const handle = ipcMain.handle.bind(ipcMain)
    ipcMain.handle = (channel, handler) => handle(channel, wrap(channel, handler))
    const childProcess = process.getBuiltinModule('node:child_process')
    const spawn = childProcess.spawn
    childProcess.spawn = (...args) => {
      const startedAt = performance.now()
      const child = spawn(...args)
      const kind = path => String(path).split(/[\\/]/u).pop()
      const name = [args[0], ...(Array.isArray(args[1]) ? args[1].filter(arg => /\.(ps1|exe|cmd|bat)$/iu.test(arg)) : [])].map(kind).join(' ')
      const entry = ledger.spawns.kinds[name] ??= { calls: 0, ms: 0 }
      ledger.spawns.calls += 1
      entry.calls += 1
      child.once('exit', () => { const ms = performance.now() - startedAt; ledger.spawns.ms += ms; entry.ms += ms })
      return child
    }
    process.getBuiltinModule('node:module').syncBuiltinESMExports()
    const histogram = ledger.loop = process.getBuiltinModule('node:perf_hooks').monitorEventLoopDelay({ resolution: 5 })
    histogram.enable()
    if (!wrapSql) return
    const require = process.getBuiltinModule('node:module').createRequire(process.getBuiltinModule('node:path').join(electronApp.getAppPath(), 'package.json'))
    const Database = require('better-sqlite3')
    const scratch = new Database(':memory:')
    const statement = Object.getPrototypeOf(scratch.prepare('SELECT 1'))
    scratch.close()
    const sqlEntry = source => ledger.sql[source.replace(/\s+/gu, ' ')] ??= { calls: 0, rows: 0, ms: 0 }
    for (const method of ['run', 'get', 'all']) {
      const original = statement[method]
      statement[method] = function (...args) {
        const startedAt = performance.now()
        const result = original.apply(this, args)
        const entry = sqlEntry(this.source)
        entry.calls += 1
        entry.ms += performance.now() - startedAt
        entry.rows += method === 'all' ? result.length : method === 'get' ? (result === undefined ? 0 : 1) : result.changes
        return result
      }
    }
    const iterate = statement.iterate
    statement.iterate = function (...args) {
      const inner = iterate.apply(this, args)
      const entry = sqlEntry(this.source)
      entry.calls += 1
      return {
        [Symbol.iterator]() { return this },
        next() {
          const startedAt = performance.now()
          const step = inner.next()
          entry.ms += performance.now() - startedAt
          if (!step.done) entry.rows += 1
          return step
        },
        return(value) { return inner.return ? inner.return(value) : { done: true, value } },
      }
    }
    // exec 不经过 prepare（如蓝图提交的建表补数），整段算一次调用，行数不计。
    const exec = Database.prototype.exec
    Database.prototype.exec = function (source) {
      const startedAt = performance.now()
      const result = exec.call(this, source)
      const entry = sqlEntry(source)
      entry.calls += 1
      entry.ms += performance.now() - startedAt
      return result
    }
  }, process.env.PERF702_SQL !== '0')
  await page.evaluate(() => {
    if (window.__perfLong) return
    window.__perfLong = { count: 0, ms: 0, max: 0 }
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        window.__perfLong.count += 1
        window.__perfLong.ms += entry.duration
        window.__perfLong.max = Math.max(window.__perfLong.max, entry.duration)
      }
    }).observe({ type: 'longtask' })
  })
}

async function takeLedger(app, page) {
  const main = await app.evaluate(() => {
    const { channels, spawns, sql, loop } = globalThis.__perfLedger
    Object.assign(globalThis.__perfLedger, { channels: {}, spawns: { calls: 0, ms: 0, kinds: {} }, sql: {} })
    const maxBlockMs = Math.round(loop.max / 1e6)
    loop.reset()
    const round = ([key, { calls, ms, rows }]) => [key, { calls, ms: Math.round(ms), ...rows === undefined ? {} : { rows } }]
    const sqlEntries = Object.entries(sql)
    return {
      ipcCalls: Object.values(channels).reduce((sum, entry) => sum + entry.calls, 0),
      ipc: Object.fromEntries(Object.entries(channels).sort(([, a], [, b]) => b.ms - a.ms).slice(0, 10).map(round)),
      spawns: spawns.calls, spawnMs: Math.round(spawns.ms), spawnKinds: Object.fromEntries(Object.entries(spawns.kinds).map(round)),
      sqlCalls: sqlEntries.reduce((sum, [, entry]) => sum + entry.calls, 0),
      sqlRows: sqlEntries.reduce((sum, [, entry]) => sum + entry.rows, 0),
      sqlMs: Math.round(sqlEntries.reduce((sum, [, entry]) => sum + entry.ms, 0)),
      sqlTop: Object.fromEntries(sqlEntries.sort(([, a], [, b]) => b.ms - a.ms).slice(0, 12).map(round)),
      mainMaxBlockMs: maxBlockMs,
    }
  })
  const renderer = await page.evaluate(() => {
    const value = window.__perfLong
    if (!value) return { longTasks: null }
    window.__perfLong = { count: 0, ms: 0, max: 0 }
    return { longTasks: value.count, longTaskMs: Math.round(value.ms), longTaskMax: Math.round(value.max) }
  }).catch(() => ({ longTasks: null }))
  return { ...main, ...renderer }
}

/** 每类模型请求的次数与提示词字符数（假模型立即作答，模型耗时为零；提示词变长只影响真实模型）。 */
function promptStats(fake, since) {
  const stats = {}
  for (const chat of fake.chats.slice(since)) {
    const entry = stats[chat.kind] ??= { calls: 0, chars: 0 }
    entry.calls += 1
    entry.chars += [chat.system ?? '', ...(chat.messages ?? []).map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))].join('\n').length
  }
  return stats
}

function log(record) {
  if (process.env.PERF702_LOG) fs.appendFileSync(process.env.PERF702_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`)
  return record
}

/** 一次计时操作：耗时、这段时间主进程与渲染进程的账本、模型请求，按需录 profile。 */
async function operation(context, label, action) {
  await takeLedger(context.app, context.page)
  const since = context.fake.chats.length
  const ms = await profiled(context, label, action)
  return log({ label, ms, ...await takeLedger(context.app, context.page), prompts: promptStats(context.fake, since) })
}

const prose = '.stage-content .cm-content'
const SPINE = 'nav[aria-label="创作流程"]'
/** 打开作品与点「正文」都落在第一章待写：定稿章之后那一章。 */
const EMPTY_CHAPTER = '这一章还是空白'

/** 从点击 target 到每个 [选择器, 文字] 依次出现在画面上的毫秒数；同时记点击后渲染进程最长一帧的间隔。 */
async function msFromClickTo(page, target, marks, deadlineMs = 60_000) {
  const handle = await target.elementHandle()
  await page.evaluate(({ element, marks, deadlineMs }) => {
    let clickedAt = null
    element.addEventListener('click', () => { clickedAt ??= performance.now() }, { capture: true, once: true })
    window.__perfMarks = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`${JSON.stringify(marks)} 在 ${deadlineMs} ms 内未全部出现`)), deadlineMs)
      const seen = marks.map(() => null)
      let lastFrame = null
      let maxFrameGap = 0
      const tick = () => {
        const now = performance.now()
        if (clickedAt !== null) {
          maxFrameGap = Math.max(maxFrameGap, now - (lastFrame ?? clickedAt))
          lastFrame = now
          marks.forEach(([selector, text], index) => {
            if (seen[index] === null && [...document.querySelectorAll(selector)].some(node => node.textContent.includes(text) && node.getClientRects().length > 0)) {
              seen[index] = Math.round(now - clickedAt)
            }
          })
        }
        if (seen.every(value => value !== null)) {
          clearTimeout(deadline)
          resolve({ marks: seen, maxFrameGapMs: Math.round(maxFrameGap) })
        } else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, { element: handle, marks, deadlineMs })
  await target.click()
  return page.evaluate(() => window.__perfMarks)
}

/**
 * 冷启动后的一轮：打开作品、进蓝图页、回正文、换到最后一章定稿（正文与定稿后处理卡片各计一次）。
 * 从点击到目标内容出现在画面上；每项另记主进程与渲染进程账本。
 */
async function timeOnce(context, finalized, round) {
  const { app, page } = context
  await installLedger(app, page)
  const label = name => `${finalized}-r${round}-${name}`
  await stage.spine(page).or(stage.cover(page, BOOK)).first().waitFor({ state: 'visible', timeout: 60_000 })
  if (await stage.spine(page).isVisible()) await stage.backToLibrary(page, BOOK)
  await stage.previewBook(page, BOOK)
  const openButton = stage.overview(page, BOOK).getByRole('button', { name: `打开《${BOOK}》` })
  const open = await operation(context, label('open'), () => msFromClickTo(page, openButton, [[SPINE, '蓝图'], ['.stage-content', EMPTY_CHAPTER]]))
  const blueprints = await operation(context, label('blueprint'), () =>
    msFromClickTo(page, stage.stageButton(page, '蓝图'), [['.stage-bp-plan-item', chapterTitle(BLUEPRINTS)]]))
  const manuscript = await operation(context, label('manuscript'), () =>
    msFromClickTo(page, stage.stageButton(page, '正文'), [['.stage-content', EMPTY_CHAPTER]]))
  const finalChapter = await operation(context, label('final-chapter'), () => msFromClickTo(page, stage.chapterButton(page, finalized),
    [[prose, PROSE_PROBE], ['.stage-ch-post', '定稿后处理']]))
  return { open, blueprints, manuscript, finalChapter }
}

const RUNNING = '.stage-capsule:not([data-tone="ok"])'

/** 门关着时点 target，到第一个模型请求卡在门上（模型之前的软件耗时）；放行后等 done() 返回，记总耗时。 */
async function timeModelAction(context, label, click, done) {
  const { fake } = context
  return operation(context, label, async () => {
    fake.gate.hold()
    const startedAt = performance.now()
    await click()
    while (fake.gate.waiting < 1) {
      if (performance.now() - startedAt > 60_000) { fake.gate.release(); throw new Error(`${label}：60 秒内没有发出模型请求`) }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const toFirstRequestMs = Math.round(performance.now() - startedAt)
    fake.gate.release()
    await done()
    return { toFirstRequestMs, totalMs: Math.round(performance.now() - startedAt) }
  })
}

/** 单章三步：写作此章、AI 审稿、定稿（到后处理全部结束）。这会把第 finalized+1 章写成定稿，所以放在最后。 */
async function timeSingleChapter(context, finalized, prefix = String(finalized)) {
  const { page } = context
  const next = finalized + 1
  await chapterView.open(context.page, next)
  await page.getByRole('button', { name: '写作此章' }).waitFor({ state: 'visible' })
  const write = await timeModelAction(context, `${prefix}-write`, () => page.getByRole('button', { name: '写作此章' }).click(), async () => {
    await page.locator(prose).filter({ hasText: chapterMarker(next) }).waitFor({ state: 'visible', timeout: 120_000 })
    await stage.root(page).locator(RUNNING).waitFor({ state: 'detached', timeout: 120_000 })
  })
  const review = await timeModelAction(context, `${prefix}-review`, () => chapterView.view(page).getByRole('button', { name: 'AI 审稿', exact: true }).click(),
    async () => {
      const failed = page.getByText('工作流未完成')
      await chapterView.reviewSheet(page).or(failed).first().waitFor({ state: 'visible', timeout: 120_000 })
      assert.equal(await failed.count(), 0, `第 ${next} 章的 AI 审稿没有完成`)
      await stage.root(page).locator(RUNNING).waitFor({ state: 'detached', timeout: 120_000 })
    })
  await page.keyboard.press('Escape')
  const finalize = await operation(context, `${prefix}-finalize`, async () => {
    const startedAt = performance.now()
    await chapterView.more(page, '定稿…')
    await chapterView.finalizeDialog(page, next).getByRole('button', { name: '确认定稿', exact: true }).click()
    await chapterView.view(page).getByText('已定稿，只读', { exact: true }).waitFor({ state: 'visible', timeout: 120_000 })
    const readOnlyMs = Math.round(performance.now() - startedAt)
    await chapterView.postProcess(page).waitFor({ state: 'visible', timeout: 120_000 })
    await stage.root(page).locator(RUNNING).waitFor({ state: 'detached', timeout: 120_000 })
    return { readOnlyMs, totalMs: Math.round(performance.now() - startedAt) }
  })
  return { write, review, finalize }
}

async function timeLargeBook(context, finalized, { rounds = Number(process.env.PERF702_ROUNDS ?? 3) } = {}) {
  const runs = []
  for (let round = 1; round <= rounds; round++) {
    if (round > 1) await context.restart()
    runs.push(await timeOnce(context, finalized, round))
  }
  return { finalized, blueprints: BLUEPRINTS, runs, single: process.env.PERF702_SINGLE === '0' ? null : await timeSingleChapter(context, finalized) }
}

/** 定稿后处理的角色状态更新：提示里的前三位角色各记一处位置与心绪，时间线随章数增长。 */
function characterStates(prompt) {
  const ids = [...new Set([...prompt.matchAll(/"characterId":\s*"([^"\s]+)"/gu)].map(match => match[1]))].slice(0, 3)
  const chapter = /【本章内容（第(\d+)章）】/u.exec(prompt)?.[1] ?? '0'
  const quote = /第\d+夜的潮水退得很慢。/u.exec(prompt)?.[0]
  if (!quote) return '{"updates":[]}'
  return JSON.stringify({ updates: ids.map(characterId => ({ characterId,
    currentState: { recentEvents: `第${chapter}章守在北堤`, location: `第${chapter}章的北堤` }, evidence: { text: quote } })) })
}

/** 写作请求回这一章的模板正文（章号取自本章蓝图），其余请求交给假模型照常作答。 */
function draftReply(prompt) {
  if (prompt.includes('只写短细纲') || prompt.includes('{"updates"')) return null
  const task = /(?:【本章写作方向与核心任务】|【本章信息】)[\s\S]*?(?:"chapterNumber"\s*:\s*(\d+)|第\s*(\d+)\s*章)/u.exec(prompt)
  if (!task) return null
  return chapterText(Number(task[1] ?? task[2]))
}

function installReplies(fake) {
  fake.replyCharacterState(characterStates)
  fake.replyReview(draftReply)
}

const checkpoints = () => (process.env.PERF702_CHECKPOINTS ?? '10,50,112').split(',').map(Number)

/** 退出应用后把作品存一份到 <PERF702_SAVE>/<章数>，再冷启动打开它接着写。 */
async function saveCheckpoint(context, finalized) {
  const save = process.env.PERF702_SAVE
  if (!save || !checkpoints().includes(finalized)) return
  await context.restart({ beforeLaunch: () => fs.cpSync(path.join(context.roots.projects, BOOK), path.join(save, String(finalized), 'projects', BOOK), { recursive: true }) })
  await installLedger(context.app, context.page)
  await stage.openFromLibrary(context.page, BOOK)
}

/**
 * 按作者真实的写法造书：BLUEPRINTS 章蓝图之后，用批量创作「自动定稿」每次 10 章写到 finalized 章，
 * 每章都走写作、定稿与后处理（知识库、章节要点、角色状态）。正文每章约 3000 字，由假模型按模板流出。
 * 每一批记墙钟与账本，这就是「批量写多章」随全书章数的曲线。写完重启应用，计时从冷启动后的书房开始。
 */
async function buildByBatch(context, finalized) {
  await seedLargeBook(context, 0)
  const { page } = context
  installReplies(context.fake)
  await installLedger(context.app, page)
  await stage.openFromLibrary(page, BOOK)
  const batches = []
  for (let done = 0; done < finalized; done += 10) {
    const count = Math.min(10, finalized - done)
    await blueprint.open(context.page)
    await context.page.getByRole('button', { name: '批量创作' }).click()
    const dialog = blueprint.batchDialog(context.page)
    await dialog.getByLabel(/写几章/).fill(String(count))
    await dialog.getByRole('radio', { name: /^自动定稿/ }).check()
    await dialog.getByRole('button', { name: '继续确认自动定稿' }).click()
    batches.push(await operation(context, `batch-${done + 1}-${done + count}`, async () => {
      const startedAt = performance.now()
      await dialog.getByRole('button', { name: '确认自动定稿并开始' }).click()
      const reached = stage.stageButton(context.page, '正文').filter({ hasText: `${done + count} / ${BLUEPRINTS} 定稿` })
      const failed = context.page.getByText('工作流未完成')
      await reached.or(failed).first().waitFor({ state: 'visible', timeout: 600_000 })
      assert.equal(await failed.count(), 0, `第 ${done + 1}～${done + count} 章的批量创作没有完成`)
      const finalizedMs = Math.round(performance.now() - startedAt)
      // 运行侧页开着时胶囊是展开态，stage.capsule 找不到它；按胶囊的色调等到全部后处理结束。
      await stage.root(context.page).locator(RUNNING).waitFor({ state: 'detached', timeout: 120_000 })
      return { chapters: count, finalizedMs, totalMs: Math.round(performance.now() - startedAt) }
    }))
    await saveCheckpoint(context, done + count)
  }
  await context.shoot('built')
  await context.restart()
  return batches
}

/**
 * 按手动作者的写法造书：每章在单章视图里点写作此章、AI 审稿、定稿，三步各记一次（见 timeSingleChapter）。
 * 与批量造书不同，每章留下一个不属于批次的写稿运行和一个审稿运行，「可恢复」列表要逐个读它们。
 */
async function buildByHand(context, finalized) {
  await seedLargeBook(context, 0)
  installReplies(context.fake)
  await installLedger(context.app, context.page)
  await stage.openFromLibrary(context.page, BOOK)
  const chapters = []
  for (let done = 0; done < finalized; done++) {
    chapters.push(await timeSingleChapter(context, done, `hand-${done + 1}`))
    await saveCheckpoint(context, done + 1)
  }
  await context.restart()
  return chapters
}

const REVISION_NOTE = '林岚把这句话记进日志，又核对了一遍潮位表。'
const issueQuote = chapter => `守塔人说第${chapter}夜的钟声又早了1刻`
const goalQuote = chapter => `远处的航标灯亮了1盏，一路亮到第${chapter}号海湾。`

/** 带引文的意见加一条有正文证据的目标未达成：只有有证据的目标意见才进合并后复核。 */
function reviewReply(chapter) {
  return JSON.stringify({ summary: '本章目标还没落地。', items: [
    { category: '连续性', severity: 'warning', description: '核对钟声提前与潮位的关系。', quote: issueQuote(chapter) },
  ], goalReviews: [{ id: `ch${chapter}:keyEvents:1`, status: 'unmet', description: '林岚还没有在灯塔里找到新的线索。',
    evidence: [{ quote: goalQuote(chapter) }] }] })
}

/** 修稿改掉两处被引的原文（证据变了，合并后才会复核），并补一句复核引用的话。 */
function revisedText(chapter) {
  return chapterText(chapter).replace(issueQuote(chapter), `守塔人说第${chapter}夜的钟声准了`)
    .replace(goalQuote(chapter), `远处的航标灯亮了1盏。${REVISION_NOTE}`)
}

function installReviewCycleReplies(fake) {
  const sent = { write: 0, review: 0, revision: 0, recheck: 0 }
  fake.replyCharacterState(characterStates)
  fake.replyReview(prompt => {
    // 复核提示里也带着确认的修稿清单，先按复核锚点认出它。
    const anchors = prompt.split('【需复核的原始证据锚点】')[1]
    if (anchors) {
      sent.recheck++
      const findings = JSON.parse(anchors.slice(anchors.indexOf('['), anchors.indexOf(']\n\n') + 1))
      return JSON.stringify({ summary: '复核：已补潮位核对。', items: findings.map(({ findingId, targetId }) => ({
        findingId, targetId, resolved: true, evidenceQuote: '又核对了一遍潮位表', reason: '修稿补了潮位核对。' })) })
    }
    const revising = prompt.includes('【已确认纳入本次修稿的审稿项】')
    if (revising || prompt.includes('goalReviews')) {
      const chapter = Number(/ch(\d+):keyEvents/u.exec(prompt)?.[1] ?? /第(\d+)夜的潮水退得很慢。/u.exec(prompt)?.[1])
      assert.ok(chapter > 0, '审稿或修稿提示里认不出章号')
      sent[revising ? 'revision' : 'review']++
      return revising ? revisedText(chapter) : reviewReply(chapter)
    }
    const draft = draftReply(prompt)
    if (draft) sent.write++
    return draft
  })
  return sent
}

async function reviewCycleChapter(context, chapter, sent) {
  const { page } = context
  const before = { ...sent }
  const settled = async kind => {
    const deadline = Date.now() + 120_000
    while (sent[kind] === before[kind]) {
      assert.ok(Date.now() < deadline, `第 ${chapter} 章：120 秒内没有发出${kind}请求`)
      await page.waitForTimeout(100)
    }
    await stage.root(page).locator(RUNNING).waitFor({ state: 'detached', timeout: 120_000 })
  }
  const step = (name, action) => operation(context, `rc-${chapter}-${name}`, async () => {
    const startedAt = performance.now()
    await action()
    return { totalMs: Math.round(performance.now() - startedAt) }
  })
  await chapterView.open(page, chapter)
  const write = await step('write', async () => {
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    await settled('write')
    await page.locator(prose).filter({ hasText: chapterMarker(chapter) }).waitFor({ state: 'visible', timeout: 120_000 })
  })
  const review = await step('review', async () => {
    await chapterView.review(page)
    await settled('review')
  })
  const revise = await step('revise', async () => {
    await chapterView.reviseButton(page).click()
    await chapterView.merge(page).waitFor({ state: 'visible', timeout: 120_000 })
    await settled('revision')
  })
  const merge = await step('merge-recheck', async () => {
    await chapterView.merge(page).getByRole('button', { name: '全部用修稿' }).click()
    await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 120_000 })
    await settled('recheck')
  })
  const finalize = await step('finalize', async () => {
    // 复核结果写回时动作条会重绘，等主按钮重新出现再点，否则 finalize 会走进「更多」菜单。
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 120_000 })
    await chapterView.finalize(page, chapter)
    await chapterView.postProcess(page).waitFor({ state: 'visible', timeout: 120_000 })
    await stage.root(page).locator(RUNNING).waitFor({ state: 'detached', timeout: 120_000 })
  })
  assert.deepEqual(Object.fromEntries(Object.entries(sent).map(([kind, count]) => [kind, count - before[kind]])),
    { write: 1, review: 1, revision: 1, recheck: 1 }, `第 ${chapter} 章的四类模型请求应各发一次`)
  return { write, review, revise, merge, finalize }
}

/** 比 buildByHand 每章多一个修稿运行和一个复核运行，库的增长接近真实作品。 */
async function buildByReviewCycle(context, finalized) {
  await seedLargeBook(context, 0)
  const sent = installReviewCycleReplies(context.fake)
  await installLedger(context.app, context.page)
  await stage.openFromLibrary(context.page, BOOK)
  const chapters = []
  for (let chapter = 1; chapter <= finalized; chapter++) {
    chapters.push(await reviewCycleChapter(context, chapter, sent))
    await saveCheckpoint(context, chapter)
  }
  await context.restart()
  installReplies(context.fake)
  return chapters
}

const written = finalized => ({ model: true, shell: 'stage', setup: async context => { context.batches = await buildByBatch(context, finalized) },
  run: async context => ({ batches: context.batches, ...await timeLargeBook(context, finalized) }) })

/**
 * 复用一份已造好的书：把 PERF702_FIXTURE 里的作品复制进本轮隔离目录再打开。
 * 112 章批量造书要十几分钟，计时、录 profile、新旧构建对比都从同一份数据出发。
 */
async function reuseBuilt(context) {
  const { app, page, roots, invoke, reload } = context
  const source = path.join(process.env.PERF702_FIXTURE ?? assert.fail('PERF702_FIXTURE 未设置'), 'projects', BOOK)
  const target = path.join(roots.projects, BOOK)
  fs.cpSync(source, target, { recursive: true })
  assert.equal((await invoke(page, 'llm:save-model', FAKE_MODEL)).success, true)
  assert.equal((await invoke(page, 'llm:set-default-model', FAKE_MODEL.id)).success, true)
  const grant = await chooseProjectDirectoryGrant(app, page, target, 'project-open')
  const opened = await invoke(page, 'project:open', { grantId: grant.grantId }, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  await reload()
}

/**
 * 用「AI 生成蓝图」一次生成第 1～BLUEPRINTS 章蓝图（假模型立即作答），记生成耗时；之后重启，蓝图页计时同 timeBlueprintsOnly。
 * 社群用户的 200 章蓝图是这样生成的，蓝图页挂载时要读这次规划运行的恢复稿。
 */
async function generateBlueprints(context) {
  // 生成蓝图要求架构已有故事前提等内容，用样例作品的完整核心设定。
  await seedLargeBook(context, 0, { blueprints: false, core: STAGE_SAMPLE.core })
  context.fake.replyDirectoryBlueprints()
  await installLedger(context.app, context.page)
  await stage.openFromLibrary(context.page, BOOK)
  await blueprint.open(context.page)
  const generated = await operation(context, `bpgen${BLUEPRINTS}-generate`, async () => {
    const startedAt = performance.now()
    // 一次最多生成连续 10 章（「全部 N 章」也受这个限制），按作者的做法反复「接着生成 10 章」。
    for (let done = 0; done < BLUEPRINTS; done += 10) {
      await blueprint.openGenerate(context.page)
      const dialog = blueprint.generateDialog(context.page)
      // 聚焦章数输入框即选中「接着生成」。
      await dialog.getByLabel('本次蓝图章数').fill(String(Math.min(10, BLUEPRINTS - done)))
      await dialog.getByRole('button', { name: '开始生成' }).click()
      await blueprint.continuePastArchitectureWarning(context.page)
      await blueprint.planItem(context.page, Math.min(done + 10, BLUEPRINTS)).waitFor({ state: 'visible', timeout: 300_000 })
      await stage.root(context.page).locator(RUNNING).waitFor({ state: 'detached', timeout: 300_000 })
    }
    return { totalMs: Math.round(performance.now() - startedAt) }
  })
  await context.restart()
  return generated
}

/**
 * 证明「假死」的机制：渲染端每 20 ms 发一次轻量 IPC（config:get），记它的最长往返；
 * 先空跑 2 秒作基线，再在主进程里直接调一次 channel 的处理函数（用打开作品时截下的真实会话），看轻量 IPC 被它挡住多久。
 */
async function contention(context, channel) {
  const { app, page } = context
  const probe = () => page.evaluate(async durationMs => {
    const latencies = []
    const until = performance.now() + durationMs
    while (performance.now() < until) {
      const startedAt = performance.now()
      await window.aiNovelAPI.invoke('config:get')
      latencies.push(performance.now() - startedAt)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return { probes: latencies.length, maxMs: Math.round(Math.max(...latencies)) }
  }, 2000)
  const baseline = await probe()
  const during = probe()
  const label = `contention-${channel.replace(':', '-')}-${context.contentionRuns = (context.contentionRuns ?? 0) + 1}`
  const handlerMs = await profiled(context, label, () => app.evaluate(async ({ ipcMain }, name) => {
    const { event, session } = globalThis.__perfSession
    const startedAt = performance.now()
    await ipcMain._invokeHandlers.get(name)(event, session)
    return Math.round(performance.now() - startedAt)
  }, channel))
  return log({ label, baseline, during: await during, handlerMs })
}

/** 只有蓝图、没有正文的作品：蓝图页耗时随蓝图条数（PERF702_BLUEPRINTS）的曲线。 */
async function timeBlueprintsOnly(context, rounds = Number(process.env.PERF702_ROUNDS ?? 3), mark = chapterTitle(BLUEPRINTS)) {
  const runs = []
  for (let round = 1; round <= rounds; round++) {
    if (round > 1) await context.restart()
    const { app, page } = context
    await installLedger(app, page)
    await stage.spine(page).or(stage.cover(page, BOOK)).first().waitFor({ state: 'visible', timeout: 60_000 })
    if (await stage.spine(page).isVisible()) await stage.backToLibrary(page, BOOK)
    await stage.openFromLibrary(page, BOOK)
    runs.push(await operation(context, `${context.bpLabel ?? 'bp'}${BLUEPRINTS}-r${round}-blueprint`, () =>
      msFromClickTo(page, stage.stageButton(page, '蓝图'), [['.stage-bp-plan-item', mark]])))
  }
  return { blueprints: BLUEPRINTS, runs }
}

export const PERF702_SCENARIOS = {
  'perf702-reuse': { model: true, shell: 'stage', setup: async context => { installReplies(context.fake); await reuseBuilt(context); await context.restart() },
    run: context => timeLargeBook(context, Number(process.env.PERF702_FINALIZED ?? 112)) },
  'perf702-contention': { model: true, shell: 'stage', setup: async context => { installReplies(context.fake); await reuseBuilt(context); await context.restart() },
    run: async context => {
      const opened = await timeOnce(context, Number(process.env.PERF702_FINALIZED ?? 112), 1)
      const results = []
      for (let round = 0; round < 3; round++) for (const channel of ['generation:list-recovery', 'generation:find-blueprint-recovery']) results.push(await contention(context, channel))
      return { opened, results }
    } },
  'perf702-blueprints': { model: true, shell: 'stage', setup: async context => { await seedLargeBook(context, 0); await context.restart() },
    run: context => timeBlueprintsOnly(context) },
  'perf702-bpgen': { model: true, shell: 'stage', setup: async context => { context.generated = await generateBlueprints(context); context.bpLabel = 'bpgen' },
    run: async context => ({ generated: context.generated, ...await timeBlueprintsOnly(context, undefined, String(BLUEPRINTS)) }) },
  'perf702-hand-112': { model: true, shell: 'stage', setup: async context => { context.chapters = await buildByHand(context, 112) },
    run: async context => ({ chapters: context.chapters.length, ...await timeLargeBook(context, 112) }) },
  'perf702-review-cycle': { model: true, shell: 'stage', setup: async context => {
    context.chapters = await buildByReviewCycle(context, Number(process.env.PERF702_FINALIZED ?? 112))
  }, run: async context => ({ chapters: context.chapters.length, ...await timeLargeBook(context, context.chapters.length) }) },
  'perf702-10': written(10),
  'perf702-112': written(112),
}
