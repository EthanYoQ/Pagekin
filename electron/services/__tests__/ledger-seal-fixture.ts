import type Database from 'better-sqlite3'
import type { createMainGenerationOwner } from '../main-generation-owner'

type Db = Database.Database
type Owner = ReturnType<typeof createMainGenerationOwner>
export type LedgerHandle = { rootActionId: string; runId: string }
export type DamagedColumn = 'action_json' | 'budget_json' | 'binding_json' | 'usage_receipt_json' | 'artifact_json'

const DAMAGE: Record<DamagedColumn, string> = {
  action_json: 'UPDATE generation_roots SET action_json=\'{坏\' WHERE root_action_id=?',
  budget_json: 'UPDATE generation_roots SET budget_json=\'{坏\' WHERE root_action_id=?',
  binding_json: 'UPDATE generation_runs SET binding_json=\'{坏\' WHERE run_id=?',
  usage_receipt_json: 'UPDATE generation_attempts SET usage_receipt_json=\'{坏\' WHERE run_id=?',
  artifact_json: 'UPDATE generation_artifacts SET artifact_json=\'{坏\' WHERE run_id=?',
}

export function damageLedger(db: Db, column: DamagedColumn, handle: LedgerHandle): void {
  const onRoot = column === 'action_json' || column === 'budget_json'
  const changed = db.prepare(DAMAGE[column]).run(onRoot ? handle.rootActionId : handle.runId).changes
  if (!changed) throw new Error(`fixture has no ${column} row to damage`)
}

export const rootCount = (db: Db) => db.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get() as number

export function enumerations(owner: Owner): [string, () => unknown][] {
  return [
    ['list()', () => owner.list(['chapter-draft', 'chapter-blueprint-directory', 'review-chapter', 'generate-plot-outline'])],
    ['listRecovery()', () => owner.listRecovery()],
    ['listBatches()', () => owner.listBatches()],
    ['listDirectoryProgress()', () => owner.listDirectoryProgress()],
    ['findBlueprintRecovery()', () => owner.findBlueprintRecovery()],
    ['readLatestContinuityCheck()', () => owner.readLatestContinuityCheck()],
    ['listContinuitySuggestions()', () => owner.listContinuitySuggestions({ finalizationId: 'none' })],
  ]
}

export async function failingCalls(calls: [string, () => unknown][]): Promise<string[]> {
  const failures: string[] = []
  for (const [name, call] of calls) {
    try { await call() } catch (error) { failures.push(`${name}: ${(error as Error).message.slice(0, 120)}`) }
  }
  return failures
}
