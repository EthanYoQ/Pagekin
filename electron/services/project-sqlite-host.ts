import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import * as electron from 'electron'

import type { ProjectOverview } from '../../src/shared/project-overview'
import type { PeekSnapshotRequest } from './project-peek'
import type { SqliteContentIdentity } from './sqlite-project-migration'

const WORKER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'project-sqlite-worker.js')

export interface ProjectSqliteWorkerOptions {
  workerScript: string
  electronExports: string[]
}

export type ProjectSqliteJob =
  | { kind: 'open'; databasePath: string }
  | { kind: 'peek'; request: PeekSnapshotRequest }
type JobResult<J extends ProjectSqliteJob> = J extends { kind: 'open' } ? SqliteContentIdentity : ProjectOverview

export interface ProjectSqliteWorkerData { job: ProjectSqliteJob; electronExports: string[] }

/** 跨线程会丢掉错误的名字和 code；带回这两样，打开失败的报错与在主线程跑时一字不差。 */
export interface SerializedWorkerError { name: string; message: string; code?: string }
export type ProjectSqliteWorkerMessage = { ok: true; value: unknown } | { ok: false; error: SerializedWorkerError }

export function serializeWorkerError(error: unknown): SerializedWorkerError {
  const failure = error instanceof Error ? error : new Error(String(error))
  const code = (failure as { code?: unknown }).code
  return {
    name: failure.name,
    message: failure.message,
    ...(typeof code === 'string' ? { code } : {}),
  }
}

function rehydrateWorkerError(error: SerializedWorkerError): Error {
  return Object.assign(new Error(error.message), { name: error.name }, error.code === undefined ? {} : { code: error.code })
}

export async function runProjectSqliteJobInWorker<J extends ProjectSqliteJob>(
  job: J,
  { workerScript = WORKER_SCRIPT, electronExports = Object.keys(electron) }: Partial<ProjectSqliteWorkerOptions> = {},
): Promise<JobResult<J>> {
  const worker = new Worker(workerScript, { workerData: { job, electronExports } satisfies ProjectSqliteWorkerData })
  try {
    return await new Promise<JobResult<J>>((resolve, reject) => {
      worker.once('message', (message: ProjectSqliteWorkerMessage) => message.ok
        ? resolve(message.value as JobResult<J>)
        : reject(rehydrateWorkerError(message.error)))
      worker.once('error', reject)
      worker.once('exit', code => reject(new Error(`PROJECT_SQLITE_WORKER_EXITED_${code}`)))
    })
  } finally {
    await worker.terminate()
  }
}
