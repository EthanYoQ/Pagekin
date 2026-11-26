import fs from 'node:fs'
import path from 'node:path'

import { build } from 'esbuild'

import type { PortableExportWorkerOptions } from '../../electron/services/portable-export-host'
import type { ProjectSqliteWorkerOptions } from '../../electron/services/project-sqlite-host'

const ENTRIES = {
  'portable-export-worker': 'electron/services/portable-export-worker.ts',
  'project-sqlite-worker': 'electron/services/project-sqlite-worker.ts',
}
let built: Promise<string> | undefined

async function workerForTest(name: keyof typeof ENTRIES): Promise<{ workerScript: string; electronExports: string[] }> {
  built ??= (async () => {
    const base = path.resolve('.runtime/.cache/portable-export-worker')
    fs.mkdirSync(base, { recursive: true })
    const outdir = fs.mkdtempSync(path.join(base, 'build-'))
    await build({
      entryPoints: Object.fromEntries(Object.entries(ENTRIES).map(([entry, file]) => [entry, path.resolve(file)])),
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
    return outdir
  })()
  return { workerScript: path.join(await built, `${name}.mjs`), electronExports: ['app', 'nativeImage'] }
}

export const portableExportWorkerForTest = (): Promise<PortableExportWorkerOptions> => workerForTest('portable-export-worker')
export const projectSqliteWorkerForTest = (): Promise<ProjectSqliteWorkerOptions> => workerForTest('project-sqlite-worker')
