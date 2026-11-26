import { isContentHash, isFinalizedSourceIdentity, sameProjectEpoch, type ProjectEpoch } from './source-ref'
import type { FinalizedSourceIdentity } from './finalized-continuity'

export const MIGRATION_IDS = ['M00', 'M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M11'] as const
export type MigrationId = typeof MIGRATION_IDS[number]
export const PROJECT_MIGRATION_JOURNAL = '.ai-novel-migration/journal.json'
export const STORAGE_ENVIRONMENT = {
  legacySource: 'AI_NOVEL_LEGACY_SOURCE_HOME', legacySourceCompatibility: 'AI_NOVEL_VELA_HOME',
  canonicalTarget: 'AI_NOVEL_APP_DATA_HOME',
} as const
export type MigrationPhysicalPhase = 'prepared' | 'verified' | 'legacy-isolated' | 'target-installed' | 'switched'
export interface StorageRootProof {
  canonicalRealPath: string; platform: 'win32' | 'darwin' | 'linux'
  reparseFree: boolean; authorized: boolean
}
export interface GlobalStorageLocators {
  legacySource: StorageRootProof; canonicalTarget: StorageRootProof; userData: StorageRootProof
}
export function assertDistinctStorageRoots(roots: readonly StorageRootProof[]): void {
  const paths = roots.map(root => {
    if (!root.authorized || !root.reparseFree || !root.canonicalRealPath) throw new Error('STORAGE_ROOT_UNPROVEN')
    const canonical = root.canonicalRealPath.replace(/\\/gu, '/').replace(/\/$/u, '')
    return root.platform === 'win32' ? canonical.toLowerCase() : canonical
  })
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    if (paths[i] === paths[j] || paths[i]!.startsWith(paths[j]! + '/') || paths[j]!.startsWith(paths[i]! + '/')) throw new Error('STORAGE_ROOT_INTERSECTION')
  }
}
export type MainReady = { state: 'pending' | 'blocked' } | { state: 'ready'; globalGeneration: string }
export function mayHydrateAppearance(ready: MainReady): ready is Extract<MainReady, { state: 'ready' }> {
  return ready.state === 'ready' && typeof ready.globalGeneration === 'string' && ready.globalGeneration.length > 0
}
export interface TransferReadableAuthority {
  transferId: string; origin: ProjectEpoch; target: ProjectEpoch; snapshotGeneration: string
  domainId: string; source: FinalizedSourceIdentity; provenance: 'author' | 'derived'
  sourceCurrent: boolean; sourceUnambiguous: boolean; restoredContentHash: string
  nonReplayable: true
}
export function mayReadTransferredAuthority(receipt: TransferReadableAuthority, target: ProjectEpoch): boolean {
  return Boolean(receipt.transferId && receipt.snapshotGeneration && receipt.domainId)
    && Boolean(receipt.origin.projectId && receipt.origin.epoch) && isFinalizedSourceIdentity(receipt.source)
    && receipt.origin.projectId !== receipt.target.projectId && receipt.origin.epoch !== receipt.target.epoch
    && sameProjectEpoch(receipt.target, target) && receipt.nonReplayable === true
    && receipt.sourceCurrent && receipt.sourceUnambiguous && ['author', 'derived'].includes(receipt.provenance)
    && isContentHash(receipt.restoredContentHash) && receipt.restoredContentHash === receipt.source.contentHash
}
export interface PortableExecutionHistory {
  nonReplayable: true; originalRootActionId: string
  status: 'settled' | 'unknown' | 'pending' | 'inflight' | 'candidate'
  presentation: 'visible-history' | 'awaiting-explicit-adoption'
  reservedTokens: number
}
export interface PortableReceiptProjection {
  redactedProjection: Readonly<Record<string, string | number | boolean | null>>
  projectionHash: string; excludedFieldNames: readonly string[]; nonReplayable: true
  integrityScope: 'projection-only'
}
export function mayReplayTransferredExecution(history: PortableExecutionHistory): false {
  void history
  return false
}
