import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'

import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { startFakeModel } from './fake-model.mjs'
import { changedFiles, fetchRoute, filesContaining, fileStamps, guardFetch, REAL_GENERATION_MODEL, REAL_KEY_ENV, REAL_MODEL_ENV, REAL_ORIGIN, realModelProfiles, redactSecret, removeModelConfigs, removePath,
  summarizeModelRequests } from './real-model.mjs'
import { assertNodeRunsTypeScript } from './node-version.mjs'
import { dismissCompletionToasts, dismissStartupNotice, firstInteractiveControl, waitForShell } from './pages/shell.mjs'

const asEntryPoint = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (asEntryPoint) try { assertNodeRunsTypeScript(process.version, process.features.typescript) } catch (error) {
  process.stderr.write(`${error.message}
`)
  process.exit(2)
}
export const isScenarioTable = exportName => /(^|_)SCENARIOS$/.test(exportName)
export async function loadScenarios(directory) {
  const files = fs.readdirSync(directory).filter(name => /(^|-)scenarios\.mjs$/.test(name)).sort()
  const modules = await Promise.all(files.map(name => import(pathToFileURL(path.join(directory, name)).href)))
  const scenarios = {}
  const definedIn = new Map()
  files.forEach((file, index) => {
    for (const [exportName, table] of Object.entries(modules[index])) {
      if (!isScenarioTable(exportName)) continue
      for (const [name, scenario] of Object.entries(table)) {
        const where = `${file} 的 ${exportName}`
        if (definedIn.has(name)) throw new Error(`场景 ${name} 重名：${definedIn.get(name)}、${where}`)
        definedIn.set(name, where)
        scenarios[name] = scenario
      }
    }
  })
  return scenarios
}
const [{ BASELINE_SESSIONS }, SCENARIOS] = await Promise.all([
  import('./scenarios.mjs'), loadScenarios(path.dirname(fileURLToPath(import.meta.url))),
])

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const OFFSCREEN_WINDOW = fileURLToPath(new URL('./offscreen-window.cjs', import.meta.url))
const TIMEOUT = 60_000
const VIEWPORT = { width: 1440, height: 900 }
const THEMES = ['light', 'dark']
const SHELLS = ['writer', 'stage']
const NOT_RUN = 3
const ROOT_NAMES = ['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData', 'temp', 'projects']
const TIMED_SESSIONS = new Set(['startup-timing', 'library-timing'])
const IDLE_SESSIONS = new Set(['idle-memory'])
const PREPARED_SESSIONS = new Set([...TIMED_SESSIONS, ...IDLE_SESSIONS])
const IDLE_SETTLE_MS = 10_000
const IDLE_SAMPLES = 5
const IDLE_SAMPLE_INTERVAL_MS = 1_000
export const SHELF_BOOKS = 20
const ALL_SCENARIOS = [...Object.keys(SCENARIOS), 'baseline-all', ...PREPARED_SESSIONS]
const USAGE = `用法: node scripts/redesign/drive.mjs --scenario <名称> [--theme light|dark] [--shell writer|stage] [--out <目录>] [--dump-dom] [--console] [--video] [--app-root <目录>] [--real-model]
--real-model 只用于 real-* 场景，密钥从环境变量 ${REAL_KEY_ENV} 读；生成模型默认 ${REAL_GENERATION_MODEL}，可用环境变量 ${REAL_MODEL_ENV} 换
场景: ${ALL_SCENARIOS.join(', ')}`

export function parseArgs(argv) {
  const options = { scenario: null, theme: 'light', shell: null, out: path.join(repository, '.runtime', 'redesign-baseline'),
    dumpDom: false, console: false, video: false, appRoot: repository, realModel: false }
  const valueOf = (flag, index) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 缺少取值\n${USAGE}`)
    return value
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') continue
    else if (arg === '--scenario') options.scenario = valueOf(arg, index++)
    else if (arg === '--theme') options.theme = valueOf(arg, index++)
    else if (arg === '--shell') options.shell = valueOf(arg, index++)
    else if (arg === '--out') options.out = path.resolve(valueOf(arg, index++))
    else if (arg === '--app-root') options.appRoot = path.resolve(valueOf(arg, index++))
    else if (arg === '--dump-dom') options.dumpDom = true
    else if (arg === '--console') options.console = true
    else if (arg === '--video') options.video = true
    else if (arg === '--real-model') options.realModel = true
    else throw new Error(`未知参数 ${arg}\n${USAGE}`)
  }
  if (!ALL_SCENARIOS.includes(options.scenario)) throw new Error(`未知或缺少场景 ${options.scenario}\n${USAGE}`)
  if (!THEMES.includes(options.theme)) throw new Error(`--theme 只接受 ${THEMES.join('|')}`)
  if (options.shell !== null && !SHELLS.includes(options.shell)) throw new Error(`--shell 只接受 ${SHELLS.join('|')}`)
  if (Boolean(SCENARIOS[options.scenario]?.real) !== options.realModel) {
    throw new Error(options.realModel ? `--real-model 只用于真实模型场景，${options.scenario} 不是` : `${options.scenario} 是真实模型场景，要带 --real-model`)
  }
  return options
}

export function createIsolatedRoots(parent) {
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'd'))
  const roots = Object.fromEntries(ROOT_NAMES.map(name => [name, path.join(root, name)]))
  for (const [name, directory] of Object.entries(roots)) if (name !== 'canonical') fs.mkdirSync(directory, { recursive: true })
  return { root, ...roots }
}

export function isolatedEnvironment(roots, base = process.env) {
  const env = { ...base, AI_NOVEL_APP_DATA_HOME: roots.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy,
    AI_NOVEL_VELA_HOME: roots.legacy, HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData,
    LOCALAPPDATA: roots.localAppData, TEMP: roots.temp, TMP: roots.temp }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[name]
  return env
}

function scratchParent() {
  const base = process.env.LOCALAPPDATA ?? os.tmpdir()
  return path.join(base, 'VibeCodingScratch', 'an', 'drive')
}

function realProfileDirectories() {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  return [path.join(os.homedir(), '.vela'), path.join(appData, 'ai-novel-writer'), path.join(appData, 'AI小说作家')]
}

const RUNNING_INSTANCE_CACHES = new Set(['GPUCache', 'DawnWebGPUCache', 'DawnGraphiteCache'])

function profileEntries(target, entries, limit) {
  let stat
  try { stat = fs.lstatSync(target) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return entries
    throw error
  }
  if (entries.size >= limit) throw new Error(`真实配置目录的条目超过 ${limit} 个，外部写入没法完整比较（停在 ${target}）`)
  if (!stat.isDirectory()) return entries.set(target, `${stat.size}:${stat.mtimeMs}`)
  let names
  try { names = fs.readdirSync(target) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return entries
    throw error
  }
  entries.set(target, 'dir')
  for (const name of names) profileEntries(path.join(target, name), entries, limit)
  return entries
}

export function snapshotRealProfiles(directories = realProfileDirectories(), limit = 50_000) {
  return Object.fromEntries(directories.map(directory => [directory, profileEntries(directory, new Map(), limit)]))
}

export function profileWrites(before) {
  const after = snapshotRealProfiles(Object.keys(before))
  const changed = Object.keys(before).flatMap(directory => {
    const previous = before[directory]
    const current = after[directory]
    return [...new Set([...previous.keys(), ...current.keys()])]
      .filter(entry => previous.get(entry) !== current.get(entry))
      .map(entry => ({ entry, ignored: RUNNING_INSTANCE_CACHES.has(path.relative(directory, entry).split(path.sep)[0]) }))
  })
  const entries = ignored => changed.filter(change => change.ignored === ignored).map(change => change.entry).sort()
  return { externalWrites: entries(false), externalWritesIgnored: entries(true) }
}

function liveProcesses(userData) {
  const needle = userData.toLowerCase()
  if (process.platform === 'win32') {
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"
    const output = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    return output.split(/\r?\n/).filter(line => line.toLowerCase().includes(needle)).map(line => Number(line.split('\t')[0]))
  }
  const output = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
  return output.split('\n').filter(line => line.toLowerCase().includes(needle)).map(line => Number(line.trim().split(/\s+/)[0]))
}

async function residualProcesses(userData) {
  for (let attempt = 1; ; attempt++) {
    const pids = liveProcesses(userData)
    if (pids.length === 0 || attempt === 10) return pids
    await delay(300)
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) { return error.code === 'EPERM' }
}

function singletonLock(userData) {
  if (process.platform === 'win32') {
    const file = path.join(userData, 'lockfile')
    return { file, held: () => { try { fs.closeSync(fs.openSync(file, 'r+')); return false } catch (error) { return error.code !== 'ENOENT' } } }
  }
  const file = path.join(userData, 'SingletonLock')
  return { file, held: () => { try { return isAlive(Number(fs.readlinkSync(file).split('-').pop())) } catch (error) { return error.code !== 'ENOENT' } } }
}

export async function kill(app, userData, timeoutMs = 15_000) {
  const pid = app.process().pid
  const tree = [...new Set([pid, ...liveProcesses(userData)])]
  const lock = singletonLock(userData)
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (isAlive(pid)) throw error
  }
  for (const deadline = Date.now() + timeoutMs; ; await delay(20)) {
    const alive = tree.filter(isAlive)
    const held = lock.held()
    if (alive.length === 0 && !held) return
    if (Date.now() >= deadline) throw new Error(`强杀 ${timeoutMs} ms 后被杀实例还没放开：${[alive.length ? `进程 ${alive.join('、')} 还在` : '', held ? `单例锁 ${lock.file} 仍被占` : ''].filter(Boolean).join('；')}`)
  }
}

export async function quit(app, graceMs = 10_000) {
  const pid = app.process().pid
  let timer
  const closed = await Promise.race([app.close().then(() => true).catch(() => false),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), graceMs) })])
  clearTimeout(timer)
  if (closed || !pid || !isAlive(pid)) return { forced: false }
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (isAlive(pid)) throw error
  }
  return { forced: true }
}

export function launchArgs(roots) {
  return ['-r', OFFSCREEN_WINDOW, '.', `--user-data-dir=${roots.userData}`, '--lang=zh-CN']
}

export async function captureFailure(page, base) {
  if (!page || page.isClosed()) return
  await page.screenshot({ path: `${base}.failure.png` }).catch(() => {})
  await dumpDom(page, base).catch(() => {})
}

export function assertBuilt(appRoot) {
  const main = path.join(appRoot, 'dist-electron', 'main.js')
  if (!fs.existsSync(main)) throw new Error(`${main} 不存在：先在 ${appRoot} 构建（pnpm build）再跑驱动`)
}

export function sessionIsClean({ failedAt, sessionErrors, residualProcesses, externalWrites }) {
  return failedAt === null && sessionErrors.length === 0 && residualProcesses?.length === 0 && externalWrites?.length === 0
}

async function launch({ roots, appRoot, fetchPolicy = { fakePort: null, realOrigin: null }, diagnostics, failureBase, shelfBooks = 0, renderTiming = false }) {
  assertBuilt(appRoot)
  const launchedAt = Date.now()
  const env = { ...isolatedEnvironment(roots), ...(renderTiming ? { DRIVE_RENDER_TIMING: String(shelfBooks || 1) } : {}) }
  const app = await electron.launch({ cwd: appRoot, args: launchArgs(roots), env, timeout: TIMEOUT })
  let page
  try {
    await app.evaluate((_, { route, guard, policy }) => {
      const sink = { externalRequests: [], modelRequests: [] }
      globalThis.__driveExternalRequests = sink.externalRequests
      globalThis.__driveModelRequests = sink.modelRequests
      globalThis.fetch = (0, eval)(`(${guard})`)(globalThis.fetch, (0, eval)(`(${route})`), policy, sink)
    }, { route: fetchRoute.toString(), guard: guardFetch.toString(), policy: fetchPolicy })
    app.process().stdout?.on('data', chunk => diagnostics.push(`[main:stdout] ${String(chunk).trimEnd()}`))
    app.process().stderr?.on('data', chunk => diagnostics.push(`[main:stderr] ${String(chunk).trimEnd()}`))
    page = await app.firstWindow({ timeout: TIMEOUT })
    page.on('console', message => diagnostics.push(`[renderer:${message.type()}] ${message.text()}`))
    page.on('pageerror', error => diagnostics.push(`[renderer:pageerror] ${error.stack ?? error.message}`))
    await firstInteractiveControl(page).waitFor({ state: 'visible', timeout: TIMEOUT })
    const interactiveAt = Date.now()
    const { readyToShow } = await app.evaluate(() => globalThis.__driveTiming)
    const timeOrigin = await page.evaluate(() => performance.timeOrigin)
    const timing = { launchToInteractiveMs: interactiveAt - launchedAt,
      readyToShowToInteractiveMs: readyToShow === null ? null : interactiveAt - readyToShow,
      navigationToInteractiveMs: Math.round(interactiveAt - timeOrigin) }
    if (renderTiming) {
      const read = name => page.waitForFunction(attribute => document.documentElement.getAttribute(attribute), `data-drive-${name}`, { timeout: TIMEOUT })
        .then(handle => handle.jsonValue()).then(Number)
      timing.renderInteractiveMs = await read('interactive')
      if (shelfBooks > 0) {
        timing.renderShelfMs = await read('shelf')
        timing.renderIdleMs = await read('idle')
      }
    }
    page.setDefaultTimeout(20_000)
    assert.equal(path.resolve(await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))), roots.userData)
    await page.setViewportSize(VIEWPORT)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForShell(page, TIMEOUT)
    await dismissStartupNotice(page)
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    return { app, page, timing }
  } catch (error) {
    await captureFailure(page, failureBase)
    await quit(app)
    throw error
  }
}

const invoke = (page, channel, ...args) =>
  page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })

const APPEARANCE_V3_KEY = 'ai-novel-writer-appearance-v3'
const APPEARANCE_PREVIOUS_KEY = 'ai-novel-writer-appearance'

export function appearanceWrite(stored, { theme, shell }) {
  if (stored.v3 !== null) {
    if (shell === 'writer') throw new Error('被测构建只有纸墨外壳，不能选 --shell writer')
    const current = JSON.parse(stored.v3)
    return { key: APPEARANCE_V3_KEY, value: { ...current, colorTheme: theme, revision: current.revision + 1, origin: 'author' } }
  }
  if (stored.previous === null) return null
  const current = JSON.parse(stored.previous)
  const value = { ...current, colorTheme: theme, ...(shell ? { shellPreference: shell } : {}), revision: current.revision + 1, origin: 'author' }
  value.schemaVersion = value.shellPreference === 'stage' ? 2 : 1
  return { key: APPEARANCE_PREVIOUS_KEY, value }
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

export function idleMemory(samples) {
  if (samples.length === 0) throw new Error('空闲内存没有采样')
  const total = (metrics, field) => metrics.reduce((sum, metric) => sum + (metric.memory[field] ?? 0), 0)
  const types = [...new Set(samples.flatMap(metrics => metrics.map(metric => metric.type)))]
  return {
    samples: samples.length,
    workingSetKB: median(samples.map(metrics => total(metrics, 'workingSetSize'))),
    privateKB: median(samples.map(metrics => total(metrics, 'privateBytes'))),
    byType: Object.fromEntries(types.map(type => [type,
      median(samples.map(metrics => total(metrics.filter(metric => metric.type === type), 'workingSetSize')))])),
  }
}

async function sampleIdleMemory(app) {
  await delay(IDLE_SETTLE_MS)
  const samples = []
  for (let index = 0; index < IDLE_SAMPLES; index++) {
    if (index > 0) await delay(IDLE_SAMPLE_INTERVAL_MS)
    samples.push(await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map(({ type, memory }) => ({ type, memory }))))
  }
  return idleMemory(samples)
}

async function applyAppearance(page, appearance) {
  const keys = { v3: APPEARANCE_V3_KEY, previous: APPEARANCE_PREVIOUS_KEY }
  await page.waitForFunction(({ v3, previous }) => localStorage.getItem(v3) !== null || localStorage.getItem(previous) !== null, keys, { timeout: TIMEOUT })
  const stored = await page.evaluate(({ v3, previous }) => ({ v3: localStorage.getItem(v3), previous: localStorage.getItem(previous) }), keys)
  const write = appearanceWrite(stored, appearance)
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), write)
  await page.reload()
  await waitForShell(page, TIMEOUT)
}

async function prepareProfile({ roots, appRoot, diagnostics, failureBase }, appearance, shelfBooks = 0) {
  const prepared = await launch({ roots, appRoot, diagnostics, failureBase })
  try {
    await applyAppearance(prepared.page, appearance)
    if (shelfBooks > 0) await seedShelf(prepared, roots, shelfBooks)
  } finally { await quit(prepared.app) }
}

async function seedShelf({ app, page }, roots, count) {
  for (let index = 1; index <= count; index++) {
    const grant = await chooseProjectDirectoryGrant(app, page, roots.projects)
    const created = await invoke(page, 'project:create', { parentGrantId: grant.grantId, name: `书架${String(index).padStart(2, '0')}`,
      genre: '悬疑', targetAudience: '全龄', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
  }
  assert.equal((await invoke(page, 'project:recent-list')).length, count, `最近项目应有 ${count} 部`)
}

async function startScreencast(page) {
  const frames = []
  let session
  const attach = async target => {
    session = await target.context().newCDPSession(target)
    const own = session
    own.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      frames.push({ data, time: metadata.timestamp })
      own.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    })
    await own.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height })
  }
  const detach = async () => {
    await session.send('Page.stopScreencast')
    await session.detach().catch(() => {})
  }
  await attach(page)
  return {
    pause: detach,
    resume: attach,
    async stop(file, scratch) {
      await detach()
      assert.ok(frames.length > 1, '录屏没有收到画面')
      const directory = fs.mkdtempSync(path.join(scratch, 'frames-'))
      const lines = ['ffconcat version 1.0']
      frames.forEach((frame, index) => {
        const name = `${String(index).padStart(5, '0')}.jpg`
        fs.writeFileSync(path.join(directory, name), Buffer.from(frame.data, 'base64'))
        const next = frames[index + 1]?.time ?? frame.time + 1
        lines.push(`file '${name}'`, `duration ${Math.max(0.001, next - frame.time).toFixed(4)}`)
      })
      lines.push(`file '${String(frames.length - 1).padStart(5, '0')}.jpg'`)
      fs.writeFileSync(path.join(directory, 'frames.ffconcat'), lines.map(line => `${line}\n`).join(''))
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(directory, 'frames.ffconcat'),
        '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file],
      { windowsHide: true })
      return file
    },
  }
}

async function shoot(page, file) {
  await page.evaluate(() => document.fonts.ready)
  await dismissCompletionToasts(page)
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible', '屏幕外窗口的页面被当作隐藏，截图会停帧')
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' })
}

async function dumpDom(page, base) {
  fs.writeFileSync(`${base}.dom.html`, await page.content())
  fs.writeFileSync(`${base}.aria.yml`, await page.locator('body').ariaSnapshot())
}

const messageOf = error => error instanceof Error ? error.message : String(error)

export async function harvestModelLog(app, modelLog, sessionErrors) {
  try { modelLog.push(...await app.evaluate(() => globalThis.__driveModelRequests)) } catch (error) {
    sessionErrors.push(`读不回最后一次启动的模型请求记录，modelRequests 偏少：${messageOf(error)}`)
  }
}

export function finishRealSession({ shared, sessionErrors, modelLog, canonical, remove = removePath }) {
  const summary = summarizeModelRequests(modelLog)
  shared.modelRequests = summary.count
  shared.modelRequestSummary = summary
  try {
    const { removed, failures } = removeModelConfigs(canonical, remove)
    shared.removedModelConfigs = removed.length
    for (const { file, reason } of failures) sessionErrors.push(`删不掉模型配置 ${file}：${reason}`)
  } catch (error) { sessionErrors.push(messageOf(error)) }
}

export function releaseSessionRoot(root, clean, sessionErrors, remove = removePath) {
  if (!clean) return
  const reason = remove(root)
  if (reason) sessionErrors.push(`删不掉隔离目录 ${root}：${reason}`)
}

export function writeConsoleLog(file, diagnostics, sessionErrors, secret = null) {
  let text = `${diagnostics.join('\n')}\n`
  if (secret && text.includes(secret)) {
    text = text.split(secret).join('[已遮蔽]')
    sessionErrors.push('诊断日志里出现了密钥，写盘前已遮蔽')
  }
  try { fs.writeFileSync(file, text) } catch (error) { sessionErrors.push(messageOf(error)) }
}

export function scanRunForSecret(results, out, outBefore, secret, remove = removePath) {
  const retained = [...new Set(results.map(result => result.isolationRoot))].filter(root => fs.existsSync(root))
  const walkProblems = []
  const scan = filesContaining([...changedFiles(out, outBefore, walkProblems), ...retained], secret)
  const removeFailures = []
  for (const file of scan.hits) {
    const reason = remove(file)
    if (reason) removeFailures.push({ file, reason })
  }
  for (const result of results) result.keyScan = { scanned: scan.scanned, hits: scan.hits, unreadable: [...walkProblems, ...scan.unreadable], removeFailures }
}

async function runSession(sessionName, names, options, realKey = null, roots = createIsolatedRoots(scratchParent())) {
  const before = snapshotRealProfiles()
  const diagnostics = []
  const fake = names.some(name => SCENARIOS[name]?.model) ? await startFakeModel(diagnostics) : null
  const base = name => path.join(options.out, `${name}-${options.theme}`)
  const results = names.map(scenario => ({ scenario, theme: options.theme }))
  const shared = { session: sessionName, isolationRoot: roots.root }
  const sessionErrors = []
  let failedAt = null
  let current = null
  let launched
  let recording = null
  const restartRequests = []
  const modelLog = []
  const cleanups = []
  const fetchPolicy = () => ({ fakePort: fake?.port ?? null, realOrigin: realKey ? REAL_ORIGIN : null })
  let currentAppRoot = options.appRoot
  const shell = names.map(name => SCENARIOS[name]?.shell).find(Boolean) ?? options.shell
  try {
    const shelfBooks = sessionName === 'library-timing' ? SHELF_BOOKS : 0
    const failureBase = base(sessionName)
    if (PREPARED_SESSIONS.has(sessionName)) await prepareProfile({ roots, appRoot: options.appRoot, diagnostics, failureBase }, { theme: options.theme, shell }, shelfBooks)
    launched = await launch({ roots, appRoot: options.appRoot, fetchPolicy: fetchPolicy(), diagnostics, failureBase, shelfBooks, renderTiming: TIMED_SESSIONS.has(sessionName) })
    shared.timing = launched.timing
    const shellShown = page => page.locator('[data-shell-presentation]').first().getAttribute('data-shell-presentation')
    if (PREPARED_SESSIONS.has(sessionName)) {
      shared.shell = await shellShown(launched.page)
      if (IDLE_SESSIONS.has(sessionName)) shared.memory = await sampleIdleMemory(launched.app)
    } else {
      await applyAppearance(launched.page, { theme: options.theme, shell })
      shared.shell = await shellShown(launched.page)
      const context = {
        ...launched, roots, invoke, fake, diagnostics,
        shoot: name => shoot(context.page, `${base(name)}.png`),
        reload: () => context.page.reload().then(() => waitForShell(context.page, TIMEOUT)),
        onCleanup: release => { cleanups.push(release) },
        restart: async ({ appRoot = currentAppRoot, beforeLaunch, killed = false } = {}) => {
          restartRequests.push(...await launched.app.evaluate(() => globalThis.__driveExternalRequests))
          modelLog.push(...await launched.app.evaluate(() => globalThis.__driveModelRequests))
          await recording?.pause()
          if (killed) await kill(launched.app, roots.userData)
          else assert.equal((await quit(launched.app)).forced, false, '重启前应用没有正常退出')
          await beforeLaunch?.()
          launched = await launch({ roots, appRoot, fetchPolicy: fetchPolicy(), diagnostics, failureBase })
          currentAppRoot = appRoot
          Object.assign(context, launched)
          await recording?.resume(context.page)
        },
        installRealModels: async () => {
          assert.ok(realKey, '只有 --real-model 的会话能接真实模型')
          const { generation, embedding } = realModelProfiles(realKey)
          for (const [channel, value] of [['llm:save-model', generation], ['llm:save-model', embedding],
            ['llm:set-default-model', generation.id], ['llm:set-default-embedding-model', embedding.id]]) {
            const result = await invoke(context.page, channel, value)
            assert.equal(result?.success, true, `${channel} 失败：${result?.error ?? ''}`)
          }
          shared.realModels = { generation: generation.modelName, embedding: embedding.modelName }
        },
      }
      current = 0
      await SCENARIOS[names[0]].setup?.(context)
      for (const [index, name] of names.entries()) {
        current = index
        results[index].screenshot = `${base(name)}.png`
        recording = options.video ? await startScreencast(context.page) : null
        const measured = await SCENARIOS[name].run(context)
        if (recording) results[index].video = await recording.stop(`${base(name)}.mp4`, roots.temp)
        recording = null
        if (measured) results[index].measured = measured
        await shoot(context.page, results[index].screenshot)
        if (options.dumpDom) await dumpDom(context.page, base(name))
        await SCENARIOS[name].after?.(context)
      }
      current = null
    }
    shared.externalRequests = [...restartRequests, ...await launched.app.evaluate(() => globalThis.__driveExternalRequests)]
    assert.deepEqual(shared.externalRequests, [], fake ? 'fetch 越过夹具访问外部网络' : '无夹具场景发出了 fetch')
  } catch (error) {
    if (current === null) sessionErrors.push(messageOf(error))
    else {
      failedAt = current
      results[current].error = messageOf(error)
    }
    await captureFailure(launched?.page, base(current === null ? sessionName : names[current]))
    options = { ...options, console: true }
  } finally {
    for (const release of cleanups.splice(0).reverse()) await Promise.resolve().then(release).catch(error => sessionErrors.push(`场景登记的清理失败：${messageOf(error)}`))
    fake?.gate.release()
    if (options.console) writeConsoleLog(`${base(sessionName)}.console.log`, diagnostics, sessionErrors, realKey)
    if (launched && realKey) await harvestModelLog(launched.app, modelLog, sessionErrors)
    if (launched) shared.quit = await quit(launched.app).catch(error => { sessionErrors.push(messageOf(error)); return null })
    await fake?.close()
    if (fake) shared.modelRequests = fake.requests.length
    if (realKey) finishRealSession({ shared, sessionErrors, modelLog, canonical: roots.canonical })
  }
  try {
    shared.residualProcesses = await residualProcesses(roots.userData)
    Object.assign(shared, profileWrites(before))
  } catch (error) { sessionErrors.push(messageOf(error)) }
  const clean = sessionIsClean({ failedAt, sessionErrors, residualProcesses: shared.residualProcesses, externalWrites: shared.externalWrites })
  releaseSessionRoot(roots.root, clean, sessionErrors)
  return results.map((result, index) => {
    const errors = [result.error, failedAt !== null && index > failedAt ? `未运行：本会话的 ${names[failedAt]} 先失败` : null, ...sessionErrors]
    const error = errors.filter(Boolean).join('\n')
    return { ...result, ...shared, ...(error ? { error } : {}) }
  })
}

async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  }
  try { assertBuilt(options.appRoot) } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  }
  fs.mkdirSync(options.out, { recursive: true })
  const sessions = options.scenario === 'baseline-all'
    ? Object.entries(BASELINE_SESSIONS).map(([name, scenarios]) => [`baseline-${name}`, scenarios])
    : [[options.scenario, [options.scenario]]]
  const realKey = options.realModel ? process.env[REAL_KEY_ENV] : null
  if (options.realModel && !realKey) {
    process.stderr.write(`--real-model 要从环境变量 ${REAL_KEY_ENV} 读密钥，当前没有\n`)
    process.exit(2)
  }
  const missing = sessions.flatMap(([, names]) => names.flatMap(name => missingPrerequisites(SCENARIOS[name], options)))
  if (missing.length) {
    const result = { scenario: options.scenario, theme: options.theme, notRun: missing }
    process.stderr.write(`未跑 ${options.scenario}：\n${missing.join('\n')}\n`)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    fs.writeFileSync(path.join(options.out, `${options.scenario}-${options.theme}.json`), JSON.stringify([result], null, 2))
    process.exitCode = NOT_RUN
    return
  }
  const code = await driveSessions({ sessions, options, realKey })
  process.stdout.write('', () => process.exit(code))
}

export function missingPrerequisites(scenario, options, env = process.env, platform = process.platform) {
  const { env: variables = {}, theme, platform: only } = scenario?.requires ?? {}
  return [
    ...Object.entries(variables).filter(([name]) => !env[name]).map(([name, how]) => `缺环境变量 ${name}，设置方法：${how}`),
    ...(theme && theme !== options.theme ? [`缺 --theme ${theme}，设置方法：命令加 --theme ${theme}`] : []),
    ...(only && only !== platform ? [`只在 ${only} 上跑，当前平台 ${platform}`] : []),
  ]
}

export async function driveSessions({ sessions, options, realKey, run = runSession, makeRoots = () => createIsolatedRoots(scratchParent()) }) {
  const results = []
  const outBefore = realKey ? fileStamps(options.out) : null
  for (const [sessionName, names] of sessions) {
    let sessionResults
    let roots
    try {
      roots = makeRoots()
      sessionResults = await run(sessionName, names, options, realKey, roots)
    } catch (error) {
      sessionResults = names.map(scenario => ({ scenario, theme: options.theme, session: sessionName, isolationRoot: roots?.root,
        error: `会话中途出错，没有正常收尾：${messageOf(error)}` }))
    }
    for (const raw of sessionResults) {
      const { value: result, redacted } = realKey ? redactSecret(raw, realKey) : { value: raw, redacted: false }
      if (redacted) result.secretRedacted = true
      results.push(result)
      if (!realKey) process.stdout.write(`${JSON.stringify(result)}\n`)
    }
  }
  const resultFile = path.join(options.out, `${options.scenario}-${options.theme}.json`)
  if (realKey) {
    try { scanRunForSecret(results, options.out, outBefore, realKey) } catch (error) {
      for (const result of results) result.keyScan = { error: messageOf(error) }
    }
    for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`)
  }
  const failed = results.filter(result => result.error || result.residualProcesses?.length !== 0 || result.externalWrites?.length !== 0
    || result.keyScan?.hits?.length > 0 || result.keyScan?.unreadable?.length > 0 || result.keyScan?.error || result.secretRedacted)
  fs.writeFileSync(resultFile, JSON.stringify(results, null, 2))
  if (realKey && filesContaining([resultFile], realKey).hits.length > 0) {
    removePath(resultFile)
    process.stderr.write('结果 JSON 含密钥，已删除\n')
    return 1
  }
  return failed.length ? 1 : 0
}

if (asEntryPoint) await main()
