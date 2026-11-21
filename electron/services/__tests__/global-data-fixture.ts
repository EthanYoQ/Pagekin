import fs from 'node:fs'
import path from 'node:path'

type SyncFunction = (...args: unknown[]) => unknown

function withSyncFsErrors<T>(run: () => T): { value: T; fsErrors: unknown[] } {
  const fsErrors: unknown[] = []
  const fsTable = fs as unknown as Record<string, unknown>
  const originals = Object.entries(fsTable).filter((entry): entry is [string, SyncFunction] =>
    entry[0].endsWith('Sync') && typeof entry[1] === 'function')
  for (const [name, original] of originals) {
    fsTable[name] = (...args: unknown[]) => {
      try { return original.apply(fs, args) } catch (error) { fsErrors.push(error); throw error }
    }
  }
  try { return { value: run(), fsErrors } } finally {
    for (const [name, original] of originals) fsTable[name] = original
  }
}

/** Existing consumer tests use the real coordinator with three synthetic siblings. */
export async function prepareGlobalDataFixture(root: string): Promise<string> {
  const legacySource = path.join(root, 'legacy'), canonicalTarget = path.join(root, 'canonical'), userData = path.join(root, 'userData')
  process.env.AI_NOVEL_VELA_HOME = legacySource
  process.env.AI_NOVEL_APP_DATA_HOME = canonicalTarget
  const { runGlobalDataMigration, activateGlobalData } = await import('../global-data-migration')
  const { value: result, fsErrors } = withSyncFsErrors(() =>
    runGlobalDataMigration({ legacySource, canonicalTarget, userData, exclusiveAccess: true }))
  if (result.state !== 'ready') {
    throw new Error(result.code, result.code === 'GLOBAL_MIGRATION_IO_FAILED' ? { cause: fsErrors.at(-1) } : undefined)
  }
  activateGlobalData(result)
  return result.dataRoot
}
