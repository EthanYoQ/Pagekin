import type { MessagePort } from 'node:worker_threads'

import type { DamagedReviewCycle } from '../../src/shared/damaged-review-cycle'
import type { PortableExportPhase, ProjectSessionContext } from '../../src/shared/ipc-channels'
import { SchemaMigrationError } from '../migrations/registry'
import { PortableProjectArchiveError, type PortableProjectArchiveErrorCode } from './portable-project-archive'
import { createPortableProjectAssetProvider } from './portable-project-assets'
import {
  ProjectArchiveServiceError,
  exportPortableProject,
  type ExportPortableProjectReceipt,
  type ProjectArchiveServiceErrorCode,
} from './project-archive-service'

/** 交给 worker 的导出任务：只有可结构化克隆的数据，函数留在主进程。 */
export interface PortableExportJob {
  sourceProjectRoot: string
  projectSession: ProjectSessionContext
  targetArchivePath: string
  attemptParentPath: string
  snapshotGeneration?: string
  /** ISO 时间；不给时用导出当时的时间。 */
  now?: string
}

export interface PortableExportWorkerData extends PortableExportJob {
  /** 主进程里 electron 模块的导出名，worker 照着造一个空模块。 */
  electronExports: string[]
  /** 共享的提交标志，见 claimPublish 与 claimStop。 */
  commit: Int32Array
}

const OPEN = 0
const PUBLISHING = 1
const STOPPED = 2

/**
 * 发布存档是提交点。worker 发布前、主进程从外部停止前都抢这一个标志，先到的说了算：
 * worker 抢到就一定把结果交回来，主进程不再报失败；主进程抢到，worker 就不发布。消息在路上时也不会两边各判一次。
 */
export function claimPublish(commit: Int32Array): boolean {
  return Atomics.compareExchange(commit, 0, OPEN, PUBLISHING) !== STOPPED
}

export function claimStop(commit: Int32Array): boolean {
  return Atomics.compareExchange(commit, 0, OPEN, STOPPED) !== PUBLISHING
}

/** 跨线程会丢掉错误的类和 code，按两个控制器认的几种错误逐一带过去。 */
export type SerializedExportError =
  | { kind: 'archive-service'; code: ProjectArchiveServiceErrorCode }
  | { kind: 'archive'; code: PortableProjectArchiveErrorCode }
  | { kind: 'schema'; code: string; damagedReviewCycle?: DamagedReviewCycle }
  | { kind: 'error'; message: string; code?: string }

export type WorkerToHost =
  | { type: 'progress'; phase: PortableExportPhase }
  | { type: 'context'; id: number; context: ProjectSessionContext; sourceProjectRoot: string }
  | { type: 'gate-enter'; id: number; projectStorageRoot: string }
  | { type: 'gate-exit' }
  | { type: 'done'; receipt: ExportPortableProjectReceipt }
  | { type: 'failed'; error: SerializedExportError }

export interface HostToWorker { id: number; ok: boolean }

type HostQuestion<T = Extract<WorkerToHost, { id: number }>> = T extends unknown ? Omit<T, 'id'> : never

export function serializeExportError(error: unknown): SerializedExportError {
  if (error instanceof ProjectArchiveServiceError) return { kind: 'archive-service', code: error.code }
  if (error instanceof PortableProjectArchiveError) return { kind: 'archive', code: error.code }
  if (error instanceof SchemaMigrationError) return { kind: 'schema', code: error.code, damagedReviewCycle: error.damagedReviewCycle }
  const code = (error as { code?: unknown } | null)?.code
  return { kind: 'error', message: error instanceof Error ? error.message : String(error), ...(typeof code === 'string' ? { code } : {}) }
}

export function rehydrateExportError(error: SerializedExportError): Error {
  switch (error.kind) {
    case 'archive-service': return new ProjectArchiveServiceError(error.code)
    case 'archive': return new PortableProjectArchiveError(error.code)
    case 'schema': return new SchemaMigrationError(error.code, error.damagedReviewCycle)
    case 'error': return Object.assign(new Error(error.message), error.code === undefined ? {} : { code: error.code })
  }
}

/** 会话核对与知识库闸门都问主进程，worker 里不持有。 */
export async function runPortableExportJob(port: MessagePort, job: PortableExportJob, commit: Int32Array): Promise<void> {
  const post = (message: WorkerToHost) => port.postMessage(message)
  const waiting = new Map<number, (ok: boolean) => void>()
  let nextId = 0
  const onReply = ({ id, ok }: HostToWorker) => { waiting.get(id)?.(ok); waiting.delete(id) }
  port.on('message', onReply)
  const ask = (message: HostQuestion) => new Promise<boolean>(resolve => {
    const id = ++nextId
    waiting.set(id, resolve)
    post({ ...message, id } as WorkerToHost)
  })
  try {
    const receipt = await exportPortableProject({
      sourceProjectRoot: job.sourceProjectRoot,
      projectSession: job.projectSession,
      targetArchivePath: job.targetArchivePath,
      attemptParentPath: job.attemptParentPath,
      snapshotGeneration: job.snapshotGeneration,
      now: job.now === undefined ? undefined : () => new Date(job.now!),
      assets: createPortableProjectAssetProvider(),
      assertCurrentContext: (context, sourceProjectRoot) => ask({ type: 'context', context: { ...context }, sourceProjectRoot }),
      async withSourceGate(projectStorageRoot, operation) {
        await ask({ type: 'gate-enter', projectStorageRoot })
        try { return await operation() } finally { post({ type: 'gate-exit' }) }
      },
      onProgress: phase => post({ type: 'progress', phase }),
      beforePublish() {
        if (!claimPublish(commit)) throw new ProjectArchiveServiceError('PORTABLE_CONTEXT_INVALID')
      },
    })
    post({ type: 'done', receipt })
  } catch (error) {
    post({ type: 'failed', error: serializeExportError(error) })
  } finally {
    port.off('message', onReply)
  }
}
