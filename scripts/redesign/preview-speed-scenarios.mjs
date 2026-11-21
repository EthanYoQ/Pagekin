// 书房预览分段计时（#702 preview-speed）。
// 同一封面点第二次是打开，所以每次大书之间都先点样书。
// 预算 250 ms 按 42 MB 的那份夹具定。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import * as stage from './pages/stage.mjs'
import { BOOK } from './perf702-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const fixtureBook = () => path.join(process.env.PERF702_FIXTURE ?? assert.fail('PERF702_FIXTURE 未设置'), 'projects', BOOK)
const userVersion = projectPath => {
  const db = new DatabaseSync(path.join(projectPath, '.ai-novel', 'project.db'), { readOnly: true })
  try { return db.prepare('PRAGMA user_version').get().user_version } finally { db.close() }
}

/** contextBridge 暴露的 aiNovelAPI 不可改写，peek 的收发时刻改由主进程 handler 进出代替（两边相差约 1 ms）。 */
const instrumentRenderer = page => page.evaluate(() => {
  const now = () => performance.timeOrigin + performance.now()
  const log = window.__previewSpeed = { clicks: [], idle: [], longtasks: [] }
  document.addEventListener('click', event => {
    const label = event.target instanceof Element ? event.target.closest('[aria-label^="预览《"]')?.getAttribute('aria-label') : null
    if (label) log.clicks.push({ label, at: performance.timeOrigin + event.timeStamp })
  }, true)
  const seen = new WeakSet()
  new MutationObserver(() => {
    for (const region of document.querySelectorAll('section.stage-ov[aria-busy]')) {
      if (region.getAttribute('aria-busy') === 'true') { seen.delete(region); continue }
      if (seen.has(region)) continue
      seen.add(region)
      log.idle.push({ label: region.getAttribute('aria-label'), at: now() })
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy'] })
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) log.longtasks.push({ at: performance.timeOrigin + entry.startTime, ms: entry.duration })
    }).observe({ type: 'longtask', buffered: true })
  } catch { /* 没有 longtask 时只少这一列。 */ }
})

const instrumentMain = app => app.evaluate(({ ipcMain }) => {
  const now = () => performance.timeOrigin + performance.now()
  const log = globalThis.__previewSpeed = { handler: [], workers: [], workerPatched: false }
  const handlers = ipcMain._invokeHandlers
  const peek = handlers.get('project:peek-overview')
  handlers.set('project:peek-overview', async (...args) => {
    const entry = { in: now() }
    log.handler.push(entry)
    try {
      const result = await peek(...args)
      Object.assign(entry, { state: result?.state, finalized: result?.finalizedChapters })
      return result
    } finally { entry.out = now() }
  })
  const threads = process.getBuiltinModule('node:worker_threads')
  const Original = threads.Worker
  threads.Worker = class extends Original {
    constructor(...args) {
      const created = now()
      super(...args)
      const record = { created, script: String(args[0]).split(/[\\/]/).at(-1) }
      log.workers.push(record)
      this.once('online', () => { record.online = now() })
      this.once('message', () => { record.message = now() })
      this.once('exit', () => { record.exit = now() })
    }
  }
  process.getBuiltinModule('node:module').syncBuiltinESMExports()
  log.workerPatched = true
})

const nodeNow = () => performance.timeOrigin + performance.now()

async function previewOnce(page, name) {
  const region = stage.overview(page, name)
  await stage.cover(page, name).waitFor({ state: 'visible' })
  const start = nodeNow()
  await stage.cover(page, name).click()
  const clicked = nodeNow()
  // 定位器等待按 Playwright 的退避间隔轮询，读完后可能再晚约 500 ms 才发现；PREVIEW_SPEED_WAIT=poll 改为每 10 ms 查一次。
  if (process.env.PREVIEW_SPEED_WAIT === 'poll') {
    await page.waitForFunction(label => document.querySelector(`section.stage-ov[aria-label="${label}"]`)?.getAttribute('aria-busy') === 'false',
      `《${name}》概览`, { polling: 10, timeout: 60_000 })
  } else await region.and(page.locator('[aria-busy="false"]')).waitFor({ state: 'visible', timeout: 60_000 })
  const done = nodeNow()
  assert.equal(await region.locator('.pi-stats').count(), 1, `《${name}》预览没有读到统计`)
  return { start, clicked, done }
}

const round = value => value === undefined ? null : Math.round(value * 10) / 10

function segments(nodeTimes, renderer, main, index) {
  const click = renderer.clicks.filter(item => item.label === `预览《${BOOK}》`)[index]
  const idle = renderer.idle.find(item => item.label === `《${BOOK}》概览` && item.at >= click.at)
  const handler = main.handler.find(item => item.in >= click.at - 5)
  const worker = main.workers.find(item => item.created >= handler.in && item.created <= handler.out)
  const longtasks = renderer.longtasks.filter(item => item.at >= nodeTimes.start && item.at <= nodeTimes.done)
  return {
    state: handler.state, finalized: handler.finalized,
    totalMs: round(nodeTimes.done - nodeTimes.start),
    productMs: round(idle.at - click.at),
    driverBeforeClickMs: round(click.at - nodeTimes.start),
    clickToHandlerMs: round(handler.in - click.at),
    handlerMs: round(handler.out - handler.in),
    ...(worker ? {
      handlerToWorkerMs: round(worker.created - handler.in),
      workerStartMs: round(worker.online - worker.created),
      workerRunMs: round(worker.message - worker.online),
      workerToHandlerOutMs: round(handler.out - worker.message),
    } : {}),
    handlerToIdleMs: round(idle.at - handler.out),
    idleToDriverMs: round(nodeTimes.done - idle.at),
    longtaskMs: round(longtasks.reduce((sum, item) => sum + item.ms, 0)),
  }
}

export const PREVIEW_SPEED_SCENARIOS = {
  'preview-speed': { model: false, shell: 'stage', requires: { env: { PERF702_FIXTURE: `指向库版本 10 的 112 章夹具目录（里面有 projects/${BOOK}）` } }, setup: async context => {
    await seedStageSample(context, { open: false })
    const { app, page, roots, invoke } = context
    const target = path.join(roots.projects, BOOK)
    fs.cpSync(fixtureBook(), target, { recursive: true })
    const grant = await chooseProjectDirectoryGrant(app, page, target, 'project-open')
    const opened = await invoke(page, 'project:open', { grantId: grant.grantId }, randomUUID(), null)
    assert.equal(opened.success, true, opened.error)
    // 打开时当前构建可能已把它升级；默认换回夹具原样（库版本 10），PREVIEW_SPEED_UPGRADED=1 时保留升级后的库。
    await context.restart({ beforeLaunch: () => {
      if (process.env.PREVIEW_SPEED_UPGRADED === '1') return
      fs.rmSync(path.join(target, '.ai-novel'), { recursive: true, force: true })
      fs.cpSync(path.join(fixtureBook(), '.ai-novel'), path.join(target, '.ai-novel'), { recursive: true })
    } })
  }, run: async ({ app, page, roots }) => {
    const target = path.join(roots.projects, BOOK)
    const before = userVersion(target)
    await instrumentMain(app)
    await instrumentRenderer(page)
    const rounds = Number(process.env.PREVIEW_SPEED_ROUNDS ?? 5)
    const times = [await previewOnce(page, BOOK)]
    for (let index = 0; index < rounds; index++) {
      await previewOnce(page, STAGE_SAMPLE.name)
      times.push(await previewOnce(page, BOOK))
    }
    const renderer = await page.evaluate(() => window.__previewSpeed)
    const main = await app.evaluate(() => globalThis.__previewSpeed)
    let previews
    try {
      previews = times.map((nodeTimes, index) => ({ kind: index === 0 ? 'cold' : 'warm', ...segments(nodeTimes, renderer, main, index) }))
    } catch (error) {
      throw new Error(`三方时间戳对不上：${JSON.stringify({ times, renderer, main })}`, { cause: error })
    }
    assert.equal(userVersion(target), before, '只读预览没有改动夹具的库版本')
    const expectedFinalized = Number(process.env.PERF702_FINALIZED ?? 112)
    for (const item of previews) assert.deepEqual([item.state, item.finalized], ['ready', expectedFinalized], JSON.stringify(item))
    const warm = previews.filter(item => item.kind === 'warm').map(item => item.productMs).sort((a, b) => a - b)
    const warmMedianMs = warm.length % 2 ? warm[warm.length >> 1] : (warm[warm.length / 2 - 1] + warm[warm.length / 2]) / 2
    const budget = Number(process.env.PREVIEW_SPEED_BUDGET_MS ?? 250)
    assert.ok(warmMedianMs <= budget, `热预览中位 ${warmMedianMs} ms，超过 ${budget} ms：${JSON.stringify(previews)}`)
    return { userVersion: before, workerPatched: main.workerPatched, warmMedianMs, previews }
  } },
}

function breakSample(databasePath, mode) {
  if (mode === 'newer') {
    const db = new DatabaseSync(databasePath)
    try { db.exec(`PRAGMA user_version = ${db.prepare('PRAGMA user_version').get().user_version + 1}`) } finally { db.close() }
    return
  }
  // 先并回 WAL，否则改动落不到主库；页头写坏 integrity_check 一定会报。
  const db = new DatabaseSync(databasePath)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const { page_size: pageSize } = db.prepare('PRAGMA page_size').get()
  const { rootpage: rootPage } = db.prepare("SELECT rootpage FROM sqlite_master WHERE type='table' AND name IN ('drafts_all','drafts')").get()
  db.close()
  const fd = fs.openSync(databasePath, 'r+')
  try { fs.writeSync(fd, Buffer.alloc(16, 0xff), 0, 16, pageSize * (rootPage - 1)) } finally { fs.closeSync(fd) }
}

const brokenPreview = (mode, reason) => ({ model: false, shell: 'stage', setup: async context => {
  await seedStageSample(context, { open: false })
  const databasePath = path.join(context.samplePath, '.ai-novel', 'project.db')
  await context.restart({ beforeLaunch: () => breakSample(databasePath, mode) })
}, run: async ({ page, shoot }) => {
  const name = STAGE_SAMPLE.name
  const region = stage.overview(page, name)
  await stage.cover(page, name).click()
  const status = region.locator('.stage-ov-status').filter({ hasNotText: '正在读取' })
  await status.waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal(await status.textContent(), '暂时读不到这部作品的概览。点「打开」查看，打不开时会说明原因。')
  await shoot(`preview-broken-${mode}-preview`)
  await region.getByRole('button', { name: `打开《${name}》` }).click()
  const failed = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: '打开项目失败' })
  await failed.waitFor({ state: 'visible', timeout: 30_000 })
  assert.match(await failed.textContent(), reason)
  await shoot(`preview-broken-${mode}-open`)
} })

PREVIEW_SPEED_SCENARIOS['preview-broken-corrupt'] = brokenPreview('corrupt', /已损坏/)
PREVIEW_SPEED_SCENARIOS['preview-broken-newer'] = brokenPreview('newer', /更新版本/)
