import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createProjectArchiveRoundtripFixture, type ProjectArchiveRoundtripFixture } from '../../../test/desktop/project-archive.fixture'
import { portableExportWorkerForTest } from '../../../test/helpers/portable-export-worker'
import type { PortableExportPhase } from '../../../src/shared/ipc-channels'
import { withKnowledgeSourceGate } from '../knowledge-source-gate'
import {
  exportPortableProjectInWorker,
  portableExportsRunning,
  stopPortableExports,
  type PortableExportInWorkerInput,
  type PortableExportWorkerOptions,
} from '../portable-export-host'
import { createPortableProjectAssetProvider } from '../portable-project-assets'
import { exportPortableProject, type ExportPortableProjectInput } from '../project-archive-service'

const BetterSqlite = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const GENERATION ='00000000-0000-4000-8000-000000000001'
const NOW = '2026-11-19T00:00:00.000Z'
let worker: PortableExportWorkerOptions
const fixtures: ProjectArchiveRoundtripFixture[] = []

beforeAll(async () => { worker = await portableExportWorkerForTest() }, 60_000)
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.dispose() })

async function project() {
  const fixture = await createProjectArchiveRoundtripFixture()
  fixtures.push(fixture)
  const outDir = fs.mkdtempSync(path.join(fixture.base, 'out-'))
  const input = (name: string): PortableExportInWorkerInput => ({
    sourceProjectRoot: fixture.sourceRoot,
    projectSession: { projectId: fixture.sourceProjectId, projectPath: fixture.sourceRoot, leaseId: 'source-lease' },
    targetArchivePath: path.join(outDir, name),
    attemptParentPath: outDir,
    snapshotGeneration: GENERATION,
    now: NOW,
    assertCurrentContext: () => true,
  })
  return { fixture, outDir, input }
}

const leftovers = (dir: string) => fs.readdirSync(dir).filter(name => name.startsWith('.pe-'))

function onMainThread(input: PortableExportInWorkerInput): ReturnType<typeof exportPortableProject> {
  const { now, ...rest } = input
  return exportPortableProject({ ...rest, now: () => new Date(now!), assets: createPortableProjectAssetProvider() } satisfies ExportPortableProjectInput)
}

async function outcome(promise: Promise<unknown>) {
  try { await promise; return { ok: true } } catch (error) {
    const failure = error as Error & { code?: unknown; damagedReviewCycle?: unknown }
    return { ok: false, type: failure.constructor.name, code: failure.code, message: failure.message, damagedReviewCycle: failure.damagedReviewCycle }
  }
}

describe('在 worker 线程里导出', () => {
  it('存档与主线程导出逐字节相同，阶段按顺序报出，临时目录不留', async () => {
    const { outDir, input } = await project()
    const phases: string[] = []

    const inWorker = await exportPortableProjectInWorker({ ...input('worker.ainovel'), onProgress: (phase, round) => phases.push(`${round}:${phase}`) }, worker)
    const onMain = await onMainThread(input('main.ainovel'))

    expect(inWorker).toEqual(onMain)
    expect(fs.readFileSync(path.join(outDir, 'worker.ainovel')).equals(fs.readFileSync(path.join(outDir, 'main.ainovel')))).toBe(true)
    expect(phases).toEqual(['1:snapshot', '1:check', '1:tidy', '1:package'])
    expect(leftovers(outDir)).toEqual([])
    expect(portableExportsRunning()).toBe(0)
  }, 60_000)

  it('知识库闸门由主进程持有：主进程有人占着闸门时，worker 停在读取作品之后', async () => {
    const { fixture, outDir, input } = await project()
    const phases: PortableExportPhase[] = []
    let releaseMain!: () => void
    let reachedSnapshot!: () => void
    const snapshotReported = new Promise<void>(resolve => { reachedSnapshot = resolve })
    const held = withKnowledgeSourceGate(fixture.sourceStorage, () => new Promise<void>(resolve => { releaseMain = resolve }))

    const exporting = exportPortableProjectInWorker({
      ...input('gated.ainovel'),
      onProgress: phase => { phases.push(phase); if (phase === 'snapshot') reachedSnapshot() },
    }, worker)
    await snapshotReported
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(phases).toEqual(['snapshot'])
    releaseMain()
    await held
    await exporting

    expect(phases).toEqual(['snapshot', 'check', 'tidy', 'package'])
    expect(leftovers(outDir)).toEqual([])
  }, 60_000)

  it('失败时报出与主线程导出相同的错误', async () => {
    const { outDir, input } = await project()
    const cases: Array<[string, (name: string) => PortableExportInWorkerInput]> = [
      ['会话失效', name => ({ ...input(name), assertCurrentContext: () => false })],
      ['会话核对抛错', name => ({ ...input(name), assertCurrentContext: () => { throw new Error('PROJECT_SESSION_STALE') } })],
      ['目标已存在', name => { fs.writeFileSync(path.join(outDir, name), 'x'); return input(name) }],
    ]
    for (const [label, make] of cases) {
      const viaWorker = await outcome(exportPortableProjectInWorker(make(`${label}-w.ainovel`), worker))
      const viaMain = await outcome(onMainThread(make(`${label}-m.ainovel`)))
      expect(viaWorker, label).toEqual(viaMain)
      expect(viaWorker.ok, label).toBe(false)
    }
    expect(leftovers(outDir)).toEqual([])
  }, 60_000)

  it('取消后 worker 终止，不生成存档、不留临时目录', async () => {
    const { outDir, input } = await project()
    const controller = new AbortController()
    const reason = new Error('CLOUD_BACKUP_CANCELLED')

    const result = outcome(exportPortableProjectInWorker({
      ...input('cancelled.ainovel'),
      signal: controller.signal,
      onProgress: phase => { if (phase === 'snapshot') controller.abort(reason) },
    }, worker))

    expect(await result).toMatchObject({ ok: false, message: 'CLOUD_BACKUP_CANCELLED' })
    expect(fs.existsSync(path.join(outDir, 'cancelled.ainovel'))).toBe(false)
    expect(leftovers(outDir)).toEqual([])
    expect(portableExportsRunning()).toBe(0)
  }, 60_000)

  it('关闭作品时终止它的导出，报会话失效，临时目录删掉', async () => {
    const { fixture, outDir, input } = await project()
    let stopping: Promise<void> | undefined

    const result = outcome(exportPortableProjectInWorker({
      ...input('closed.ainovel'),
      onProgress: phase => { if (phase === 'snapshot') stopping = stopPortableExports(fixture.sourceRoot) },
    }, worker))

    expect(await result).toMatchObject({ ok: false, type: 'ProjectArchiveServiceError', code: 'PORTABLE_CONTEXT_INVALID' })
    await stopping
    expect(fs.existsSync(path.join(outDir, 'closed.ainovel'))).toBe(false)
    expect(leftovers(outDir)).toEqual([])
  }, 60_000)

  it.runIf(process.platform === 'win32')('临时目录里有文件被别的程序开着：删除作品前停导出几秒内就返回', async () => {
    const { fixture, outDir, input } = await project()
    let otherProgram: InstanceType<typeof BetterSqlite> | undefined
    let stopped: Promise<number> | undefined

    const result = outcome(exportPortableProjectInWorker({
      ...input('held.ainovel'),
      onProgress: phase => {
        if (phase !== 'snapshot') return
        const held = path.join(outDir, leftovers(outDir)[0]!, 'held')
        fs.mkdirSync(held)
        otherProgram = new BetterSqlite(path.join(held, 'sync.db'))
        otherProgram.exec('create table t (x)')
        const started = performance.now()
        stopped = stopPortableExports(fixture.sourceRoot).then(() => (performance.now() - started) / 1000)
      },
    }, worker))

    try {
      expect(await result).toMatchObject({ ok: false, code: 'PORTABLE_CONTEXT_INVALID' })
      expect(await stopped).toBeLessThan(5)
    } finally {
      otherProgram?.close()
    }
  }, 60_000)

  it('在途数读到 0 时临时目录已经删掉（退出应用靠它等清理）', async () => {
    const { outDir, input } = await project()
    const controller = new AbortController()
    let seen!: () => void
    const counted = new Promise<string[]>(resolve => {
      seen = () => {
        const poll = () => portableExportsRunning() === 0 ? resolve(leftovers(outDir)) : setImmediate(poll)
        poll()
      }
    })

    const result = outcome(exportPortableProjectInWorker({
      ...input('quit.ainovel'),
      signal: controller.signal,
      onProgress: phase => { if (phase === 'snapshot') { controller.abort(new Error('CLOUD_BACKUP_CANCELLED')); seen() } },
    }, worker))

    expect(await counted).toEqual([])
    expect(await result).toMatchObject({ ok: false, message: 'CLOUD_BACKUP_CANCELLED' })
  }, 60_000)

  it('停止导出时，worker 真正退出之后主进程才放开知识库闸门', async () => {
    const { fixture, outDir, input } = await project()
    const started = path.join(outDir, 'gated-work-started')
    const marker = path.join(outDir, 'gated-work-finished')
    const script = path.join(outDir, 'gated.mjs')
    // 拿到闸门后卡在同步子进程里：terminate 打断不了，worker 要等子进程写完标记才真正退出。路径经参数传，不拼进源码。
    fs.writeFileSync(path.join(outDir, 'gated-child.cjs'), [
      'const fs = require("node:fs")',
      'fs.writeFileSync(process.argv[2], "x")',
      'setTimeout(() => fs.writeFileSync(process.argv[3], "x"), 800)',
    ].join('\n'))
    fs.writeFileSync(script, [
      'import { execFileSync } from "node:child_process"',
      'import path from "node:path"',
      'import { parentPort, workerData } from "node:worker_threads"',
      'const outDir = workerData.attemptParentPath',
      'parentPort.once("message", () => execFileSync(process.execPath, [path.join(outDir, "gated-child.cjs"), path.join(outDir, "gated-work-started"), path.join(outDir, "gated-work-finished")]))',
      'parentPort.postMessage({ type: "gate-enter", id: 1, projectStorageRoot: path.join(workerData.sourceProjectRoot, ".ai-novel") })',
    ].join('\n'))
    const controller = new AbortController()

    const result = outcome(exportPortableProjectInWorker({ ...input('gated-stop.ainovel'), signal: controller.signal }, { ...worker, workerScript: script }))
    while (!fs.existsSync(started)) await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort(new Error('CLOUD_BACKUP_CANCELLED'))
    const finishedWhenAcquired = await withKnowledgeSourceGate(fixture.sourceStorage, async () => fs.existsSync(marker))

    expect(finishedWhenAcquired).toBe(true)
    expect(await result).toMatchObject({ ok: false, message: 'CLOUD_BACKUP_CANCELLED' })
    expect(leftovers(outDir)).toEqual([])
  }, 60_000)

  it('停止一本书的导出：等它和停止期间新起的导出都清理完才返回', async () => {
    const { fixture, outDir, input } = await project()
    let second: Promise<unknown> | undefined
    let stopping: Promise<void> | undefined

    const first = outcome(exportPortableProjectInWorker({
      ...input('first.ainovel'),
      onProgress: phase => {
        if (phase !== 'snapshot' || stopping) return
        stopping = stopPortableExports(fixture.sourceRoot)
        second = outcome(exportPortableProjectInWorker(input('second.ainovel'), worker))
      },
    }, worker))
    await first
    await stopping

    expect(portableExportsRunning()).toBe(0)
    expect(leftovers(outDir)).toEqual([])
    expect(await second).toMatchObject({ ok: false, code: 'PORTABLE_CONTEXT_INVALID' })
  }, 60_000)

  it('目标在作品目录里：拒绝，且拒绝前没在那里建临时目录', async () => {
    const { fixture, input } = await project()
    const inside = path.join(fixture.sourceRoot, 'exports')
    fs.mkdirSync(inside)
    const created: string[] = []
    const watcher = fs.watch(inside, (_event, name) => { if (name) created.push(String(name)) })
    // macOS 的 FSEvents 会补报 watch 之前建 inside 的那次事件：写个标记、等它报回来，事件流就对齐到这一刻。
    const settled = async (marker: string) => {
      fs.writeFileSync(path.join(inside, marker), '')
      while (!created.includes(marker)) await new Promise(resolve => setTimeout(resolve, 10))
    }
    await settled('.watch-ready')
    created.length = 0

    const result = await outcome(exportPortableProjectInWorker({
      ...input('x.ainovel'), targetArchivePath: path.join(inside, 'x.ainovel'), attemptParentPath: inside,
    }, worker))
    await settled('.watch-done')
    watcher.close()

    expect(result).toMatchObject({ ok: false, code: 'PORTABLE_TARGET_INSIDE_SOURCE' })
    expect(created.filter(name => !name.startsWith('.watch-'))).toEqual([])
  }, 60_000)

  it('存档一发布就算导出完成：这时停止也报成功，不会报失败又留下存档', async () => {
    const { fixture, outDir, input } = await project()
    const target = path.join(outDir, 'committed.ainovel')
    const script = path.join(outDir, 'commit.mjs')
    fs.writeFileSync(script, [
      'import fs from "node:fs"',
      'import { parentPort, workerData } from "node:worker_threads"',
      'if (workerData.commit) Atomics.compareExchange(workerData.commit, 0, 0, 1)',
      'fs.writeFileSync(workerData.targetArchivePath, "archive")',
      'parentPort.postMessage({ type: "progress", phase: "package" })',
      'setTimeout(() => parentPort.postMessage({ type: "done", receipt: { targetSha256: "sha" } }), 300)',
    ].join('\n'))

    const result = await outcome(exportPortableProjectInWorker({
      ...input('committed.ainovel'),
      onProgress: phase => { if (phase === 'package') void stopPortableExports(fixture.sourceRoot) },
    }, { ...worker, workerScript: script }))

    expect(result).toEqual({ ok: true })
    expect(fs.existsSync(target)).toBe(true)
    expect(leftovers(outDir)).toEqual([])
  }, 60_000)

  it('真实导出：存档出现那一刻停止，结果要么成功且存档在，要么失败且存档不在', async () => {
    const { fixture, outDir, input } = await project()
    const target = path.join(outDir, 'race.ainovel')
    let stopping: Promise<void> | undefined
    let settled = false
    // 导出在打包后失败时存档永远不会出现：落定后就不再轮询，免得测试结束后还在调度。
    const watch = () => {
      if (settled) return
      if (fs.existsSync(target)) stopping = stopPortableExports(fixture.sourceRoot)
      else setImmediate(watch)
    }

    const result = await outcome(exportPortableProjectInWorker({
      ...input('race.ainovel'), onProgress: phase => { if (phase === 'package') watch() },
    }, worker)).finally(() => { settled = true })
    await stopping

    expect({ ok: result.ok, archive: fs.existsSync(target) }).toEqual({ ok: result.ok, archive: result.ok })
    expect(leftovers(outDir)).toEqual([])
  }, 60_000)

  it('回执里的 sha256 就是目标文件的 sha256', async () => {
    const { outDir, input } = await project()
    const receipt = await exportPortableProjectInWorker(input('sha.ainovel'), worker)
    expect(receipt.targetSha256).toBe(createHash('sha256').update(fs.readFileSync(path.join(outDir, 'sha.ainovel'))).digest('hex'))
  }, 60_000)

  it('目标目录长到 225 个字符，主线程导出能成功的，worker 导出也能成功', async () => {
    const { outDir, input } = await project()
    const deep = path.join(outDir, 'd'.repeat(225 - outDir.length - 1))
    fs.mkdirSync(deep)
    const at = (name: string): PortableExportInWorkerInput => ({ ...input(name), targetArchivePath: path.join(deep, name), attemptParentPath: deep })

    expect(await outcome(onMainThread(at('m.ainovel')))).toEqual({ ok: true })
    expect(await outcome(exportPortableProjectInWorker(at('w.ainovel'), worker))).toEqual({ ok: true })
    expect(leftovers(deep)).toEqual([])
  }, 60_000)

  it('worker 里读不了作品文件：交回的系统报错带着出错的路径，主进程据此认出是作品文件（#702）', async () => {
    const { fixture, input } = await project()
    const manifest = path.join(fixture.sourceStorage, 'project.json')
    const lock = process.platform === 'win32'
      ? () => execFileSync('icacls', [manifest, '/deny', '*S-1-1-0:(RD)'], { stdio: 'ignore' })
      : () => fs.chmodSync(manifest, 0)
    const unlock = process.platform === 'win32'
      ? () => execFileSync('icacls', [manifest, '/remove:d', '*S-1-1-0'], { stdio: 'ignore' })
      : () => fs.chmodSync(manifest, 0o600)
    lock()
    try {
      const failure = await exportPortableProjectInWorker(input('locked.ainovel'), worker).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: expect.stringMatching(/^(EACCES|EPERM)$/u), path: manifest })
    } finally { unlock() }
  }, 60_000)

  it.runIf(process.platform === 'win32')('作品文件连属性也读不了：照样交回带路径的系统报错，不说成文件不安全（#702）', async () => {
    const { fixture, input } = await project()
    const manifest = path.join(fixture.sourceStorage, 'project.json')
    execFileSync('icacls', [manifest, '/deny', '*S-1-1-0:(R)'], { stdio: 'ignore' })
    try {
      const failure = await exportPortableProjectInWorker(input('locked.ainovel'), worker).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'EPERM', path: manifest })
    } finally { execFileSync('icacls', [manifest, '/remove:d', '*S-1-1-0'], { stdio: 'ignore' }) }
  }, 60_000)

  it('worker 崩溃时日志不带路径：报错原文可能含用户名或作品目录', async () => {
    const { outDir, input } = await project()
    const script = path.join(outDir, 'crash-path.mjs')
    fs.writeFileSync(script, [
      'import { workerData } from "node:worker_threads"',
      'throw new Error(workerData.sourceProjectRoot)',
    ].join('\n'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await outcome(exportPortableProjectInWorker(input('crash-path.ainovel'), { ...worker, workerScript: script }))
      expect(result).toMatchObject({ ok: false, code: 'PORTABLE_EXPORT_INTERRUPTED' })
      const root = input('x').sourceProjectRoot
      const printed = logged.mock.calls.flat().map(value => value instanceof Error ? `${value.message} ${value.stack}` : String(value)).join(' ')
      expect(printed).not.toContain(path.basename(root))
    } finally { logged.mockRestore() }
  }, 60_000)

  it.each([
    ['抛错', 'throw new Error("worker crashed")'],
    ['没交结果就退出', 'process.exit(3)'],
  ])('worker %s：报导出中断，主进程删掉临时目录', async (_label, ending) => {
    const { outDir, input } = await project()
    const script = path.join(outDir, 'crash.mjs')
    fs.writeFileSync(script, [
      'import fs from "node:fs"',
      'import path from "node:path"',
      'import { workerData } from "node:worker_threads"',
      'fs.writeFileSync(path.join(workerData.attemptRoot, "half.db"), "x")',
      ending,
    ].join('\n'))

    const result = await outcome(exportPortableProjectInWorker(input('crashed.ainovel'), { ...worker, workerScript: script }))

    expect(result).toMatchObject({ ok: false, type: 'ProjectArchiveServiceError', code: 'PORTABLE_EXPORT_INTERRUPTED' })
    expect(leftovers(outDir)).toEqual([])
    expect(portableExportsRunning()).toBe(0)
  }, 60_000)
})
