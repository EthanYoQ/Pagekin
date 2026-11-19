import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'

import type { OpenedProjectSqlite, ProjectSqliteWorkerData, ProjectSqliteWorkerMessage } from './project-sqlite-host'
import { stubElectron } from './worker-electron-stub'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const { job, electronExports } = workerData as ProjectSqliteWorkerData

stubElectron(electronExports)
// 先装好 electron 桩再动态 import：静态 import 会先于 stubElectron 执行。
void Promise.all([import('./sqlite-project-migration'), import('./project-peek'), import('./project-sqlite-host'), import('../repositories/generation-ledger-admission')])
  .then(([migration, peek, host, ledger]) => {
    // 长篇扫一遍账本要几百毫秒。这里对同一份字节扫，主进程核对内容身份相同，账本干净就不再扫。
    const open = (databasePath: string): OpenedProjectSqlite => {
      const identity = migration.openProjectSqlite({ databasePath })
      const reader = new Database(databasePath, { readonly: true, fileMustExist: true })
      try { return { identity, ledgerNeedsAdmission: ledger.ledgerNeedsAdmission(reader) } } finally { reader.close() }
    }
    let message: ProjectSqliteWorkerMessage
    try {
      message = { ok: true, value: job.kind === 'open' ? open(job.databasePath) : peek.readPeekSnapshot(job.request) }
    } catch (error) {
      message = { ok: false, error: host.serializeWorkerError(error) }
    }
    parentPort!.postMessage(message)
  })
