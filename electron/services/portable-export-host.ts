import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import * as electron from 'electron'

import { withKnowledgeSourceGate } from './knowledge-source-gate'
import {
  claimStop,
  rehydrateExportError,
  type HostToWorker,
  type PortableExportJob,
  type PortableExportWorkerData,
  type WorkerToHost,
} from './portable-export-job'
import {
  ProjectArchiveServiceError,
  assertPortableExportPaths,
  type ExportPortableProjectInput,
  type ExportPortableProjectReceipt,
} from './project-archive-service'

const WORKER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'portable-export-worker.js')

export interface PortableExportWorkerOptions {
  workerScript: string
  electronExports: string[]
}

export type PortableExportInWorkerInput = PortableExportJob
  & Pick<ExportPortableProjectInput, 'assertCurrentContext' | 'onProgress'>
  & { signal?: AbortSignal }

interface RunningExport {
  sourceProjectRoot: string
  stop(error: Error): void
  cleaned: Promise<void>
}

const running = new Set<RunningExport>()
const projectKey = (root: string) => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)

/**
 * 导出在 worker 线程里跑，主进程只应答会话核对与知识库闸门、转发进度。
 * 主进程在 attemptParentPath 下建一个 .pe- 目录交给 worker 直接当临时目录。结束后不论成败（含取消、worker 崩溃），
 * 都等 worker 真正退出才放开闸门、删目录、注销在途登记：退出应用和关库靠在途登记判断还要不要等。
 */
export async function exportPortableProjectInWorker(
  input: PortableExportInWorkerInput,
  { workerScript = WORKER_SCRIPT, electronExports = Object.keys(electron) }: Partial<PortableExportWorkerOptions> = {},
): Promise<ExportPortableProjectReceipt> {
  const { assertCurrentContext, onProgress, signal, ...job } = input
  signal?.throwIfAborted()
  assertPortableExportPaths(job)
  const runRoot = fs.mkdtempSync(path.join(path.resolve(job.attemptParentPath), '.pe-'))
  const commit = new Int32Array(new SharedArrayBuffer(4))
  const runIdentity = fs.lstatSync(runRoot, { bigint: true })
  let markCleaned!: () => void
  const entry: RunningExport = { sourceProjectRoot: projectKey(job.sourceProjectRoot), stop: () => {}, cleaned: new Promise(resolve => { markCleaned = resolve }) }
  let releaseGate: (() => void) | undefined
  let finished = false
  let onAbort: (() => void) | undefined
  let worker: Worker | undefined
  try {
    return await new Promise<ExportPortableProjectReceipt>((resolve, reject) => {
      const thread = worker = new Worker(workerScript, { workerData: { ...job, attemptRoot: runRoot, electronExports, commit } satisfies PortableExportWorkerData })
      const reply = (message: HostToWorker) => { if (!finished) thread.postMessage(message) }
      const fail = (error: Error) => { reject(error); void thread.terminate() }
      entry.stop = error => { if (claimStop(commit)) fail(error) }
      running.add(entry)
      onAbort = () => entry.stop(signal!.reason instanceof Error ? signal!.reason : new Error('PORTABLE_EXPORT_ABORTED'))
      signal?.addEventListener('abort', onAbort, { once: true })
      thread.on('message', (message: WorkerToHost) => {
        switch (message.type) {
          case 'progress':
            try { onProgress?.(message.phase, message.round) } catch { /* 进度只是提示，丢了不影响导出。 */ }
            return
          case 'context':
            void Promise.resolve()
              .then(() => assertCurrentContext(message.context, message.sourceProjectRoot))
              .then(result => result !== false, () => false)
              .then(ok => reply({ id: message.id, ok }))
            return
          case 'gate-enter':
            void withKnowledgeSourceGate(message.projectStorageRoot, () => new Promise<void>(release => {
              if (finished) return release()
              releaseGate = release
              reply({ id: message.id, ok: true })
            }))
            return
          case 'gate-exit':
            releaseGate?.()
            releaseGate = undefined
            return
          case 'done':
            resolve(message.receipt)
            return
          case 'failed':
            reject(rehydrateExportError(message.error))
        }
      })
      thread.once('error', error => {
        // 报错原文可能含用户名或作品目录，只记类型与错误码。
        console.error('[portable-export] worker 出错', (error as Error).name, (error as NodeJS.ErrnoException).code)
        fail(new ProjectArchiveServiceError('PORTABLE_EXPORT_INTERRUPTED'))
      })
      thread.once('exit', () => reject(new ProjectArchiveServiceError('PORTABLE_EXPORT_INTERRUPTED')))
    })
  } finally {
    finished = true
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    await worker?.terminate()
    releaseGate?.()
    await removeRunRoot(runRoot, runIdentity)
    running.delete(entry)
    markCleaned()
  }
}

async function removeRunRoot(root: string, identity: fs.BigIntStats): Promise<void> {
  try {
    const actual = await fs.promises.lstat(root, { bigint: true })
    if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== identity.dev || actual.ino !== identity.ino) return
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    console.warn('[portable-export] 临时目录没删掉', (error as NodeJS.ErrnoException).code)
  }
}

/**
 * 终止在途导出（不给作品路径就是全部），等 worker 退出、临时目录删完。
 * 主线程实现在作品关闭后的下一次会话核对报 PORTABLE_CONTEXT_INVALID，这里报同一个码。
 */
export async function stopPortableExports(sourceProjectRoot?: string): Promise<void> {
  const key = sourceProjectRoot === undefined ? undefined : projectKey(sourceProjectRoot)
  const matching = () => [...running].filter(entry => key === undefined || entry.sourceProjectRoot === key)
  // 等待期间可能又起了新的导出，停到这本书一个不剩为止。
  for (let entries = matching(); entries.length > 0; entries = matching()) {
    for (const entry of entries) entry.stop(new ProjectArchiveServiceError('PORTABLE_CONTEXT_INVALID'))
    await Promise.all(entries.map(entry => entry.cleaned))
  }
}

export function portableExportsRunning(): number {
  return running.size
}
