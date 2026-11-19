import { parentPort, workerData } from 'node:worker_threads'

import type { PortableExportWorkerData } from './portable-export-job'
import { stubElectron } from './worker-electron-stub'

const { electronExports, commit, ...job } = workerData as PortableExportWorkerData

stubElectron(electronExports)
void import('./portable-export-job').then(({ runPortableExportJob }) => runPortableExportJob(parentPort!, job, commit))
