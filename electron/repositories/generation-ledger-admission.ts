import type Database from 'better-sqlite3'

export const GENERATION_LEDGER_UNREADABLE = 'GENERATION_LEDGER_UNREADABLE'

type LedgerTable = 'generation_roots' | 'generation_runs' | 'generation_attempts' | 'generation_artifacts'
export interface AdmittedLedgerCell {
  table: LedgerTable
  idColumn: string
  column: string
  nullable: boolean
}

export const ADMITTED_LEDGER_CELLS: readonly AdmittedLedgerCell[] = [
  { table: 'generation_roots', idColumn: 'root_action_id', column: 'action_json', nullable: false },
  { table: 'generation_roots', idColumn: 'root_action_id', column: 'budget_json', nullable: false },
  { table: 'generation_runs', idColumn: 'run_id', column: 'binding_json', nullable: false },
  { table: 'generation_attempts', idColumn: 'attempt_id', column: 'attempt_json', nullable: false },
  { table: 'generation_attempts', idColumn: 'attempt_id', column: 'usage_receipt_json', nullable: true },
  { table: 'generation_artifacts', idColumn: 'artifact_id', column: 'artifact_json', nullable: false },
]

export interface LedgerAdmission { sealedRootActionIds: readonly string[] }

export function admitGenerationLedger(_db: Database.Database): LedgerAdmission {
  return { sealedRootActionIds: [] }
}
