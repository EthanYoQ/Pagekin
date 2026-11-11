import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type BetterSqlite3 from 'better-sqlite3'
import { getProjectDb } from '../database'
import type {
  FinalizedAuthorRelation,
  FinalizedCharacterStateCandidate,
  FinalizedCharacterStateDecisionReceipt,
  FinalizedCharacterStateDecisionRequest,
  FinalizedCharacterContext,
  PendingFinalizedCharacterStateCandidate,
  PendingFinalizedCharacterStateCandidateSummary,
  FinalizedCharacterReference,
  FinalizedCharacterStateResponse,
  FinalizedCharacterStateCommitReceipt,
  FinalizedContinuityFact,
  FinalizedRelationCandidate,
  FinalizedRelationChange,
  FinalizedRelationDecisionRequest,
  PendingFinalizedRelationCandidate,
  FinalizedContinuityProjection,
  FinalizedSourceIdentity,
  FinalizedSourceReadResult,
  FinalizedSourceSnapshot,
  SaveFinalizedCharacterStateCandidatesRequest,
  SaveFinalizedContinuityRequest,
} from '../../src/shared/finalized-continuity'
import {
  CHARACTER_STATE_TEXT_FIELDS,
  characterRosterIdentityKey,
  type CharacterStateTextField,
  type CharacterStateFieldProvenance,
} from '../../src/shared/character-roster'
import { decideDerivedPatch, type CharacterFieldSnapshot, type DerivedSourceOrder } from '../../src/shared/character-identity'
import { latestNodesBefore, type ContinuityNode } from '../../src/shared/character-continuity'
import { parseFinalizedCharacterStateResponse } from '../../src/shared/finalized-continuity'
import { hasCharacterIdentitySchema } from './character-repository'
import { commitCharacterIdentities, refreshCharacterIdentityProjection, refreshCharacterStateProjection } from './character-roster-repository'
import { appendDerivedRelationNode, CHARACTER_STATE_COLUMNS, deleteCharacterRelationship, derivedRelationSeries, readCharacterContinuityNodes, readContinuityNodesWithCurrentNames, readDerivedRelationAuthorLines, writeCharacterStateField } from './character-continuity-repository'
import type { ProjectEpoch } from '../../src/shared/source-ref'
import { RECEIPTED_DRAFT_STATUS_SQL } from '../../src/shared/draft-status'

const FACT_CATEGORIES = new Set(['character-state', 'timeline', 'open-thread', 'plot'])
const CHARACTER_STATE_FIELDS = new Set<string>(CHARACTER_STATE_TEXT_FIELDS)
const FINALIZED_CHARACTER_SNAPSHOT_KIND = 'finalized-character-snapshot:v1'
interface FinalizedCharacterSnapshot {
  kind: typeof FINALIZED_CHARACTER_SNAPSHOT_KIND
  source: FinalizedSourceIdentity
  identityRevision: number
  characters: Array<FinalizedCharacterReference & { aliases: string[] }>
}
/** A read-only identity receipt, atomically indexed alongside the immutable outbox. */
export function freezeFinalizedCharacterSnapshot(db: BetterSqlite3.Database, source: FinalizedSourceIdentity): void {
  if (!db.inTransaction) throw new Error('FINALIZED_CHARACTER_TRANSACTION_REQUIRED')
  if (!hasCharacterIdentitySchema(db)) return
  const identityRevision = db.prepare("SELECT revision FROM character_identity_meta WHERE id='main'").pluck().get() as number
  const characters = (db.prepare('SELECT character_id,name FROM characters WHERE retired=0 ORDER BY character_id').all() as { character_id: string; name: string }[])
    .map(row => ({ characterId: row.character_id, displayNameSnapshot: row.name,
      aliases: (db.prepare('SELECT DISTINCT name FROM character_aliases WHERE character_id=? AND valid_from<=? AND (valid_through IS NULL OR valid_through>=?) ORDER BY name')
        .all(row.character_id, identityRevision, identityRevision) as { name: string }[]).map(alias => alias.name) }))
  const snapshot: FinalizedCharacterSnapshot = { kind: FINALIZED_CHARACTER_SNAPSHOT_KIND, source: structuredClone(source), identityRevision, characters }
  const raw = JSON.stringify(snapshot)
  db.prepare('INSERT INTO character_identity_proposals(proposal_id,source_key,source_hash,raw_value,candidate_ids_json) VALUES(?,?,?,?,?)')
    .run(`fcs:${source.finalizationId}`, FINALIZED_CHARACTER_SNAPSHOT_KIND, sha256(raw), raw, '[]')
}
function readFrozenCharacterSnapshot(db: BetterSqlite3.Database, source: FinalizedSourceIdentity): FinalizedCharacterSnapshot | null {
  if (!hasCharacterIdentitySchema(db)) return null
  const row = db.prepare('SELECT source_key,source_hash,raw_value FROM character_identity_proposals WHERE proposal_id=?').get(`fcs:${source.finalizationId}`) as {
    source_key: string; source_hash: string; raw_value: string
  } | undefined
  if (!row) return null
  const snapshot = JSON.parse(row.raw_value) as FinalizedCharacterSnapshot
  if (row.source_key !== FINALIZED_CHARACTER_SNAPSHOT_KIND || sha256(row.raw_value) !== row.source_hash
    || snapshot.kind !== FINALIZED_CHARACTER_SNAPSHOT_KIND || !sameSource(snapshot.source, source)
    || !Number.isSafeInteger(snapshot.identityRevision) || snapshot.identityRevision < 0 || !Array.isArray(snapshot.characters)
    || new Set(snapshot.characters.map(item => item.characterId)).size !== snapshot.characters.length
    || snapshot.characters.some(item => !item.characterId || typeof item.displayNameSnapshot !== 'string' || !Array.isArray(item.aliases)
      || item.aliases.some(alias => typeof alias !== 'string'))) throw new Error('FINALIZED_CHARACTER_SNAPSHOT_INVALID')
  return snapshot
}
function stateSnapshot(row: Record<string, unknown>, field: CharacterStateTextField, scope: ProjectEpoch): CharacterFieldSnapshot {
  const provenance = JSON.parse(String(row.cs_provenance || '{}')) as Record<string, CharacterStateFieldProvenance & { revision?: number; sourceOrder?: DerivedSourceOrder }>
  const stored = provenance[field]
  const fieldProvenance: CharacterStateFieldProvenance = stored?.kind === 'derived' ? { kind: 'derived', source: structuredClone(stored.source) }
    : stored?.kind === 'author' ? { kind: 'author', chapterNumber: stored.chapterNumber } : { kind: 'legacy' }
  const revision = stored?.revision ?? 0
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('FINALIZED_CHARACTER_FIELD_REVISION_INVALID')
  const value = String(row[CHARACTER_STATE_COLUMNS[field]] ?? '')
  return { projectId: scope.projectId, epoch: scope.epoch, characterId: row.character_id as string, field, revision, value, valueHash: sha256(value), provenance: fieldProvenance,
    ...(stored?.sourceOrder ? { sourceOrder: structuredClone(stored.sourceOrder) } : {}) }
}

function normalizedFacts(value: unknown, chapterNumber: number): FinalizedContinuityFact[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error('CONTINUITY_FACTS_INVALID')
  return value.map((input) => {
    if (!input || typeof input !== 'object') throw new Error('CONTINUITY_FACTS_INVALID')
    const fact = input as Record<string, unknown>
    const entities = Array.isArray(fact.entities)
      ? fact.entities.map(entity => typeof entity === 'string' ? entity.trim() : '')
      : []
    const statement = typeof fact.statement === 'string' ? fact.statement.trim() : ''
    const evidence = typeof fact.evidence === 'string' ? fact.evidence.trim() : ''
    if (
      !FACT_CATEGORIES.has(String(fact.category))
      || fact.sourceChapter !== chapterNumber
      || entities.length > 8
      || entities.some(entity => !entity || entity.length > 80)
      || !statement
      || !evidence
    ) throw new Error('CONTINUITY_FACTS_INVALID')
    return {
      category: fact.category as FinalizedContinuityFact['category'],
      entities: [...new Set(entities)],
      statement,
      sourceChapter: chapterNumber,
      evidence,
      ...(Array.isArray(fact.characterRefs) ? { characterRefs: fact.characterRefs.map(value => {
        const ref = value as FinalizedCharacterReference
        if (!ref || typeof ref.characterId !== 'string' || !ref.characterId.trim() || typeof ref.displayNameSnapshot !== 'string'
          || !entities.includes(ref.displayNameSnapshot)) throw new Error('CONTINUITY_CHARACTER_REF_INVALID')
        return { characterId: ref.characterId, displayNameSnapshot: ref.displayNameSnapshot }
      }) } : {}),
    }
  })
}

function parseFacts(value: string, chapterNumber: number): FinalizedContinuityFact[] {
  try {
    return normalizedFacts(JSON.parse(value) as unknown, chapterNumber)
  } catch {
    return []
  }
}

function parseCharacterStateCandidates(value: string): FinalizedCharacterStateCandidate[] {
  try {
    const parsed = JSON.parse(value) as unknown
    const pending = Array.isArray(parsed) ? parsed
      : parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).version === 2
        && Array.isArray((parsed as Record<string, unknown>).pending)
        ? (parsed as { pending: unknown[] }).pending : []
    return pending.flatMap((input) => {
      if (!input || typeof input !== 'object') return []
      const candidate = input as Record<string, unknown>
      const boundKeys = ['candidateKey', 'source', 'expectedFieldRevision', 'expectedFieldValueHash']
      const hasBoundMetadata = boundKeys.some(key => Object.prototype.hasOwnProperty.call(candidate, key))
      const hasValidBoundMetadata = typeof candidate.candidateKey === 'string' && Boolean(candidate.candidateKey)
        && isFinalizedSource(candidate.source)
        && Number.isSafeInteger(candidate.expectedFieldRevision) && (candidate.expectedFieldRevision as number) >= 0
        && typeof candidate.expectedFieldValueHash === 'string' && /^[a-f0-9]{64}$/u.test(candidate.expectedFieldValueHash)
      if (hasBoundMetadata && !hasValidBoundMetadata) return []
      return typeof candidate.characterName === 'string'
        && Boolean(candidate.characterName.trim())
        && CHARACTER_STATE_FIELDS.has(String(candidate.field))
        && typeof candidate.value === 'string'
        ? [{
            ...(typeof candidate.characterId === 'string' && candidate.characterId ? { characterId: candidate.characterId } : {}),
            characterName: candidate.characterName.trim(),
            field: candidate.field as CharacterStateTextField,
            value: isFinalizedSource(candidate.source) ? candidate.value : candidate.value.trim(),
            ...(candidate.evidence ? { evidence: candidate.evidence as FinalizedCharacterStateCandidate['evidence'] } : {}),
            ...(typeof candidate.selectionKey === 'string' ? { selectionKey: candidate.selectionKey } : {}),
            ...(typeof candidate.displayName === 'string' ? { displayName: candidate.displayName } : {}),
            ...(candidate.rawValue !== undefined ? { rawValue: structuredClone(candidate.rawValue) } : {}),
            ...(candidate.reason === 'author-protected' || candidate.reason === 'legacy-protected' ? { reason: candidate.reason } : {}),
            ...(typeof candidate.candidateKey === 'string' ? { candidateKey: candidate.candidateKey } : {}),
            ...(isFinalizedSource(candidate.source) ? { source: structuredClone(candidate.source) } : {}),
            ...(Number.isSafeInteger(candidate.expectedFieldRevision) && (candidate.expectedFieldRevision as number) >= 0
              ? { expectedFieldRevision: candidate.expectedFieldRevision as number } : {}),
            ...(typeof candidate.expectedFieldValueHash === 'string' ? { expectedFieldValueHash: candidate.expectedFieldValueHash } : {}),
          }]
        : []
    })
  } catch {
    return []
  }
}

type StoredCharacterStateDecision = Omit<FinalizedCharacterStateDecisionReceipt, 'idempotent'>
interface CharacterStateCandidateStore {
  version: 2
  pending: FinalizedCharacterStateCandidate[]
  /** 旧版本写的行没有这个键，读出来是空数组。 */
  relationPending: FinalizedRelationCandidate[]
  receipts: StoredCharacterStateDecision[]
}

function isRelationCandidate(value: unknown): value is FinalizedRelationCandidate {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return ['candidateKey', 'sourceId', 'sourceName', 'targetId', 'targetName', 'value'].every(key => typeof candidate[key] === 'string' && candidate[key])
    && isFinalizedSource(candidate.source) && !!candidate.evidence && typeof candidate.evidence === 'object'
}

function parseCharacterStateCandidateStore(value: string): CharacterStateCandidateStore {
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) return { version: 2, pending: parseCharacterStateCandidates(value), relationPending: [], receipts: [] }
    if (!parsed || typeof parsed !== 'object' || (parsed as Record<string, unknown>).version !== 2
      || !Array.isArray((parsed as Record<string, unknown>).pending)
      || !Array.isArray((parsed as Record<string, unknown>).receipts)) return { version: 2, pending: [], relationPending: [], receipts: [] }
    const pending = parseCharacterStateCandidates(value)
    const storedRelations = (parsed as Record<string, unknown>).relationPending
    const relationPending = Array.isArray(storedRelations) ? storedRelations.filter(isRelationCandidate) : []
    const receipts = (parsed as { receipts: unknown[] }).receipts.flatMap(input => {
      if (!input || typeof input !== 'object') return []
      const receipt = input as Record<string, unknown>
      return typeof receipt.candidateKey === 'string' && receipt.candidateKey
        && typeof receipt.operationId === 'string' && receipt.operationId
        && typeof receipt.payloadHash === 'string' && /^[a-f0-9]{64}$/u.test(receipt.payloadHash)
        && (receipt.decision === 'accept' || receipt.decision === 'decline')
        && isFinalizedSource(receipt.source)
        ? [{ candidateKey: receipt.candidateKey, operationId: receipt.operationId, payloadHash: receipt.payloadHash,
            decision: receipt.decision as StoredCharacterStateDecision['decision'], source: structuredClone(receipt.source) }]
        : []
    })
    return { version: 2, pending, relationPending, receipts }
  } catch {
    return { version: 2, pending: [], relationPending: [], receipts: [] }
  }
}

function isFinalizedSource(value: unknown): value is FinalizedSourceIdentity {
  if (!value || typeof value !== 'object') return false
  const source = value as Record<string, unknown>
  return Number.isSafeInteger(source.draftId) && (source.draftId as number) > 0
    && Number.isSafeInteger(source.chapterNumber) && (source.chapterNumber as number) > 0
    && typeof source.finalizationId === 'string' && Boolean(source.finalizationId)
    && typeof source.contentHash === 'string' && /^[a-f0-9]{64}$/u.test(source.contentHash)
}

function normalizeCharacterStateCandidates(
  db: BetterSqlite3.Database,
  value: unknown,
  source?: FinalizedSourceIdentity,
): FinalizedCharacterStateCandidate[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error('CONTINUITY_CHARACTER_STATE_CANDIDATES_INVALID')
  if (hasCharacterIdentitySchema(db)) {
    const frozen = source && readFrozenCharacterSnapshot(db, source)
    if (!frozen) throw new Error('FINALIZED_CHARACTER_SNAPSHOT_REQUIRED')
    return value.map((candidate: FinalizedCharacterStateCandidate) => {
      const character = frozen.characters.find(item => item.characterId === candidate.characterId)
      if (!character || candidate.characterName !== character.displayNameSnapshot || !CHARACTER_STATE_FIELDS.has(candidate.field)
        || typeof candidate.value !== 'string'
        || frozen.characters.filter(item => item.displayNameSnapshot === character.displayNameSnapshot).length !== 1) throw new Error('FINALIZED_CHARACTER_IDENTITY_REQUIRED')
      const evidence = candidate.evidence
      const snapshot = readFinalizedSourceFromDb(db, source!.draftId)
      if (!evidence || !snapshot || !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end)
        || evidence.start < 0 || evidence.end <= evidence.start || evidence.end > snapshot.content.length
        || snapshot.content.slice(evidence.start, evidence.end) !== evidence.text) throw new Error('FINALIZED_CHARACTER_EVIDENCE_INVALID')
      if (!db.prepare('SELECT 1 FROM characters WHERE character_id=? AND retired=0').get(character.characterId)) throw new Error('FINALIZED_CHARACTER_ID_RETIRED')
      return structuredClone(candidate)
    })
  }
  const byIdentity = new Map<string, string>()
  for (const { name } of db.prepare('SELECT name FROM characters').all() as Array<{ name: string }>) {
    const identity = characterRosterIdentityKey(name)
    if (!identity || byIdentity.has(identity)) throw new Error('CONTINUITY_ROSTER_NAME_CONFLICT')
    byIdentity.set(identity, name)
  }
  const normalized = new Map<string, FinalizedCharacterStateCandidate>()
  for (const input of value as FinalizedCharacterStateCandidate[]) {
    if (!input || typeof input !== 'object') throw new Error('CONTINUITY_CHARACTER_STATE_CANDIDATES_INVALID')
    const characterName = typeof input.characterName === 'string' ? input.characterName.trim() : ''
    const storedName = byIdentity.get(characterRosterIdentityKey(characterName))
    if (!storedName || !CHARACTER_STATE_FIELDS.has(String(input.field)) || typeof input.value !== 'string') {
      throw new Error('CONTINUITY_CHARACTER_STATE_CANDIDATES_INVALID')
    }
    const candidate = {
      characterName: storedName,
      field: input.field as CharacterStateTextField,
      value: input.value.trim(),
    }
    normalized.set(`${characterRosterIdentityKey(candidate.characterName)}\u0000${candidate.field}`, candidate)
  }
  return [...normalized.values()]
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sameSource(left: FinalizedSourceIdentity, right: FinalizedSourceIdentity): boolean {
  return left.draftId === right.draftId
    && left.finalizationId === right.finalizationId
    && left.chapterNumber === right.chapterNumber
    && left.contentHash === right.contentHash
}

function characterStateCandidateKey(source: FinalizedSourceIdentity, characterId: string, field: CharacterStateTextField, value: string): string {
  return `fcs-state:${sha256(JSON.stringify([source.draftId, source.finalizationId, source.contentHash, characterId, field, sha256(value)]))}`
}

function readFinalizedSourceFromDb(
  db: BetterSqlite3.Database,
  draftId: number,
): FinalizedSourceSnapshot | null {
  const row = db.prepare(`
    SELECT drafts.id AS draftId, drafts.chapter_number AS chapterNumber, drafts.status,
           contents.body AS content, finalization_outbox.finalization_id AS finalizationId,
           finalization_outbox.chapter_title AS chapterTitle,
           finalization_outbox.content_hash AS contentHash,
           finalization_outbox.content_snapshot AS contentSnapshot,
           continuity_projection_meta.generation AS projectionGeneration
    FROM drafts
    JOIN contents ON contents.id = drafts.content_id
    JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
    JOIN continuity_projection_meta ON continuity_projection_meta.id = 'main'
    WHERE drafts.id = ?
  `).get(draftId) as {
    draftId: number
    chapterNumber: number
    status: string
    content: string
    finalizationId: string
    chapterTitle: string
    contentHash: string
    contentSnapshot: string
    projectionGeneration: number
  } | undefined
  if (
    !row
    || row.status !== 'finalized'
    || !row.finalizationId.trim()
    || !/^[a-f0-9]{64}$/u.test(row.contentHash)
    || row.content !== row.contentSnapshot
    || sha256(row.contentSnapshot) !== row.contentHash
  ) return null
  return {
    source: {
      draftId: row.draftId,
      finalizationId: row.finalizationId,
      chapterNumber: row.chapterNumber,
      contentHash: row.contentHash,
    },
    chapterTitle: row.chapterTitle,
    content: row.contentSnapshot,
    projectionGeneration: row.projectionGeneration,
  }
}

function isAuthoritativeSource(db: BetterSqlite3.Database, source: FinalizedSourceIdentity): boolean {
  const current = readFinalizedSourceFromDb(db, source.draftId)
  return current !== null && sameSource(current.source, source)
}

interface CharacterStateCandidateRow {
  id: number
  draftId: number
  chapterNumber: number
  candidates: string
  finalizationId: string
  contentHash: string
  projectionGeneration: number
}

function readCurrentCharacterStateCandidateRow(db: BetterSqlite3.Database, draftId: number): CharacterStateCandidateRow {
  const row = db.prepare(`SELECT id,draft_id AS draftId,chapter_number AS chapterNumber,
    character_state_candidates AS candidates,source_finalization_id AS finalizationId,
    source_content_hash AS contentHash,projection_generation AS projectionGeneration
    FROM summary_snapshots WHERE draft_id=?`).get(draftId) as CharacterStateCandidateRow | undefined
  const snapshot = readFinalizedSourceFromDb(db, draftId)
  const source = row && { draftId: row.draftId, finalizationId: row.finalizationId,
    chapterNumber: row.chapterNumber, contentHash: row.contentHash }
  const latest = snapshot && db.prepare("SELECT id FROM drafts WHERE chapter_number=? AND status='finalized' ORDER BY version DESC,id DESC LIMIT 1")
    .pluck().get(snapshot.source.chapterNumber) as number | undefined
  const staleFromChapter = db.prepare("SELECT stale_from_chapter FROM continuity_projection_meta WHERE id='main'").pluck().get() as number | null
  if (!row || !snapshot || !source || !sameSource(source, snapshot.source)
    || row.projectionGeneration > snapshot.projectionGeneration
    || row.projectionGeneration < snapshot.projectionGeneration && staleFromChapter !== null && row.chapterNumber >= staleFromChapter
    || latest !== draftId) {
    throw new Error('FINALIZED_CHARACTER_STATE_SOURCE_CHANGED')
  }
  return row
}

function pendingCharacterStateCandidate(db: BetterSqlite3.Database, row: CharacterStateCandidateRow,
  candidate: FinalizedCharacterStateCandidate): PendingFinalizedCharacterStateCandidate | null {
  const source = { draftId: row.draftId, finalizationId: row.finalizationId,
    chapterNumber: row.chapterNumber, contentHash: row.contentHash }
  if (!candidate.characterId) return null
  const expectedKey = characterStateCandidateKey(source, candidate.characterId, candidate.field, candidate.value)
  const hasBoundMetadata = candidate.candidateKey !== undefined || candidate.source !== undefined
    || candidate.expectedFieldRevision !== undefined || candidate.expectedFieldValueHash !== undefined
  if (hasBoundMetadata && (!candidate.candidateKey || !candidate.source || !sameSource(candidate.source, source)
    || !Number.isSafeInteger(candidate.expectedFieldRevision) || candidate.expectedFieldRevision! < 0
    || !candidate.expectedFieldValueHash || !/^[a-f0-9]{64}$/u.test(candidate.expectedFieldValueHash)
    || candidate.candidateKey !== expectedKey)) return null
  const frozen = readFrozenCharacterSnapshot(db, source)
  if (!frozen || !frozen.characters.some(character => character.characterId === candidate.characterId
    && character.displayNameSnapshot === candidate.characterName)) return null
  if (hasBoundMetadata) return structuredClone(candidate) as PendingFinalizedCharacterStateCandidate
  const character = db.prepare('SELECT * FROM characters WHERE character_id=? AND retired=0').get(candidate.characterId) as Record<string, unknown> | undefined
  if (!character) return null
  const current = stateSnapshot(character, candidate.field, { projectId: 'candidate-upgrade', epoch: 'candidate-upgrade' })
  return { ...structuredClone(candidate), candidateKey: expectedKey, source, expectedFieldRevision: current.revision,
    expectedFieldValueHash: current.valueHash } as PendingFinalizedCharacterStateCandidate
}

interface AuthorRelationRow { relationshipId: string; relation: string; sourceName: string; targetName: string }

function authorRelationRows(db: BetterSqlite3.Database, sourceId: string, targetId: string): AuthorRelationRow[] {
  return db.prepare(`SELECT r.relationship_id AS relationshipId,r.relation,a.name AS sourceName,b.name AS targetName FROM character_relationships r
    JOIN characters a ON a.character_id=r.source_character_id JOIN characters b ON b.character_id=r.target_character_id
    WHERE r.source_character_id=? AND r.target_character_id=? AND a.retired=0 AND b.retired=0 ORDER BY r.relationship_id`).all(sourceId, targetId) as AuthorRelationRow[]
}

/** 比对不分方向。作者只写了反向时以作者写的方向为准，节点、待确认项和采用都落在那一边，时间线才能合成一行。 */
function authorRelationsOfPair(db: BetterSqlite3.Database, sourceId: string, targetId: string) {
  const forward = authorRelationRows(db, sourceId, targetId), backward = authorRelationRows(db, targetId, sourceId)
  const flipped = !forward.length && backward.length > 0
  const lines = [...forward.map(row => JSON.stringify([sourceId, targetId, row.relation])), ...backward.map(row => JSON.stringify([targetId, sourceId, row.relation]))].sort()
  return { sourceId: flipped ? targetId : sourceId, targetId: flipped ? sourceId : targetId, rows: flipped ? backward : forward,
    all: [...forward, ...backward].map(row => row.relation), lines }
}

const unorderedPairKey = (left: string, right: string) => JSON.stringify([left, right].sort())

function relationCandidateKey(source: FinalizedSourceIdentity, change: Pick<FinalizedRelationChange, 'sourceId' | 'targetId' | 'relation'>): string {
  return `fcs-relation:${sha256(JSON.stringify([source.draftId, source.finalizationId, source.contentHash, unorderedPairKey(change.sourceId, change.targetId), sha256(change.relation)]))}`
}

function candidateRowOf(db: BetterSqlite3.Database, source: FinalizedSourceIdentity, projectionGeneration: number) {
  return db.prepare(`SELECT id,character_state_candidates AS candidates FROM summary_snapshots
    WHERE draft_id=? AND source_finalization_id=? AND source_content_hash=? AND projection_generation=?`)
    .get(source.draftId, source.finalizationId, source.contentHash, projectionGeneration) as { id: number; candidates: string } | undefined
}

/** 同一份定稿重跑时节点已在，这里仍要补上待确认项：上一次可能因为要点那步失败而没地方存。 */
function commitDerivedRelations(db: BetterSqlite3.Database, context: FinalizedCharacterContext, changes: readonly FinalizedRelationChange[]): void {
  const { source } = context
  const name = (id: string) => context.characters.find(character => character.characterId === id)!.displayNameSnapshot
  const candidates: FinalizedRelationCandidate[] = []
  for (const reported of changes) {
    const pair = authorRelationsOfPair(db, reported.sourceId, reported.targetId)
    const change = { ...reported, sourceId: pair.sourceId, targetId: pair.targetId }
    const series = derivedRelationSeries(change.sourceId, change.targetId)
    const previous = latestNodesBefore(readCharacterContinuityNodes(db, change.sourceId), source.chapterNumber + 1).relations
      .flatMap(pair => pair.lines).find(line => line.relationshipId === series)
    const unchanged = previous?.value === change.relation
    const matchesAuthor = pair.all.includes(change.relation)
    if (matchesAuthor && (!previous || unchanged)) continue
    if (unchanged && !(previous.provenance.kind === 'derived' && previous.provenance.source.finalizationId === source.finalizationId)) continue
    const names = { sourceName: name(change.sourceId), targetName: name(change.targetId) }
    const authorLinesAtExtraction = context.authorRelations?.filter(line => unorderedPairKey(line.sourceId, line.targetId) === unorderedPairKey(change.sourceId, change.targetId))
      .map(line => JSON.stringify([line.sourceId, line.targetId, line.relation])).sort()
    if (!unchanged) appendDerivedRelationNode(db, { ...change, ...names, source, quote: change.evidence, authorLinesAtExtraction })
    if (pair.rows.length && !matchesAuthor) candidates.push({ candidateKey: relationCandidateKey(source, change), source: structuredClone(source), sourceId: change.sourceId, targetId: change.targetId,
      ...names, value: change.relation, evidence: change.evidence, authorLinesAtCreation: pair.lines })
  }
  if (!changes.length) return
  const row = candidateRowOf(db, source, context.projectionGeneration)
  if (!row) return
  const store = parseCharacterStateCandidateStore(row.candidates)
  const decided = new Set(store.receipts.map(receipt => receipt.candidateKey))
  const stored = new Map(store.relationPending.map(candidate => [candidate.candidateKey, candidate]))
  const byPair = new Map(store.relationPending.map(candidate => [unorderedPairKey(candidate.sourceId, candidate.targetId), candidate]))
  for (const change of changes) byPair.delete(unorderedPairKey(change.sourceId, change.targetId))
  // 重跑同一份定稿时沿用当初的作者行快照，否则作者后改作废的建议会复活。
  for (const candidate of candidates) if (!decided.has(candidate.candidateKey)) byPair.set(unorderedPairKey(candidate.sourceId, candidate.targetId), stored.get(candidate.candidateKey) ?? candidate)
  if (isDeepStrictEqual([...byPair.values()], store.relationPending)) return
  store.relationPending = [...byPair.values()]
  db.prepare("UPDATE summary_snapshots_all SET character_state_candidates=?,created_at=datetime('now') WHERE id=?").run(JSON.stringify(store), row.id)
}

/** 角色那步先于要点提交时，快照还不存在，待确认项补在这里；已有行不能重建，否则作者处理过的建议会复活。 */
function restoreDerivedRelationCandidates(db: BetterSqlite3.Database, source: FinalizedSourceIdentity, projectionGeneration: number): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='character_continuity_events'").get()) return
  const row = candidateRowOf(db, source, projectionGeneration)
  if (!row) return
  const store = parseCharacterStateCandidateStore(row.candidates)
  const known = new Set([...store.relationPending, ...store.receipts].map(item => item.candidateKey))
  const nodes = latestNodesBefore(readCharacterContinuityNodes(db), source.chapterNumber + 1).relations.flatMap(pair => pair.lines)
    .filter(node => node.provenance.kind === 'derived' && node.provenance.source.finalizationId === source.finalizationId && node.quote)
  let added = false
  for (const node of nodes) {
    const authorLines = readDerivedRelationAuthorLines(db, node.eventId)
    if (!authorLines?.length || authorLines.some(line => (JSON.parse(line) as string[])[2] === node.value)) continue
    const ids = { sourceId: node.subjectId, targetId: node.targetId }
    const candidateKey = relationCandidateKey(source, { ...ids, relation: node.value })
    if (known.has(candidateKey)) continue
    known.add(candidateKey)
    store.relationPending.push({ candidateKey, source: structuredClone(source), ...ids, sourceName: node.subjectName, targetName: node.targetName,
      value: node.value, evidence: node.quote!, authorLinesAtCreation: authorLines })
    added = true
  }
  if (added) db.prepare("UPDATE summary_snapshots_all SET character_state_candidates=?,created_at=datetime('now') WHERE id=?").run(JSON.stringify(store), row.id)
}

function candidateReceipts(db: BetterSqlite3.Database): StoredCharacterStateDecision[] {
  return (db.prepare("SELECT character_state_candidates AS candidates FROM summary_snapshots WHERE character_state_candidates<>'[]'").all() as Array<{ candidates: string }>)
    .flatMap(item => parseCharacterStateCandidateStore(item.candidates).receipts)
}

function markDeclinedRelations(db: BetterSqlite3.Database, nodes: ContinuityNode[]): ContinuityNode[] {
  const declined = new Set(candidateReceipts(db).filter(receipt => receipt.decision === 'decline').map(receipt => receipt.candidateKey))
  return nodes.map(node => node.aspect === 'relation' && node.provenance.kind === 'derived'
    && declined.has(relationCandidateKey(node.provenance.source, { sourceId: node.subjectId, targetId: node.targetId, relation: node.value }))
    ? { ...node, authorDeclined: true as const } : node)
}

function relationDecisionPayloadHash(request: FinalizedRelationDecisionRequest): string {
  return sha256(JSON.stringify([request.draftId, request.candidateKey, request.expectedAuthorRelations, request.operationId, request.decision]))
}

function pendingRelationCandidate(db: BetterSqlite3.Database, candidate: FinalizedRelationCandidate): PendingFinalizedRelationCandidate | null {
  const pair = authorRelationsOfPair(db, candidate.sourceId, candidate.targetId)
  if (!pair.rows.length || pair.all.includes(candidate.value)) return null
  if (candidate.authorLinesAtCreation && !isDeepStrictEqual(candidate.authorLinesAtCreation, pair.lines)) return null
  const [{ sourceName, targetName }] = pair.rows
  const currentNames = pair.sourceId === candidate.sourceId ? { sourceName, targetName } : { sourceName: targetName, targetName: sourceName }
  return { ...structuredClone(candidate), ...currentNames, authorRelations: pair.rows.map(row => row.relation) }
}

/** 采用只是对这一条建议的决定。较晚章的建议换成采用后的作者行，否则会被当成作者后改而作废。 */
function carryLaterRelationCandidates(db: BetterSqlite3.Database, adopted: FinalizedRelationCandidate, before: string[], after: string[]): void {
  const pair = unorderedPairKey(adopted.sourceId, adopted.targetId)
  const rows = db.prepare("SELECT id,character_state_candidates AS candidates FROM summary_snapshots WHERE chapter_number>? AND character_state_candidates<>'[]'")
    .all(adopted.source.chapterNumber) as Array<{ id: number; candidates: string }>
  for (const row of rows) {
    const store = parseCharacterStateCandidateStore(row.candidates)
    const later = store.relationPending.filter(item => unorderedPairKey(item.sourceId, item.targetId) === pair && isDeepStrictEqual(item.authorLinesAtCreation, before))
    if (!later.length) continue
    for (const item of later) item.authorLinesAtCreation = after
    db.prepare("UPDATE summary_snapshots_all SET character_state_candidates=?,created_at=datetime('now') WHERE id=?").run(JSON.stringify(store), row.id)
  }
}

function adoptRelationCandidate(db: BetterSqlite3.Database, candidate: FinalizedRelationCandidate, operationId: string, scope: ProjectEpoch): void {
  const chapter = candidate.source.chapterNumber
  const { sourceId, targetId, rows, lines: before } = authorRelationsOfPair(db, candidate.sourceId, candidate.targetId)
  for (const row of rows) deleteCharacterRelationship(db, { relationshipId: row.relationshipId, sourceId, sourceName: row.sourceName, targetId, targetName: row.targetName }, operationId, chapter)
  const revision = db.prepare("SELECT revision FROM character_identity_meta WHERE id='main'").pluck().get() as number
  commitCharacterIdentities(db, { approval: { operationId, expectedRevision: revision, action: 'author-edit',
    source: { kind: 'author', source: { projectId: scope.projectId, epoch: scope.epoch, sourceId: candidate.candidateKey, revision, contentHash: candidate.source.contentHash } } },
  changes: [], creations: [], retireIds: [], resolutions: [],
  relationships: [{ sourceCharacterId: sourceId, targetCharacterId: targetId, relation: candidate.value, effectiveChapter: chapter }] }, () => true)
  refreshCharacterIdentityProjection(db)
  carryLaterRelationCandidates(db, candidate, before, authorRelationsOfPair(db, sourceId, targetId).lines)
}

function stateDecisionPayloadHash(request: FinalizedCharacterStateDecisionRequest): string {
  return sha256(JSON.stringify([request.draftId, request.candidateKey, request.characterId, request.field,
    request.expectedFieldRevision, request.expectedFieldValueHash, request.operationId, request.decision]))
}

export function invalidateContinuityProjectionFrom(
  db: BetterSqlite3.Database,
  chapterNumber: number,
): void {
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
    throw new Error('CONTINUITY_INVALIDATION_CHAPTER_INVALID')
  }
  db.prepare(`
    UPDATE continuity_projection_meta
    SET generation = generation + 1,
        stale_from_chapter = CASE
          WHEN stale_from_chapter IS NULL OR stale_from_chapter > ? THEN ?
          ELSE stale_from_chapter
        END
    WHERE id = 'main'
  `).run(chapterNumber, chapterNumber)
}

export class SummaryRepository {
  static readFinalizedCharacterContext(draftId: number, scope: ProjectEpoch, database = getProjectDb()): FinalizedCharacterContext {
    if (!database || !scope.projectId?.trim() || !scope.epoch?.trim()) throw new Error('FINALIZED_CHARACTER_SCOPE_REQUIRED')
    const db = database
    return db.transaction(() => {
      const source = readFinalizedSourceFromDb(db, draftId)
      if (!source) throw new Error('FINALIZED_CHARACTER_SOURCE_CHANGED')
      const latest = db.prepare("SELECT id,version FROM drafts WHERE chapter_number=? AND status='finalized' ORDER BY version DESC,id DESC LIMIT 1")
        .get(source.source.chapterNumber) as { id: number; version: number } | undefined
      if (!latest || latest.id !== draftId) throw new Error('FINALIZED_CHARACTER_SOURCE_CHANGED')
      const frozen = readFrozenCharacterSnapshot(db, source.source)
      const characters = (frozen?.characters ?? []).map(character => {
        const row = db.prepare('SELECT * FROM characters WHERE character_id=? AND retired=0').get(character.characterId) as Record<string, unknown> | undefined
        if (!row) throw new Error('FINALIZED_CHARACTER_ID_RETIRED')
        return { ...structuredClone(character), fields: CHARACTER_STATE_TEXT_FIELDS.map(field => stateSnapshot(row, field, scope)) }
      })
      const known = new Set(characters.map(character => character.characterId))
      const authorRelations = frozen ? (db.prepare(`SELECT r.source_character_id AS sourceId,r.target_character_id AS targetId,c.name AS targetName,r.relation
        FROM character_relationships r JOIN characters c ON c.character_id=r.target_character_id WHERE c.retired=0 ORDER BY r.relationship_id`).all() as FinalizedAuthorRelation[])
        .filter(relation => known.has(relation.sourceId) && known.has(relation.targetId)) : []
      return { projectId: scope.projectId, epoch: scope.epoch, source: source.source, content: source.content, projectionGeneration: source.projectionGeneration,
        identityRevision: frozen?.identityRevision ?? 0, identityStatus: frozen ? 'bound' as const : 'legacy' as const,
        sourceOrder: { continuityEpoch: `${scope.projectId}:${source.projectionGeneration}`, chapterNumber: source.source.chapterNumber,
          authoritativeFinalizationRevision: latest.version }, characters, authorRelations }
    })()
  }

  /** originProjectId must come from readPortableCurrentAuthority for this project; it only lets origin-epoch derived fields advance. */
  static commitFinalizedCharacterStates(context: FinalizedCharacterContext, response: FinalizedCharacterStateResponse, database = getProjectDb(),
    originProjectId?: string): FinalizedCharacterStateCommitReceipt {
    if (!database) throw new Error('PROJECT_NOT_OPEN')
    const db = database
    return db.transaction(() => {
      const current = SummaryRepository.readFinalizedCharacterContext(context.source.draftId, context, db)
      const identity = (value: FinalizedCharacterContext) => ({ source: value.source, content: value.content, projectionGeneration: value.projectionGeneration,
        identityRevision: value.identityRevision, identityStatus: value.identityStatus, sourceOrder: value.sourceOrder,
        characters: value.characters.map(({ fields: _fields, ...character }) => { void _fields; return character }) })
      if (!isDeepStrictEqual(identity(current), identity(context)) || context.characters.some(character => character.fields.some(field =>
        field.characterId !== character.characterId || field.projectId !== context.projectId || field.epoch !== context.epoch))) throw new Error('FINALIZED_CHARACTER_CONTEXT_CHANGED')
      const verified = parseFinalizedCharacterStateResponse(JSON.stringify({ updates: response.updates, relations: response.relations.map(({ sourceId, targetId, ...change }) => ({ ...change, source: sourceId, target: targetId })) }), context)
      if (verified.unresolved.length) throw new Error('FINALIZED_CHARACTER_IDENTITY_REQUIRED')
      const receipt: FinalizedCharacterStateCommitReceipt = { applied: 0, unchanged: 0, candidates: [] }
      for (const update of verified.updates) {
        const captured = context.characters.find(item => item.characterId === update.characterId)!
        const currentCharacter = current.characters.find(item => item.characterId === update.characterId)!
        const row = db.prepare('SELECT cs_provenance FROM characters WHERE character_id=? AND retired=0').get(update.characterId) as { cs_provenance: string }
        const provenance = JSON.parse(row.cs_provenance || '{}') as Record<string, unknown>
        let changed = false
        for (const field of CHARACTER_STATE_TEXT_FIELDS) {
          if (!Object.hasOwn(update.currentState, field)) continue
          const base = captured.fields.find(item => item.field === field), actual = currentCharacter.fields.find(item => item.field === field)!
          if (!base || base.valueHash !== sha256(base.value)) throw new Error('FINALIZED_CHARACTER_CONTEXT_CHANGED')
          const value = update.currentState[field]!
          const decision = decideDerivedPatch(actual, { projectId: context.projectId, epoch: context.epoch, characterId: update.characterId, field, value, valueHash: sha256(value),
            baseFieldRevision: base.revision, baseValueHash: base.valueHash, baseProvenance: base.provenance,
            source: context.source, sourceOrder: context.sourceOrder }, { source: current.source, order: current.sourceOrder, originProjectId,
            laterOwnerAuthoritative: actual.provenance.kind === 'derived' && isAuthoritativeSource(db, actual.provenance.source) })
          if (decision === 'source-conflict') throw new Error('FINALIZED_CHARACTER_SOURCE_CONFLICT')
          if (decision === 'field-conflict') throw new Error('FINALIZED_CHARACTER_FIELD_CONFLICT')
          if (decision === 'already-applied' || decision === 'later-source-owns') { receipt.unchanged++; continue }
          if (decision === 'proposal-required') {
            if (value === actual.value) { receipt.unchanged++; continue }
            receipt.candidates.push({ candidateKey: characterStateCandidateKey(context.source, update.characterId, field, value), source: structuredClone(context.source),
              expectedFieldRevision: actual.revision, expectedFieldValueHash: actual.valueHash,
              characterId: update.characterId, characterName: captured.displayNameSnapshot, displayName: captured.displayNameSnapshot,
              selectionKey: `state:${update.characterId}:${field}`, field, value, evidence: update.evidence, rawValue: structuredClone(update),
              reason: actual.provenance.kind === 'author' ? 'author-protected' : 'legacy-protected' })
            continue
          }
          writeCharacterStateField(db, { characterId: update.characterId, characterName: captured.displayNameSnapshot, field, value,
            origin: { kind: 'derived', source: context.source, quote: update.evidence, fieldRevision: actual.revision + 1 } })
          provenance[field] = { kind: 'derived', source: structuredClone(context.source), revision: actual.revision + 1, sourceOrder: structuredClone(context.sourceOrder) }
          receipt.applied++; changed = true
        }
        if (changed) db.prepare("UPDATE characters SET cs_provenance=?,cs_updated_at_chapter=MAX(COALESCE(cs_updated_at_chapter,0),?),updated_at=datetime('now') WHERE character_id=?")
          .run(JSON.stringify(provenance), context.source.chapterNumber, update.characterId)
      }
      if (receipt.candidates.length) SummaryRepository.saveFinalizedCharacterStateCandidates({ draftId: context.source.draftId, chapterNumber: context.source.chapterNumber,
        projectionGeneration: context.projectionGeneration, source: context.source, candidates: receipt.candidates }, db)
      commitDerivedRelations(db, context, verified.relations)
      if (receipt.applied) refreshCharacterStateProjection(db)
      return receipt
    }).immediate()
  }

  static listPendingFinalizedCharacterStateCandidates(database = getProjectDb()): PendingFinalizedCharacterStateCandidateSummary[] {
    if (!database) return []
    const rows = database.prepare("SELECT draft_id AS draftId FROM summary_snapshots WHERE character_state_candidates<>'[]'")
      .all() as Array<{ draftId: number }>
    return rows.flatMap(({ draftId }) => {
      try {
        const row = readCurrentCharacterStateCandidateRow(database, draftId)
        return parseCharacterStateCandidateStore(row.candidates).pending.flatMap(candidate => {
          const pending = pendingCharacterStateCandidate(database, row, candidate)
          return pending ? [{ draftId, candidateKey: pending.candidateKey, finalizationId: pending.source.finalizationId,
            characterId: pending.characterId, characterName: pending.characterName, field: pending.field }] : []
        })
      } catch {
        return []
      }
    }).sort((left, right) => left.draftId - right.draftId || left.candidateKey.localeCompare(right.candidateKey))
  }

  static listPendingFinalizedRelationCandidates(database = getProjectDb()): PendingFinalizedRelationCandidate[] {
    if (!database) return []
    const rows = database.prepare("SELECT draft_id AS draftId FROM summary_snapshots WHERE character_state_candidates<>'[]' ORDER BY chapter_number,draft_id")
      .all() as Array<{ draftId: number }>
    return rows.flatMap(({ draftId }) => {
      try {
        const row = readCurrentCharacterStateCandidateRow(database, draftId)
        return parseCharacterStateCandidateStore(row.candidates).relationPending.flatMap(candidate => pendingRelationCandidate(database, candidate) ?? [])
      } catch {
        return []
      }
    })
  }

  static readContinuityNodesForWriting(characterIds: readonly string[], db: BetterSqlite3.Database): ContinuityNode[] {
    return markDeclinedRelations(db, characterIds.flatMap(characterId => readCharacterContinuityNodes(db, characterId)))
  }

  static readContinuityNodesForPreflight(db: BetterSqlite3.Database): ContinuityNode[] {
    return markDeclinedRelations(db, readContinuityNodesWithCurrentNames(db))
  }

  static decideFinalizedRelationCandidate(request: FinalizedRelationDecisionRequest, scope: ProjectEpoch, database = getProjectDb()): FinalizedCharacterStateDecisionReceipt {
    if (!database || !request || !Number.isSafeInteger(request.draftId) || request.draftId < 1 || !request.candidateKey?.trim() || !request.operationId?.trim()
      || !Array.isArray(request.expectedAuthorRelations) || request.decision !== 'accept' && request.decision !== 'decline') throw new Error('FINALIZED_CHARACTER_STATE_DECISION_INVALID')
    const db = database
    return db.transaction(() => {
      const payloadHash = relationDecisionPayloadHash(request)
      const replay = candidateReceipts(db).find(receipt => receipt.operationId === request.operationId)
      if (replay) {
        if (replay.payloadHash !== payloadHash) throw new Error('FINALIZED_CHARACTER_STATE_OPERATION_CONFLICT')
        return { ...structuredClone(replay), idempotent: true }
      }
      const row = readCurrentCharacterStateCandidateRow(db, request.draftId)
      const store = parseCharacterStateCandidateStore(row.candidates)
      const candidate = store.relationPending.find(item => item.candidateKey === request.candidateKey)
      const current = candidate && pendingRelationCandidate(db, candidate)
      if (!candidate || !current) throw new Error('FINALIZED_CHARACTER_STATE_CANDIDATE_NOT_FOUND')
      if (!isDeepStrictEqual(current.authorRelations, request.expectedAuthorRelations)) throw new Error('FINALIZED_CHARACTER_STATE_FIELD_CONFLICT')
      if (request.decision === 'accept') adoptRelationCandidate(db, candidate, request.operationId, scope)
      const receipt: StoredCharacterStateDecision = { candidateKey: candidate.candidateKey, operationId: request.operationId, payloadHash, decision: request.decision, source: structuredClone(candidate.source) }
      store.relationPending = store.relationPending.filter(item => item.candidateKey !== candidate.candidateKey)
      store.receipts.push(receipt)
      db.prepare("UPDATE summary_snapshots_all SET character_state_candidates=?,created_at=datetime('now') WHERE id=?").run(JSON.stringify(store), row.id)
      return { ...structuredClone(receipt), idempotent: false }
    }).immediate()
  }

  static readPendingFinalizedCharacterStateCandidate(draftId: number, candidateKey: string,
    database = getProjectDb()): PendingFinalizedCharacterStateCandidate {
    if (!database || !Number.isSafeInteger(draftId) || draftId < 1 || !candidateKey?.trim()) {
      throw new Error('FINALIZED_CHARACTER_STATE_CANDIDATE_INVALID')
    }
    return database.transaction(() => {
      const row = readCurrentCharacterStateCandidateRow(database, draftId)
      const store = parseCharacterStateCandidateStore(row.candidates)
      const index = store.pending.findIndex(item => pendingCharacterStateCandidate(database, row, item)?.candidateKey === candidateKey)
      if (index < 0) throw new Error('FINALIZED_CHARACTER_STATE_CANDIDATE_NOT_FOUND')
      const candidate = pendingCharacterStateCandidate(database, row, store.pending[index])!
      if (!store.pending[index].candidateKey) {
        store.pending[index] = candidate
        database.prepare('UPDATE summary_snapshots_all SET character_state_candidates=?,created_at=datetime(\'now\') WHERE id=?')
          .run(JSON.stringify(store), row.id)
      }
      return candidate
    }).immediate()
  }

  static decideFinalizedCharacterStateCandidate(request: FinalizedCharacterStateDecisionRequest,
    database = getProjectDb()): FinalizedCharacterStateDecisionReceipt {
    if (!database || !request || !Number.isSafeInteger(request.draftId) || request.draftId < 1
      || !request.candidateKey?.trim() || !request.characterId?.trim() || !CHARACTER_STATE_FIELDS.has(request.field)
      || !Number.isSafeInteger(request.expectedFieldRevision) || request.expectedFieldRevision < 0
      || !/^[a-f0-9]{64}$/u.test(request.expectedFieldValueHash) || !request.operationId?.trim()
      || request.decision !== 'accept' && request.decision !== 'decline') {
      throw new Error('FINALIZED_CHARACTER_STATE_DECISION_INVALID')
    }
    const db = database
    return db.transaction(() => {
      const payloadHash = stateDecisionPayloadHash(request)
      const replay = candidateReceipts(db).find(receipt => receipt.operationId === request.operationId)
      if (replay) {
        if (replay.payloadHash !== payloadHash) throw new Error('FINALIZED_CHARACTER_STATE_OPERATION_CONFLICT')
        return { ...structuredClone(replay), idempotent: true }
      }
      const row = readCurrentCharacterStateCandidateRow(db, request.draftId)
      const store = parseCharacterStateCandidateStore(row.candidates)
      const candidate = store.pending.map(item => pendingCharacterStateCandidate(db, row, item))
        .find((item): item is PendingFinalizedCharacterStateCandidate => item?.candidateKey === request.candidateKey)
      if (!candidate || candidate.characterId !== request.characterId || candidate.field !== request.field
        || candidate.expectedFieldRevision !== request.expectedFieldRevision
        || candidate.expectedFieldValueHash !== request.expectedFieldValueHash) {
        throw new Error('FINALIZED_CHARACTER_STATE_CANDIDATE_NOT_FOUND')
      }
      if (request.decision === 'accept') {
        const character = db.prepare('SELECT * FROM characters WHERE character_id=? AND retired=0').get(candidate.characterId) as Record<string, unknown> | undefined
        if (!character) throw new Error('FINALIZED_CHARACTER_STATE_CANDIDATE_NOT_FOUND')
        const current = stateSnapshot(character, candidate.field, { projectId: 'candidate-decision', epoch: 'candidate-decision' })
        if (current.revision !== request.expectedFieldRevision || current.valueHash !== request.expectedFieldValueHash) {
          throw new Error('FINALIZED_CHARACTER_STATE_FIELD_CONFLICT')
        }
        const provenance = JSON.parse(String(character.cs_provenance || '{}')) as Record<string, unknown>
        provenance[candidate.field] = { kind: 'author', chapterNumber: candidate.source.chapterNumber, revision: current.revision + 1 }
        if (!writeCharacterStateField(db, { characterId: candidate.characterId, characterName: String(character.name), field: candidate.field, value: candidate.value,
          origin: { kind: 'adopted', operationId: request.operationId, source: candidate.source, quote: candidate.evidence } })) throw new Error('FINALIZED_CHARACTER_STATE_FIELD_CONFLICT')
        db.prepare(`UPDATE characters SET cs_provenance=?,cs_updated_at_chapter=MAX(COALESCE(cs_updated_at_chapter,0),?),updated_at=datetime('now')
          WHERE character_id=?`).run(JSON.stringify(provenance), candidate.source.chapterNumber, candidate.characterId)
        refreshCharacterStateProjection(db)
      }
      const receipt: StoredCharacterStateDecision = { candidateKey: candidate.candidateKey,
        operationId: request.operationId, payloadHash, decision: request.decision, source: structuredClone(candidate.source) }
      store.pending = store.pending.filter(item => item.candidateKey !== candidate.candidateKey)
      store.receipts.push(receipt)
      db.prepare('UPDATE summary_snapshots_all SET character_state_candidates=?,created_at=datetime(\'now\') WHERE id=?')
        .run(JSON.stringify(store), row.id)
      return { ...structuredClone(receipt), idempotent: false }
    }).immediate()
  }

  static saveFinalizedContinuity(input: SaveFinalizedContinuityRequest, db = getProjectDb()): void {
    if (!db) throw new Error('PROJECT_NOT_OPEN')
    const chapterNotes = input.chapterNotes.trim()
    const normalized = normalizedFacts(input.facts ?? [], input.chapterNumber)
    const facts = JSON.stringify(normalized)
    if (
      !Number.isSafeInteger(input.draftId)
      || input.draftId < 1
      || !Number.isSafeInteger(input.chapterNumber)
      || input.chapterNumber < 1
      || !Number.isSafeInteger(input.projectionGeneration)
      || input.projectionGeneration < 0
      || !chapterNotes
    ) throw new Error('CONTINUITY_PROJECTION_INVALID')

    db.transaction(() => {
      const snapshot = readFinalizedSourceFromDb(db, input.draftId)
      if (!snapshot || !sameSource(snapshot.source, input.source) || input.chapterNumber !== snapshot.source.chapterNumber) {
        throw new Error('CONTINUITY_SOURCE_STALE')
      }
      if (normalized.some(fact => !snapshot.content.includes(fact.evidence))) {
        throw new Error('CONTINUITY_EVIDENCE_NOT_IN_SOURCE')
      }
      if (hasCharacterIdentitySchema(db)) {
        const identities = readFrozenCharacterSnapshot(db, snapshot.source)
        for (const fact of normalized) {
          // Entities also include objects and places. A readable tag is not a
          // character association; only a source-bound characterRef is one.
          if (fact.characterRefs?.some(ref => !identities?.characters.some(character => character.characterId === ref.characterId
            && character.displayNameSnapshot === ref.displayNameSnapshot))) throw new Error('FINALIZED_CHARACTER_IDENTITY_REQUIRED')
          if (fact.entities.some(entity => {
            if (!identities?.characters.some(character => character.displayNameSnapshot === entity)) return false
            const refs = fact.characterRefs?.filter(ref => ref.displayNameSnapshot === entity) ?? []
            return refs.length !== 1 || !identities?.characters.some(character => character.characterId === refs[0].characterId
              && character.displayNameSnapshot === entity)
              || identities.characters.filter(character => character.displayNameSnapshot === entity).length !== 1
          })) throw new Error('FINALIZED_CHARACTER_IDENTITY_REQUIRED')
        }
      }
      const generation = (db.prepare(`
        SELECT generation FROM continuity_projection_meta WHERE id = 'main'
      `).get() as { generation: number }).generation
      if (input.projectionGeneration !== generation) {
        throw new Error('CONTINUITY_GENERATION_STALE')
      }
      const hadCandidateRow = !!candidateRowOf(db, input.source, input.projectionGeneration)
      const updated = db.prepare(`
        UPDATE summary_snapshots_all
        SET chapter_number = ?, chapter_notes = ?, continuity_facts = ?,
            source_finalization_id = ?, source_content_hash = ?, projection_generation = ?,
            created_at = datetime('now')
        WHERE draft_id = ?
      `).run(
        input.chapterNumber,
        chapterNotes,
        facts,
        input.source.finalizationId,
        input.source.contentHash,
        input.projectionGeneration,
        input.draftId,
      )
      if (updated.changes === 0) {
        db.prepare(`
          INSERT INTO summary_snapshots_all (
            draft_id, chapter_number, chapter_notes, continuity_facts,
            source_finalization_id, source_content_hash, projection_generation
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.draftId,
          input.chapterNumber,
          chapterNotes,
          facts,
          input.source.finalizationId,
          input.source.contentHash,
          input.projectionGeneration,
        )
      }
      if (!hadCandidateRow) restoreDerivedRelationCandidates(db, input.source, input.projectionGeneration)
    })()
  }

  static saveFinalizedCharacterStateCandidates(input: SaveFinalizedCharacterStateCandidatesRequest, db = getProjectDb()): void {
    if (!db) throw new Error('PROJECT_NOT_OPEN')
    if (
      !Number.isSafeInteger(input.draftId)
      || input.draftId < 1
      || !Number.isSafeInteger(input.chapterNumber)
      || input.chapterNumber < 1
      || !Number.isSafeInteger(input.projectionGeneration)
      || input.projectionGeneration < 0
    ) throw new Error('CONTINUITY_CHARACTER_STATE_CANDIDATES_INVALID')

    db.transaction(() => {
      const snapshot = readFinalizedSourceFromDb(db, input.draftId)
      if (!snapshot || !sameSource(snapshot.source, input.source) || input.chapterNumber !== snapshot.source.chapterNumber) {
        throw new Error('CONTINUITY_SOURCE_STALE')
      }
      if (input.projectionGeneration !== snapshot.projectionGeneration) {
        throw new Error('CONTINUITY_GENERATION_STALE')
      }
      const row = db.prepare(`
        SELECT character_state_candidates AS candidates,
               source_finalization_id AS finalizationId,
               source_content_hash AS contentHash,
               projection_generation AS projectionGeneration
        FROM summary_snapshots
        WHERE draft_id = ?
      `).get(input.draftId) as {
        candidates: string
        finalizationId: string
        contentHash: string
        projectionGeneration: number
      } | undefined
      if (
        !row
        || row.finalizationId !== input.source.finalizationId
        || row.contentHash !== input.source.contentHash
        || row.projectionGeneration !== input.projectionGeneration
      ) throw new Error('CONTINUITY_PROJECTION_MISSING')

      const store = parseCharacterStateCandidateStore(row.candidates)
      const merged = new Map<string, FinalizedCharacterStateCandidate>()
      for (const candidate of [
        ...store.pending,
        ...normalizeCharacterStateCandidates(db, input.candidates, input.source),
      ]) {
        if (candidate.candidateKey && store.receipts.some(receipt => receipt.candidateKey === candidate.candidateKey)) continue
        merged.set(`${candidate.characterId ?? `legacy:${characterRosterIdentityKey(candidate.characterName)}`}\u0000${candidate.field}`, candidate)
      }
      store.pending = [...merged.values()]
      db.prepare(`
        UPDATE summary_snapshots_all
        SET character_state_candidates = ?, created_at = datetime('now')
        WHERE draft_id = ?
      `).run(JSON.stringify(store), input.draftId)
    })()
  }

  static listFinalizedContinuityBefore(chapterNumber: number, db = getProjectDb()): FinalizedContinuityProjection[] {
    if (!db) return []
    if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
      throw new Error('CONTINUITY_TARGET_CHAPTER_INVALID')
    }
    const rows = db.prepare(`
      SELECT summary_snapshots.draft_id AS draftId,
             summary_snapshots.chapter_number AS chapterNumber,
             COALESCE(current_outbox.chapter_title, '') AS chapterTitle,
             summary_snapshots.chapter_notes AS chapterNotes,
             summary_snapshots.continuity_facts AS continuityFacts,
             summary_snapshots.character_state_candidates AS characterStateCandidates,
             summary_snapshots.source_finalization_id AS sourceFinalizationId,
             summary_snapshots.source_content_hash AS sourceContentHash,
             summary_snapshots.projection_generation AS projectionGeneration,
             current_drafts.id AS currentDraftId,
             current_drafts.status AS currentDraftStatus,
             current_outbox.finalization_id AS currentFinalizationId,
             current_outbox.content_hash AS currentContentHash,
             current_outbox.content_snapshot AS contentSnapshot,
             current_contents.body AS currentContent,
             continuity_projection_meta.generation AS currentGeneration,
             continuity_projection_meta.stale_from_chapter AS staleFromChapter
      FROM summary_snapshots
      JOIN drafts ON drafts.id = summary_snapshots.draft_id
      JOIN contents ON contents.id = drafts.content_id
      LEFT JOIN drafts current_drafts ON current_drafts.chapter_number = drafts.chapter_number
        AND current_drafts.status = 'finalized'
        AND NOT EXISTS (
          SELECT 1 FROM drafts newer
          WHERE newer.chapter_number = current_drafts.chapter_number
            AND newer.status = 'finalized'
            AND (newer.version > current_drafts.version OR (newer.version = current_drafts.version AND newer.id > current_drafts.id))
        )
      LEFT JOIN contents current_contents ON current_contents.id = current_drafts.content_id
      LEFT JOIN finalization_outbox current_outbox ON current_outbox.draft_id = current_drafts.id
      JOIN continuity_projection_meta ON continuity_projection_meta.id = 'main'
      WHERE summary_snapshots.draft_id IS NOT NULL
        AND summary_snapshots.chapter_number < ?
        AND summary_snapshots.chapter_notes <> ''
        AND drafts.status IN (${RECEIPTED_DRAFT_STATUS_SQL})
        AND NOT EXISTS (
          SELECT 1 FROM summary_snapshots newer_summary
          WHERE newer_summary.chapter_number = summary_snapshots.chapter_number
            AND newer_summary.chapter_notes <> '' AND newer_summary.id > summary_snapshots.id
        )
      ORDER BY summary_snapshots.chapter_number ASC, summary_snapshots.draft_id ASC
    `).all(chapterNumber) as Array<Omit<FinalizedContinuityProjection, 'facts' | 'characterStateCandidates' | 'source' | 'sourceStatus'> & {
      continuityFacts: string
      characterStateCandidates: string
      sourceFinalizationId: string
      sourceContentHash: string
      projectionGeneration: number
      currentDraftId: number | null
      currentDraftStatus: string | null
      currentFinalizationId: string | null
      currentContentHash: string | null
      contentSnapshot: string | null
      currentContent: string
      currentGeneration: number
      staleFromChapter: number | null
    }>
    return rows.map((row) => {
      const hasBoundSource = Boolean(row.sourceFinalizationId && row.sourceContentHash)
      const sourceCurrent = hasBoundSource
        && row.currentFinalizationId === row.sourceFinalizationId
        && row.currentContentHash === row.sourceContentHash
        && row.contentSnapshot === row.currentContent
        && sha256(row.currentContent) === row.currentContentHash
      const fallbackCurrent = Number.isSafeInteger(row.currentDraftId) && row.currentDraftId! > 0
        && row.currentDraftStatus === 'finalized' && typeof row.currentContent === 'string'
        && typeof row.contentSnapshot === 'string' && row.contentSnapshot === row.currentContent
        && typeof row.currentContentHash === 'string' && sha256(row.currentContent) === row.currentContentHash
      const invalidated = row.staleFromChapter !== null
        && row.chapterNumber >= row.staleFromChapter
        && row.projectionGeneration < row.currentGeneration
      const facts = parseFacts(row.continuityFacts, row.chapterNumber)
      const candidates = parseCharacterStateCandidates(row.characterStateCandidates)
      const source = { draftId: row.draftId, finalizationId: row.sourceFinalizationId,
        chapterNumber: row.chapterNumber, contentHash: row.sourceContentHash }
      let identityStatus: 'current' | 'legacy' | 'stale' = 'current'
      if (hasCharacterIdentitySchema(db) && sourceCurrent) {
        try {
          const frozen = readFrozenCharacterSnapshot(db, source)
          if (!frozen || facts.some(fact => fact.entities.some(entity => frozen.characters.some(character => character.displayNameSnapshot === entity)
            && !fact.characterRefs?.some(ref => ref.displayNameSnapshot === entity)))
            || candidates.some(candidate => !candidate.characterId)) identityStatus = 'legacy'
          else {
            const bound = (characterId: string, displayName: string) => frozen.characters.some(character => character.characterId === characterId
              && character.displayNameSnapshot === displayName)
              && frozen.characters.filter(character => character.displayNameSnapshot === displayName).length === 1
            if (facts.some(fact => fact.characterRefs?.some(ref => !bound(ref.characterId, ref.displayNameSnapshot)) || fact.entities.some(entity => {
              if (!frozen.characters.some(character => character.displayNameSnapshot === entity)) return false
              const refs = fact.characterRefs?.filter(ref => ref.displayNameSnapshot === entity) ?? []
              return refs.length !== 1 || !bound(refs[0].characterId, entity)
            })) || candidates.some(candidate => !bound(candidate.characterId!, candidate.characterName))) identityStatus = 'stale'
          }
        } catch { identityStatus = 'stale' }
      }
      return {
        draftId: row.draftId,
        ...(!sourceCurrent && fallbackCurrent ? { currentFinalizedDraftId: row.currentDraftId! } : {}),
        chapterNumber: row.chapterNumber,
        chapterTitle: row.chapterTitle,
        chapterNotes: row.chapterNotes,
        facts,
        ...(candidates.length > 0 ? { characterStateCandidates: candidates } : {}),
        ...(hasBoundSource ? {
          source: {
            draftId: row.draftId,
            finalizationId: row.sourceFinalizationId,
            chapterNumber: row.chapterNumber,
            contentHash: row.sourceContentHash,
          },
        } : {}),
        sourceStatus: !hasBoundSource ? 'legacy' : sourceCurrent && !invalidated ? identityStatus : 'stale',
      }
    })
  }

  /** Raw immutable prose is the deterministic fallback when a derived projection is stale. */
  static readFinalizedSource(draftId: number): FinalizedSourceReadResult {
    const db = getProjectDb()
    if (!db) return { status: 'invalid' }
    if (!Number.isSafeInteger(draftId) || draftId < 1) throw new Error('CONTINUITY_SOURCE_DRAFT_INVALID')
    const row = db.prepare(`
      SELECT drafts.id AS draftId, drafts.chapter_number AS chapterNumber, drafts.status,
             contents.body AS content,
             COALESCE(finalization_outbox.chapter_title, blueprints.title, '') AS chapterTitle,
             finalization_outbox.draft_id AS receiptDraftId,
             finalization_outbox.finalization_id AS finalizationId
      FROM drafts
      JOIN contents ON contents.id = drafts.content_id
      LEFT JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
      LEFT JOIN blueprints ON blueprints.chapter_number = drafts.chapter_number
      WHERE drafts.id = ?
    `).get(draftId) as {
      draftId: number
      chapterNumber: number
      status: string
      content: string
      chapterTitle: string
      receiptDraftId: number | null
      finalizationId: string | null
    } | undefined
    if (!row || row.status !== 'finalized') return { status: 'invalid' }
    if (row.receiptDraftId === null) {
      return {
        status: 'legacy',
        draftId: row.draftId,
        chapterNumber: row.chapterNumber,
        chapterTitle: row.chapterTitle,
        content: row.content,
      }
    }
    const snapshot = readFinalizedSourceFromDb(db, draftId)
    return snapshot ? { status: 'valid', snapshot } : { status: 'invalid' }
  }
}
