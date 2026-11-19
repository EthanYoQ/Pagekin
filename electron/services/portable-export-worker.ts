import { registerHooks } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'

import type { PortableExportWorkerData } from './portable-export-job'

const { electronExports, commit, ...job } = workerData as PortableExportWorkerData

// 导出链上有模块在加载时 import 了 electron，只在主进程里调用它的 API。worker 线程没有 electron 内置模块，
// 打包后也没有 npm 的 electron 包，这里把它解析成同名导出全为 undefined 的空模块；真调用到会直接报错。
// 导出代码要在钩子装好之后才加载，所以用动态 import。
const stub = [
  'export default {}',
  ...electronExports.filter(name => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name)).map(name => `export const ${name} = undefined`),
].join('\n')
registerHooks({
  resolve: (specifier, context, next) => specifier === 'electron'
    ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    : next(specifier, context),
})

void import('./portable-export-job').then(({ runPortableExportJob }) => runPortableExportJob(parentPort!, job, commit))
