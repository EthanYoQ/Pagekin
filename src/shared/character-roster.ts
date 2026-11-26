import { CHARACTER_ROLES, type CharacterRole } from './character-role'
import type { FinalizedSourceIdentity } from './finalized-continuity'

export const CHARACTER_ROSTER_SCHEMA_VERSION = 1 as const

export const CHARACTER_ROSTER_ROLES = CHARACTER_ROLES

export type CharacterRosterRole = CharacterRole

export function characterRosterIdentityKey(name: string): string {
  return name.trim().toLocaleLowerCase('en-US')
}

export type CharacterRosterMigrationState =
  | 'empty'
  | 'legacy_cards_preserved'
  | 'legacy_markdown_pending'
  | 'ready'

export type CharacterRosterStatus =
  | 'empty'
  | 'ready'
  | 'legacy_repair_required'
  | 'inconsistent'

export interface CharacterRosterRelationship {
  targetCharacterId?: string
  target: string
  relation: string
}

export const CHARACTER_STATE_TEXT_FIELDS = [
  'location',
  'powerLevel',
  'physicalState',
  'mentalState',
  'keyItems',
  'recentEvents',
] as const

export type CharacterStateTextField = typeof CHARACTER_STATE_TEXT_FIELDS[number]

export type CharacterStateFieldProvenance =
  | { kind: 'author'; chapterNumber: number }
  | { kind: 'derived'; source: FinalizedSourceIdentity }
  | { kind: 'legacy' }

export interface CharacterRosterCharacterState {
  location: string
  powerLevel: string
  physicalState: string
  mentalState: string
  keyItems: string
  recentEvents: string
  updatedAtChapter: number
  provenance?: Partial<Record<CharacterStateTextField, CharacterStateFieldProvenance>>
}

export interface CharacterRosterEntry {
  characterId?: string
  name: string
  role: CharacterRosterRole
  gender: string
  age: string
  appearance: string
  personality: string
  background: string
  abilities: string
  motivation: string
  relationships: CharacterRosterRelationship[]
  arc: string
  notes: string
  currentState?: CharacterRosterCharacterState
  legacyRelationshipNotes?: string
}

export interface CharacterRosterSnapshot {
  identityRevision?: number
  aliases?: import('./character-proposal').CharacterIdentitySnapshot['aliases']
  schemaVersion: typeof CHARACTER_ROSTER_SCHEMA_VERSION
  revision: number
  migrationState: CharacterRosterMigrationState
  status: CharacterRosterStatus
  entries: CharacterRosterEntry[]
  currentDerivedFields?: Record<string, CharacterStateTextField[]>
  renderedMarkdown: string
  projectionHash: string
  factHash: string
  nameOnlyFactHash: string
  legacyMarkdown?: string
}

export type CharacterRosterCommitIntent = 'manual_edit'

export interface CharacterRosterRename {
  characterId?: string
  originalName: string
  newName: string
}

export interface CharacterRosterCommitRequest {
  expectedIdentityRevision?: number
  generationRunHandle?: import('../services/generation/generation-runtime').MainGenerationRunHandle
  operationId: string
  expectedRevision: number
  schemaVersion: typeof CHARACTER_ROSTER_SCHEMA_VERSION
  entries: CharacterRosterEntry[]
  intent?: CharacterRosterCommitIntent
  source?: FinalizedSourceIdentity
  renames?: CharacterRosterRename[]
  stateEffectiveChapter?: number
}

export interface CharacterRosterCommitReceipt {
  created?: { selectionKey: string; characterId: string }[]
  operationId: string
  payloadHash: string
  revision: number
  idempotent: boolean
  snapshot: CharacterRosterSnapshot
}
