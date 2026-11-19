import { parentPort, workerData } from 'node:worker_threads'

import type { ProjectSqliteWorkerData, ProjectSqliteWorkerMessage } from './project-sqlite-host'
import { stubElectron } from './worker-electron-stub'

const { job, electronExports } = workerData as ProjectSqliteWorkerData

stubElectron(electronExports)
void Promise.all([import('./sqlite-project-migration'), import('./project-peek'), import('./project-sqlite-host')])
  .then(([migration, peek, host]) => {
    let message: ProjectSqliteWorkerMessage
    try {
      message = { ok: true, value: job.kind === 'open' ? migration.openProjectSqlite({ databasePath: job.databasePath }) : peek.readPeekSnapshot(job.request) }
    } catch (error) {
      message = { ok: false, error: host.serializeWorkerError(error) }
    }
    parentPort!.postMessage(message)
  })
