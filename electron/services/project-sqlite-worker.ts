import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'

import type { OpenedProjectSqlite, ProjectSqliteWorkerData, ProjectSqliteWorkerMessage } from './project-sqlite-host'
import { stubElectron } from './worker-electron-stub'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const { job, electronExports } = workerData as ProjectSqliteWorkerData

stubElectron(electronExports)
// 先装好 electron 桩再动态 import：静态 import 会先于 stubElectron 执行。
void Promise.all([import('./sqlite-project-migration'), import('./project-peek'), import('./project-sqlite-host'), import('../repositories/generation-ledger-admission'), import('./review-proof-tidy')])
  .then(([migration, peek, host, ledger, proofs]) => {
    // 账本扫描结果随内容身份一起交回，主进程据此省掉一次整库扫描。
    const open = (databasePath: string): OpenedProjectSqlite => {
      let identity = migration.openProjectSqlite({ databasePath })
      // 整理在校验之后、主进程拿句柄之前：这时没有别人持着这本书。整理改过库就按新字节再校验一遍。
      if (proofs.tidyReviewProofs(databasePath)) identity = migration.openProjectSqlite({ databasePath })
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
