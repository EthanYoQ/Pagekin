import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

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

const GENERATION = '00000000-0000-4000-8000-000000000001'
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
    const phases: PortableExportPhase[] = []

    const inWorker = await exportPortableProjectInWorker({ ...input('worker.ainovel'), onProgress: phase => phases.push(phase) }, worker)
    const onMain = await onMainThread(input('main.ainovel'))

    expect(inWorker).toEqual(onMain)
    expect(fs.readFileSync(path.join(outDir, 'worker.ainovel')).equals(fs.readFileSync(path.join(outDir, 'main.ainovel')))).toBe(true)
    expect(phases).toEqual(['snapshot', 'check', 'tidy', 'package'])
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
      'fs.writeFileSync(path.join(workerData.attemptParentPath, "half.db"), "x")',
      ending,
    ].join('\n'))

    const result = await outcome(exportPortableProjectInWorker(input('crashed.ainovel'), { ...worker, workerScript: script }))

    expect(result).toMatchObject({ ok: false, type: 'ProjectArchiveServiceError', code: 'PORTABLE_EXPORT_INTERRUPTED' })
    expect(leftovers(outDir)).toEqual([])
    expect(portableExportsRunning()).toBe(0)
  }, 60_000)
})
