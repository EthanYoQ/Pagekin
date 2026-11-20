import { parentPort, workerData } from 'node:worker_threads'

import type { PortableExportWorkerData } from './portable-export-job'
import { stubElectron } from './worker-electron-stub'

const { electronExports, commit, ...job } = workerData as PortableExportWorkerData

stubElectron(electronExports)
// 先装好 electron 桩再动态 import：静态 import 会先于 stubElectron 执行。
void import('./portable-export-job').then(({ runPortableExportJob }) => runPortableExportJob(parentPort!, job, commit))
