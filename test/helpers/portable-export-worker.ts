import fs from 'node:fs'
import path from 'node:path'

import { build } from 'esbuild'

import type { PortableExportWorkerOptions } from '../../electron/services/portable-export-host'

let built: Promise<PortableExportWorkerOptions> | undefined

/**
 * 把导出 worker 打成测试能跑的 ESM。输出放在仓库里，worker 里的 createRequire 才找得到 better-sqlite3。
 * electron 保持外部依赖，测试走的是生产 worker 里的同一个空模块钩子。
 */
export function portableExportWorkerForTest(): Promise<PortableExportWorkerOptions> {
  built ??= (async () => {
    const base = path.resolve('.runtime/.cache/portable-export-worker')
    fs.mkdirSync(base, { recursive: true })
    const outdir = fs.mkdtempSync(path.join(base, 'build-'))
    await build({
      entryPoints: { 'portable-export-worker': path.resolve('electron/services/portable-export-worker.ts') },
      outdir,
      outExtension: { '.js': '.mjs' },
      bundle: true,
      splitting: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'error',
    })
    return { workerScript: path.join(outdir, 'portable-export-worker.mjs'), electronExports: ['app', 'nativeImage'] }
  })()
  return built
}
