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

export const BOOK = '盐湖'
const BLUEPRINTS = Number(process.env.PERF702_BLUEPRINTS ?? 200)
const CHAPTER_UNITS = 3000
const CHARACTERS = ['林岚', '守塔人', '沈默', '许青', '老周', '阿禾', '程远', '苏梅', '韩九', '小满', '陆川', '白鹭']
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

export async function installLedger(app, page) {
  await app.evaluate(({ ipcMain, app: electronApp }, wrapSql) => {
    if (globalThis.__perfLedger) return
    const ledger = globalThis.__perfLedger = { channels: {}, spawns: { calls: 0, ms: 0, kinds: {} }, sql: {}, late: { calls: 0, ms: 0 }, inflight: 0 }
    const settle = (current, ms) => { if (current) return true; ledger.late.calls += 1; ledger.late.ms += ms; return false }
    const wrap = (channel, handler) => async (...args) => {
      const session = args.at(-1)
      if (session && typeof session === 'object' && typeof session.leaseId === 'string') globalThis.__perfSession = { event: args[0], session }
      const startedAt = performance.now()
      const channels = ledger.channels
      ledger.inflight += 1
      try { return await handler(...args) } finally {
        ledger.inflight -= 1
        const ms = performance.now() - startedAt
        if (settle(channels === ledger.channels, ms)) {
          const entry = channels[channel] ??= { calls: 0, ms: 0 }
          entry.calls += 1
          entry.ms += ms
        }
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
      const bucket = ledger.spawns
      const entry = bucket.kinds[name] ??= { calls: 0, ms: 0 }
      bucket.calls += 1
      entry.calls += 1
      child.once('exit', () => { const ms = performance.now() - startedAt; if (settle(bucket === ledger.spawns, ms)) { bucket.ms += ms; entry.ms += ms } })
      return child
    }
    process.getBuiltinModule('node:module').syncBuiltinESMExports()
    const loop = ledger.loop = { last: performance.now(), max: 0 }
    setInterval(() => { const now = performance.now(); loop.max = Math.max(loop.max, now - loop.last); loop.last = now }, 5).unref()
    if (!wrapSql) return
    const require = process.getBuiltinModule('node:module').createRequire(process.getBuiltinModule('node:path').join(electronApp.getAppPath(), 'package.json'))
    const Database = require('better-sqlite3')
    const scratch = new Database(':memory:')
    const statement = Object.getPrototypeOf(scratch.prepare('SELECT 1'))
    scratch.close()
    const sqlEntry = source => ledger.sql[source] ??= { calls: 0, rows: 0, ms: 0, maxMs: 0 }
    const charge = (entry, ms) => { entry.ms += ms; entry.maxMs = Math.max(entry.maxMs, ms) }
    for (const method of ['run', 'get', 'all']) {
      const original = statement[method]
      statement[method] = function (...args) {
        const startedAt = performance.now()
        const result = original.apply(this, args)
        const entry = sqlEntry(this.source)
        entry.calls += 1
        charge(entry, performance.now() - startedAt)
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
          charge(entry, performance.now() - startedAt)
          if (!step.done) entry.rows += 1
          return step
        },
        return(value) { return inner.return ? inner.return(value) : { done: true, value } },
      }
    }
    const exec = Database.prototype.exec
    Database.prototype.exec = function (source) {
      const startedAt = performance.now()
      const result = exec.call(this, source)
      const entry = sqlEntry(source)
      entry.calls += 1
      charge(entry, performance.now() - startedAt)
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

async function takeLedger(app, page, stallBeforeMs = 0) {
  const main = await app.evaluate((_electron, stallBeforeMs) => {
    const stalledAt = performance.now()
    while (performance.now() - stalledAt < stallBeforeMs) { /* 同步忙等 */ }
    const { channels, spawns, sql, loop, late } = globalThis.__perfLedger
    Object.assign(globalThis.__perfLedger, { channels: {}, spawns: { calls: 0, ms: 0, kinds: {} }, sql: {}, late: { calls: 0, ms: 0 } })
    const now = performance.now()
    const maxBlockMs = Math.round(Math.max(loop.max, now - loop.last))
    loop.max = 0
    loop.last = now
    const round = ([key, { calls, ms, rows, maxMs }]) => [key, { calls, ms: Math.round(ms), ...rows === undefined ? {} : { rows },
      ...maxMs === undefined ? {} : { maxMs: Math.round(maxMs) } }]
    const sqlEntries = Object.entries(sql)
    return {
      ipcCalls: Object.values(channels).reduce((sum, entry) => sum + entry.calls, 0),
      ipc: Object.fromEntries(Object.entries(channels).sort(([, a], [, b]) => b.ms - a.ms).slice(0, 10).map(round)),
      spawns: spawns.calls, spawnMs: Math.round(spawns.ms), spawnKinds: Object.fromEntries(Object.entries(spawns.kinds).map(round)),
      sqlCalls: sqlEntries.reduce((sum, [, entry]) => sum + entry.calls, 0),
      sqlRows: sqlEntries.reduce((sum, [, entry]) => sum + entry.rows, 0),
      sqlMs: Math.round(sqlEntries.reduce((sum, [, entry]) => sum + entry.ms, 0)),
      sqlTop: Object.fromEntries(sqlEntries.sort(([, a], [, b]) => b.ms - a.ms).slice(0, 12).map(round)),
      sqlMaxCallMs: Math.round(sqlEntries.reduce((max, [, entry]) => Math.max(max, entry.maxMs), 0)),
      mainMaxBlockMs: maxBlockMs,
      lateCalls: late.calls, lateMs: Math.round(late.ms),
    }
  }, stallBeforeMs)
  const renderer = await page.evaluate(() => {
    const value = window.__perfLong
    if (!value) return { longTasks: null }
    window.__perfLong = { count: 0, ms: 0, max: 0 }
    return { longTasks: value.count, longTaskMs: Math.round(value.ms), longTaskMax: Math.round(value.max) }
  }).catch(() => ({ longTasks: null }))
  return { ...main, ...renderer }
}

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

async function operation(context, label, action) {
  await takeLedger(context.app, context.page)
  const since = context.fake.chats.length
  const ms = await profiled(context, label, action)
  return log({ label, ms, ...await takeLedger(context.app, context.page), prompts: promptStats(context.fake, since) })
}

const prose = '.stage-content .cm-content'
const SPINE = 'nav[aria-label="创作流程"]'
const EMPTY_CHAPTER = '这一章还是空白'

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

async function timeOnce(context, finalized, round, suffix = '') {
  const { app, page } = context
  await installLedger(app, page)
  const label = name => `${finalized}-r${round}-${name}${suffix}`
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

export const RUNNING = '.stage-capsule:not([data-tone="ok"])'

async function timeModelAction(context, label, click, done) {
  const { fake } = context
  return operation(context, label, async () => {
    fake.gate.hold()
    const startedAt = performance.now()
    let toFirstRequestMs
    try {
      await click()
      while (fake.gate.waiting < 1) {
        if (performance.now() - startedAt > 60_000) throw new Error(`${label}：60 秒内没有发出模型请求`)
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      toFirstRequestMs = Math.round(performance.now() - startedAt)
    } finally {
      fake.gate.release()
    }
    await done()
    return { toFirstRequestMs, totalMs: Math.round(performance.now() - startedAt) }
  })
}

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

function characterStates(prompt) {
  const ids = [...new Set([...prompt.matchAll(/"characterId":\s*"([^"\s]+)"/gu)].map(match => match[1]))].slice(0, 3)
  const chapter = /【本章内容（第(\d+)章）】/u.exec(prompt)?.[1] ?? '0'
  const quote = /第\d+夜的潮水退得很慢。/u.exec(prompt)?.[0]
  if (!quote) return '{"updates":[]}'
  return JSON.stringify({ updates: ids.map(characterId => ({ characterId,
    currentState: { recentEvents: `第${chapter}章守在北堤`, location: `第${chapter}章的北堤` }, evidence: { text: quote } })) })
}

function draftReply(prompt) {
  if (prompt.includes('只写短细纲') || prompt.includes('{"updates"')) return null
  const task = /(?:【本章写作方向与核心任务】|【本章信息】)[\s\S]*?(?:"chapterNumber"\s*:\s*(\d+)|第\s*(\d+)\s*章)/u.exec(prompt)
  if (!task) return null
  return chapterText(Number(task[1] ?? task[2]))
}

export function installReplies(fake) {
  fake.replyCharacterState(characterStates)
  fake.replyReview(draftReply)
}

const checkpoints = () => (process.env.PERF702_CHECKPOINTS ?? '10,50,112').split(',').map(Number)

async function saveCheckpoint(context, finalized) {
  const save = process.env.PERF702_SAVE
  if (!save || !checkpoints().includes(finalized)) return
  await context.restart({ beforeLaunch: () => fs.cpSync(path.join(context.roots.projects, BOOK), path.join(save, String(finalized), 'projects', BOOK), { recursive: true }) })
  await installLedger(context.app, context.page)
  await stage.openFromLibrary(context.page, BOOK)
}

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
      await stage.root(context.page).locator(RUNNING).waitFor({ state: 'detached', timeout: 120_000 })
      return { chapters: count, finalizedMs, totalMs: Math.round(performance.now() - startedAt) }
    }))
    await saveCheckpoint(context, done + count)
  }
  await context.shoot('built')
  await context.restart()
  return batches
}

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

function reviewReply(chapter) {
  return JSON.stringify({ summary: '本章目标还没落地。', items: [
    { category: '连续性', severity: 'warning', description: '核对钟声提前与潮位的关系。', quote: issueQuote(chapter) },
  ], goalReviews: [{ id: `ch${chapter}:keyEvents:1`, status: 'unmet', description: '林岚还没有在灯塔里找到新的线索。',
    evidence: [{ quote: goalQuote(chapter) }] }] })
}

function revisedText(chapter) {
  return chapterText(chapter).replace(issueQuote(chapter), `守塔人说第${chapter}夜的钟声准了`)
    .replace(goalQuote(chapter), `远处的航标灯亮了1盏。${REVISION_NOTE}`)
}

export function installReviewCycleReplies(fake) {
  const sent = { write: 0, review: 0, revision: 0, recheck: 0 }
  fake.replyCharacterState(characterStates)
  fake.replyReview(prompt => {
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

export async function reviewCycleChapter(context, chapter, sent) {
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
    await chapterView.finalize(page, chapter)
    await chapterView.postProcess(page).waitFor({ state: 'visible', timeout: 120_000 })
    await stage.root(page).locator(RUNNING).waitFor({ state: 'detached', timeout: 120_000 })
  })
  assert.deepEqual(Object.fromEntries(Object.entries(sent).map(([kind, count]) => [kind, count - before[kind]])),
    { write: 1, review: 1, revision: 1, recheck: 1 }, `第 ${chapter} 章的四类模型请求应各发一次`)
  return { write, review, revise, merge, finalize }
}

export async function buildByReviewCycle(context, finalized, { saveCheckpoints = true, beforeLaunch } = {}) {
  await seedLargeBook(context, 0)
  const sent = installReviewCycleReplies(context.fake)
  await installLedger(context.app, context.page)
  await stage.openFromLibrary(context.page, BOOK)
  const chapters = []
  for (let chapter = 1; chapter <= finalized; chapter++) {
    chapters.push(await reviewCycleChapter(context, chapter, sent))
    if (saveCheckpoints) await saveCheckpoint(context, chapter)
  }
  await context.restart({ beforeLaunch })
  installReplies(context.fake)
  return chapters
}

const written = finalized => ({ model: true, shell: 'stage', setup: async context => { context.batches = await buildByBatch(context, finalized) },
  run: async context => ({ batches: context.batches, ...await timeLargeBook(context, finalized) }) })

export async function reuseBuilt(context) {
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

async function generateBlueprints(context) {
  await seedLargeBook(context, 0, { blueprints: false, core: STAGE_SAMPLE.core })
  context.fake.replyDirectoryBlueprints()
  await installLedger(context.app, context.page)
  await stage.openFromLibrary(context.page, BOOK)
  await blueprint.open(context.page)
  const generated = await operation(context, `bpgen${BLUEPRINTS}-generate`, async () => {
    const startedAt = performance.now()
    for (let done = 0; done < BLUEPRINTS; done += 10) {
      await blueprint.openGenerate(context.page)
      const dialog = blueprint.generateDialog(context.page)
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
  const { handlerMs, result } = await profiled(context, label, () => app.evaluate(async ({ ipcMain }, name) => {
    const { event, session } = globalThis.__perfSession
    const startedAt = performance.now()
    const answer = await ipcMain._invokeHandlers.get(name)(event, session)
    const handlerMs = Math.round(performance.now() - startedAt)
    const shape = (value, depth) => Array.isArray(value) ? value.length
      : value && typeof value === 'object' ? depth ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item, depth - 1)])) : 'object'
        : typeof value === 'string' ? `text(${value.length})` : value
    return { handlerMs, result: shape(answer, 3) }
  }, channel))
  return log({ label, baseline, during: await during, handlerMs, result })
}

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

async function blockControls(context) {
  const { app, page, invoke } = context
  await installLedger(app, page)
  const results = { idle: await operation(context, 'control-idle', () => page.waitForTimeout(1000)) }
  const sqlRows = await app.evaluate(({ app: electronApp }) => {
    const require = process.getBuiltinModule('node:module').createRequire(process.getBuiltinModule('node:path').join(electronApp.getAppPath(), 'package.json'))
    const Database = require('better-sqlite3')
    const db = globalThis.__perfControlDb ??= new Database(':memory:')
    const count = db.prepare('WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c')
    const startedAt = performance.now()
    count.get(1_000_000)
    return Math.round(1_000_000 * 500 / (performance.now() - startedAt))
  })
  const blockInHandler = kind => app.evaluate(({ ipcMain }, { kind, sqlRows }) => {
    const original = ipcMain._invokeHandlers.get('config:get')
    globalThis.__perfControlRestore = () => ipcMain._invokeHandlers.set('config:get', original)
    ipcMain._invokeHandlers.set('config:get', async (...args) => {
      globalThis.__perfControlRestore()
      const startedAt = performance.now()
      if (kind === 'sql') globalThis.__perfControlDb.prepare('WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c').get(sqlRows)
      else while (performance.now() - startedAt < 500) { /* 同步忙等 */ }
      globalThis.__perfControlBlockedMs = Math.round(performance.now() - startedAt)
      return original(...args)
    })
  }, { kind, sqlRows })
  for (const kind of ['js', 'sql']) {
    await blockInHandler(kind)
    results[`ipc-${kind}`] = await operation(context, `control-ipc-${kind}`, async () => {
      await invoke(page, 'config:get')
      return { blockedMs: await app.evaluate(() => globalThis.__perfControlBlockedMs) }
    })
  }
  await takeLedger(app, page, 300)
  const idleAfterStall = await profiled(context, 'control-stall-before-window', () => page.waitForTimeout(500))
  results.stallBeforeWindow = log({ label: 'control-stall-before-window', ms: idleAfterStall, ...await takeLedger(app, page), prompts: {} })
  results.timer = await operation(context, 'control-timer-js', async () => {
    await app.evaluate(() => new Promise(resolve => setTimeout(() => {
      const startedAt = performance.now()
      while (performance.now() - startedAt < 500) { /* 同步忙等 */ }
      resolve()
    }, 0)))
    return { blockedMs: 500 }
  })
  return results
}

async function waitForQuietIpc(app, quietMs = 2_000, deadlineMs = 60_000) {
  const total = () => app.evaluate(() => globalThis.__perfLedger.inflight > 0 ? -1
    : Object.values(globalThis.__perfLedger.channels).reduce((sum, entry) => sum + entry.calls, 0))
  const deadline = Date.now() + deadlineMs
  let last = await total(), since = Date.now()
  while (Date.now() - since < quietMs) {
    assert.ok(Date.now() < deadline, `${deadlineMs} ms 内界面一直在调主进程`)
    await new Promise(resolve => setTimeout(resolve, 250))
    const now = await total()
    if (now !== last || now === -1) { last = now; since = Date.now() }
  }
}

async function timeExport(context, finalized, { rounds = Number(process.env.PERF702_ROUNDS ?? 1), writes = false } = {}) {
  const { app, page, roots, invoke } = context
  await installLedger(app, page)
  await stage.spine(page).or(stage.cover(page, BOOK)).first().waitFor({ state: 'visible', timeout: 60_000 })
  if (!await stage.spine(page).isVisible()) await stage.openFromLibrary(page, BOOK)
  await stage.spine(page).waitFor({ state: 'visible', timeout: 60_000 })
  const session = await app.evaluate(() => globalThis.__perfSession?.session)
  assert.ok(session?.leaseId, '记下了界面打开作品的会话')
  const draft = writes ? await invoke(page, 'db:draft-create', { chapterNumber: finalized + 1, version: 1, source: 'write',
    content: chapterMarker(finalized + 1), wordCount: 10 }, session.projectPath, session) : null
  if (writes) assert.equal(draft.success, true, draft.error)
  const runs = []
  for (let round = 1; round <= rounds; round++) {
    const archive = path.join(roots.projects, `export-${round}-${randomUUID()}.ainovel`)
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, archive)
    const grant = await invoke(page, 'dialog:select-project-archive-export', BOOK)
    await waitForQuietIpc(app)
    runs.push(await operation(context, `${finalized}-export-r${round}${writes ? '-writing' : ''}`, async () => {
      const result = await page.evaluate(async ({ grantId, session, draftId, writes }) => {
        let done = false, saves = 0, saveFailures = 0, probes = 0, probeMaxMs = 0
        const probe = (async () => {
          while (!done) {
            const startedAt = performance.now()
            await window.aiNovelAPI.invoke('config:get')
            probeMaxMs = Math.max(probeMaxMs, performance.now() - startedAt)
            probes += 1
            await new Promise(resolve => setTimeout(resolve, 20))
          }
        })()
        const startedAt = performance.now()
        const exporting = window.aiNovelAPI.invoke('project:archive-export', { targetArchiveGrantId: grantId, projectSession: session })
        let totalMs = 0
        const settled = exporting.finally(() => { totalMs = Math.round(performance.now() - startedAt); done = true })
        const writer = (async () => {
          while (writes && !done) {
            const saved = await window.aiNovelAPI.invoke('db:draft-update-content', draftId, `边写边导第 ${saves + saveFailures + 1} 次保存。`, 12, session.projectPath, session)
            if (done) break
            if (saved?.success) saves += 1
            else saveFailures += 1
            await new Promise(resolve => setTimeout(resolve, 150))
          }
        })()
        const exported = await settled
        await Promise.all([probe, writer])
        return { totalMs, success: exported.success, errorCode: exported.success ? undefined : exported.errorCode ?? exported.error,
          sha256: exported.success ? exported.receipt.targetSha256 : undefined, probes, probeMaxMs: Math.round(probeMaxMs),
          ...writes ? { saves, saveFailures } : {} }
      }, { grantId: grant.grantId, session, draftId: draft?.id, writes })
      assert.equal(result.success, true, `导出失败：${result.errorCode}`)
      assert.ok(fs.existsSync(archive), '导出报成功但存档不在')
      if (writes) assert.ok(result.saves > 0 && result.saveFailures === 0, `导出期间的保存：成功 ${result.saves}，失败 ${result.saveFailures}`)
      return { ...result, archiveExists: true, archiveBytes: fs.statSync(archive).size, leftovers: fs.readdirSync(roots.projects).filter(name => name.startsWith('.pe-')) }
    }))
  }
  return { finalized, runs }
}

export async function timeSplitExport(context, finalized) {
  const { app, page, roots } = context
  await stage.spine(page).or(stage.cover(page, BOOK)).first().waitFor({ state: 'visible', timeout: 60_000 })
  if (!await stage.spine(page).isVisible()) await stage.openFromLibrary(page, BOOK)
  await stage.spine(page).waitFor({ state: 'visible', timeout: 60_000 })
  const target = path.join(roots.projects, `split-export-${randomUUID()}`)
  fs.mkdirSync(target)
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, target)
  await stage.openWorkMenuItem(page, BOOK, '导出…')
  const dialog = page.getByRole('dialog', { name: '导出项目' })
  await dialog.getByText('分章 Markdown', { exact: true }).click()
  const startedAt = Date.now()
  await dialog.getByRole('button', { name: '选择目录并导出', exact: true }).click()
  await dialog.getByText(/已导出到：/u).or(dialog.locator('[class*="color-error-text"]')).first()
    .waitFor({ state: 'visible', timeout: 20 * 60_000 })
  const totalMs = Date.now() - startedAt
  const dialogText = await dialog.innerText()
  assert.match(dialogText, /已导出到：/u, `分章导出没有成功：${dialogText}`)
  const folders = fs.readdirSync(target)
  assert.equal(folders.length, 1, `导出目录里应只有这次的分章文件夹：${folders.join('、')}`)
  const files = fs.readdirSync(path.join(target, folders[0])).filter(name => name.endsWith('.md'))
  assert.equal(files.length, finalized, `每章一个文件：${files.length} / ${finalized}`)
  for (let number = 1; number <= finalized; number++) {
    const content = fs.readFileSync(path.join(target, folders[0], `chapter_${number}.md`), 'utf8')
    assert.ok(content.includes(chapterMarker(number)), `chapter_${number}.md 是第 ${number} 章的正文`)
  }
  return log({ label: `${finalized}-split-export`, totalMs, files: files.length })
}

async function exportPhases(context) {
  const { app, page, roots, shoot } = context
  await stage.spine(page).or(stage.cover(page, BOOK)).first().waitFor({ state: 'visible', timeout: 60_000 })
  if (!await stage.spine(page).isVisible()) await stage.openFromLibrary(page, BOOK)
  await stage.openSettings(page)
  await stage.showSettingsPage(page, '项目备份')
  const archive = path.join(roots.projects, `phases-${randomUUID()}.ainovel`)
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, archive)
  const panel = stage.root(page).getByTestId('project-backup-panel')
  await page.evaluate(labels => {
    const seen = window.__exportPhases = []
    const record = () => {
      for (const [phase, label] of labels) {
        if (!seen.includes(phase) && [...document.querySelectorAll('[data-testid="project-backup-panel"] [role="status"]')].some(node => node.textContent?.includes(label))) seen.push(phase)
      }
    }
    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true })
  }, [['snapshot', '正在读取作品…'], ['package', '正在打包存档…']])
  await panel.getByRole('button', { name: '导出本地存档', exact: true }).click()
  const done = panel.locator('p[role="status"]').filter({ hasText: /^本地存档已导出：[0-9a-f]{64}$/u })
  const shot = []
  const deadline = Date.now() + 120_000
  while (!await done.isVisible()) {
    assert.ok(Date.now() < deadline, '导出 120 s 内没有完成')
    for (const phase of await page.evaluate(() => window.__exportPhases)) {
      if (!shot.includes(phase)) { shot.push(phase); await shoot(`export-phase-${phase}`) }
    }
    await page.waitForTimeout(50)
  }
  const seen = await page.evaluate(() => window.__exportPhases)
  assert.deepEqual(seen, ['snapshot', 'package'], '读取与打包两个阶段都要依次出现')
  assert.equal(await panel.getByRole('status').filter({ hasText: /^正在/u }).count(), 0, '导出完不再显示阶段')
  return { seen, archiveExists: fs.existsSync(archive), leftovers: fs.readdirSync(roots.projects).filter(name => name.startsWith('.pe-')) }
}

async function exportThenClose(context) {
  const { app, page, roots, invoke } = context
  await installLedger(app, page)
  await stage.spine(page).or(stage.cover(page, BOOK)).first().waitFor({ state: 'visible', timeout: 60_000 })
  if (!await stage.spine(page).isVisible()) await stage.openFromLibrary(page, BOOK)
  await stage.spine(page).waitFor({ state: 'visible', timeout: 60_000 })
  const session = await app.evaluate(() => globalThis.__perfSession?.session)
  assert.ok(session?.leaseId, '记下了界面打开作品的会话')
  const archive = path.join(roots.projects, `close-${randomUUID()}.ainovel`)
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, archive)
  const grant = await invoke(page, 'dialog:select-project-archive-export', BOOK)
  const leftovers = () => fs.readdirSync(roots.projects).filter(name => name.startsWith('.pe-'))
  await page.evaluate(({ grantId, session }) => {
    window.__closeExport = window.aiNovelAPI.invoke('project:archive-export', { targetArchiveGrantId: grantId, projectSession: session })
  }, { grantId: grant.grantId, session })
  const deadline = Date.now() + 30_000
  while (leftovers().length === 0) {
    assert.ok(Date.now() < deadline, '30 s 内没见到导出的临时目录')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const closed = await invoke(page, 'db:close', session.projectPath, session)
  const leftoversWhenClosed = leftovers()
  const exported = await page.evaluate(() => window.__closeExport)
  await context.restart()
  await stage.spine(context.page).or(stage.cover(context.page, BOOK)).first().waitFor({ state: 'visible', timeout: 60_000 })
  if (!await stage.spine(context.page).isVisible()) await stage.openFromLibrary(context.page, BOOK)
  await stage.spine(context.page).waitFor({ state: 'visible', timeout: 60_000 })
  const result = { closed, leftoversWhenClosed, exportSuccess: exported.success, exportError: exported.success ? undefined : exported.errorCode ?? exported.error,
    archiveExists: fs.existsSync(archive), leftoversAfterRestart: leftovers(), reopened: true }
  assert.equal(closed?.success, true, `关库成功：${JSON.stringify(closed)}`)
  assert.deepEqual(leftoversWhenClosed, [], '关库返回时临时目录已删')
  assert.equal(result.archiveExists, exported.success, '导出成功才有存档，失败不留存档')
  return result
}

async function exportHeldTarget(context) {
  const { app, page, roots, shoot } = context
  await stage.spine(page).or(stage.cover(page, BOOK)).first().waitFor({ state: 'visible', timeout: 60_000 })
  if (!await stage.spine(page).isVisible()) await stage.openFromLibrary(page, BOOK)
  await stage.spine(page).waitFor({ state: 'visible', timeout: 60_000 })
  const target = path.join(roots.projects, `held-export-${randomUUID()}`)
  fs.mkdirSync(target)
  const exported = path.join(target, `${BOOK}.md`)
  fs.writeFileSync(exported, '上一次导出的内容', 'utf8')
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, target)
  await stage.openWorkMenuItem(page, BOOK, '导出…')
  const dialog = page.getByRole('dialog', { name: '导出项目' })
  await dialog.getByText('合并 Markdown', { exact: true }).click()
  const result = dialog.getByText(/已导出到：/u).or(dialog.locator('[class*="color-error-text"]')).first()
  const holder = fs.openSync(exported, 'r+')
  let heldText
  try {
    await dialog.getByRole('button', { name: '选择目录并导出', exact: true }).click()
    await result.waitFor({ state: 'visible', timeout: 60_000 })
    heldText = (await result.innerText()).trim()
    await shoot('held-target')
  } finally {
    fs.closeSync(holder)
  }
  assert.equal(heldText, '文件没有改动。目标文件正被其他程序打开，关掉它后再点「选择目录并导出」。')
  assert.equal(fs.readFileSync(exported, 'utf8'), '上一次导出的内容', '被占用时原文件不变')
  assert.deepEqual(fs.readdirSync(target), [`${BOOK}.md`], '没有留下临时文件')
  await dialog.getByRole('button', { name: '选择目录并导出', exact: true }).click()
  await dialog.getByText(new RegExp(`^已导出到：.*${BOOK}\\.md$`, 'u')).waitFor({ state: 'visible', timeout: 60_000 })
  await shoot('released-target')
  assert.ok(fs.readFileSync(exported, 'utf8').includes(chapterMarker(1)), '关掉后再导出写进了第 1 章')
  return { heldText, retried: true }
}

export const NEEDS_FIXTURE = { env: { PERF702_FIXTURE: `指向 112 章夹具目录（里面有 projects/${BOOK}）。用 perf702-112 加 PERF702_SAVE 造一份，取 <SAVE>/112；定稿章数不是 112 时同时设 PERF702_FINALIZED` } }

const REUSED = { model: true, shell: 'stage', requires: NEEDS_FIXTURE, setup: async context => { installReplies(context.fake); await reuseBuilt(context); await context.restart() } }

export const PERF702_SCENARIOS = {
  'perf702-export-phases': { ...REUSED, run: exportPhases },
  'perf702-block-control': { model: true, shell: 'stage', run: blockControls },
  'perf702-export-close': { ...REUSED, run: exportThenClose },
  'perf702-export': { ...REUSED, run: context => timeExport(context, Number(process.env.PERF702_FINALIZED ?? 112)) },
  'perf702-export-writing': { ...REUSED, run: context => timeExport(context, Number(process.env.PERF702_FINALIZED ?? 112), { writes: true }) },
  'perf702-split-export': { ...REUSED, run: context => timeSplitExport(context, Number(process.env.PERF702_FINALIZED ?? 112)) },
  'perf702-reuse': { ...REUSED, run: context => timeLargeBook(context, Number(process.env.PERF702_FINALIZED ?? 112)) },
  'perf702-contention': { ...REUSED,
    run: async context => {
      const opened = await timeOnce(context, Number(process.env.PERF702_FINALIZED ?? 112), 1)
      const results = []
      for (let round = 0; round < 3; round++) for (const channel of ['generation:list-recovery', 'generation:find-blueprint-recovery']) results.push(await contention(context, channel))
      const { page } = context, finalized = Number(process.env.PERF702_FINALIZED ?? 112)
      await stage.root(page).getByRole('banner').getByRole('button', { name: `《${BOOK}》作品菜单` }).click()
      const closed = await operation(context, `${finalized}-r1-return-to-library`, () =>
        msFromClickTo(page, page.getByRole('menuitem', { name: '回到书房' }), [['[aria-label="最近的作品"]', BOOK]]))
      await context.restart()
      const quiesced = await timeOnce(context, finalized, 2, '-quiesced')
      const grant = await chooseProjectDirectoryGrant(context.app, context.page, path.join(context.roots.projects, BOOK), 'project-open')
      const switched = await operation(context, `${finalized}-r2-reopen-same-quiesced`, async () => {
        const startedAt = performance.now()
        const reopened = await context.invoke(context.page, 'project:open', { grantId: grant.grantId }, randomUUID(), null)
        assert.equal(reopened.success, true, reopened.error)
        return { totalMs: Math.round(performance.now() - startedAt) }
      })
      await context.reload()
      await stage.spine(context.page).or(stage.cover(context.page, BOOK)).first().waitFor({ state: 'visible', timeout: 60_000 })
      return { opened, results, closed, quiesced, switched }
    } },
  'perf702-export-held': { model: true, shell: 'stage', requires: { platform: 'win32' }, setup: async context => { await seedLargeBook(context, 1, { blueprints: false }) },
    run: exportHeldTarget },
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
