import { createHash, randomUUID as randomUUIDForIdentity } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'

import {
  CHARACTER_ROSTER_ROLES,
  CHARACTER_ROSTER_SCHEMA_VERSION,
  CHARACTER_STATE_TEXT_FIELDS,
  characterRosterIdentityKey,
  type CharacterRosterCharacterState,
  type CharacterRosterEntry,
  type CharacterRosterMigrationState,
  type CharacterRosterStatus,
  type CharacterRosterRelationship,
  type CharacterRosterRole,
  type CharacterRosterSnapshot,
  type CharacterStateFieldProvenance,
} from '../../src/shared/character-roster'
import type { FinalizedSourceIdentity } from '../../src/shared/finalized-continuity'
import { isContentHash } from '../../src/shared/source-ref'
import { getProjectDb } from '../database'
import { CharacterRepository, hasCharacterIdentitySchema, type CharacterData } from './character-repository'
import { insertCharacterRelationship } from './character-continuity-repository'
import { ensureCharacterRosterSchema } from './character-roster-schema'
import { CHARACTER_ROLE_LABELS, normalizeCharacterRole } from '../../src/shared/character-role'
import { DEFAULT_WRITING_LANGUAGE, type WritingLanguage } from '../../src/shared/writing-language'
import { ProjectCoreRepository } from './project-core-repository'

interface CharacterRosterMetaRow {
  schema_version: number
  revision: number
  migration_state: CharacterRosterMigrationState
  legacy_markdown: string
  projection_hash: string
  fact_hash: string
}

const ROLE_ORDER: Record<CharacterRosterRole, number> = {
  protagonist: 0,
  supporting: 1,
  antagonist: 2,
  minor: 3,
}

function requiredDb(): BetterSqlite3.Database {
  const db = getProjectDb()
  if (!db) throw new Error('PROJECT_NOT_OPEN')
  return db
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('CHARACTER_ROSTER_TEXT_INVALID')
  return value.trim()
}

/** Only fields whose domain explicitly permits numeric scalar expression use this normalizer. */
function requiredTextOrFiniteNumber(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return requiredText(value)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRosterRole(value: unknown): value is CharacterRosterRole {
  return typeof value === 'string'
    && (CHARACTER_ROSTER_ROLES as readonly string[]).includes(value)
}

function normalizeFinalizedSource(value: unknown): FinalizedSourceIdentity {
  if (!isObject(value)) throw new Error('CHARACTER_ROSTER_FINALIZED_SOURCE_INVALID')
  const finalizationId = requiredText(value.finalizationId)
  const contentHash = requiredText(value.contentHash)
  if (
    !Number.isSafeInteger(value.draftId) || (value.draftId as number) < 1
    || !Number.isSafeInteger(value.chapterNumber) || (value.chapterNumber as number) < 1
    || !finalizationId
    || !/^[a-f0-9]{64}$/u.test(contentHash)
  ) throw new Error('CHARACTER_ROSTER_FINALIZED_SOURCE_INVALID')
  return {
    draftId: value.draftId as number,
    finalizationId,
    chapterNumber: value.chapterNumber as number,
    contentHash,
  }
}

function normalizeFieldProvenance(value: unknown): CharacterStateFieldProvenance {
  if (!isObject(value)) throw new Error('CHARACTER_ROSTER_STATE_PROVENANCE_INVALID')
  if (value.kind === 'legacy') return { kind: 'legacy' }
  if (value.kind === 'author') {
    if (!Number.isSafeInteger(value.chapterNumber) || (value.chapterNumber as number) < 0) {
      throw new Error('CHARACTER_ROSTER_STATE_CHAPTER_INVALID')
    }
    return { kind: 'author', chapterNumber: value.chapterNumber as number }
  }
  if (value.kind === 'derived') {
    return { kind: 'derived', source: normalizeFinalizedSource(value.source) }
  }
  throw new Error('CHARACTER_ROSTER_STATE_PROVENANCE_INVALID')
}

function normalizeState(value: unknown): CharacterRosterCharacterState | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new Error('CHARACTER_ROSTER_STATE_INVALID')
  const updatedAtChapter = value.updatedAtChapter
  if (!Number.isSafeInteger(updatedAtChapter) || (updatedAtChapter as number) < 0) {
    throw new Error('CHARACTER_ROSTER_STATE_CHAPTER_INVALID')
  }
  const rawProvenance = value.provenance === undefined ? {} : value.provenance
  if (!isObject(rawProvenance)) throw new Error('CHARACTER_ROSTER_STATE_PROVENANCE_INVALID')
  const provenance: NonNullable<CharacterRosterCharacterState['provenance']> = {}
  for (const field of CHARACTER_STATE_TEXT_FIELDS) {
    const normalizedValue = requiredText(value[field])
    if (Object.hasOwn(rawProvenance, field)) {
      provenance[field] = normalizeFieldProvenance(rawProvenance[field])
    } else if (normalizedValue) {
      // Pre-v2 and non-manual generation values stay visible but never become author facts.
      provenance[field] = { kind: 'legacy' }
    }
  }
  return {
    location: requiredText(value.location),
    powerLevel: requiredText(value.powerLevel),
    physicalState: requiredText(value.physicalState),
    mentalState: requiredText(value.mentalState),
    keyItems: requiredText(value.keyItems),
    recentEvents: requiredText(value.recentEvents),
    updatedAtChapter: updatedAtChapter as number,
    ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
  }
}

function normalizeRelationships(value: unknown, ownerName: string): CharacterRosterRelationship[] {
  if (!Array.isArray(value)) throw new Error('CHARACTER_ROSTER_RELATIONSHIPS_INVALID')
  const seen = new Set<string>()
  return value.map(relationship => {
    if (!isObject(relationship)) {
      throw new Error('CHARACTER_ROSTER_RELATIONSHIPS_INVALID')
    }
    const target = requiredText(relationship.target)
    const relation = requiredText(relationship.relation)
    if (!target) throw new Error('CHARACTER_ROSTER_RELATIONSHIP_TARGET_REQUIRED')
    if (!relation) throw new Error('CHARACTER_ROSTER_RELATIONSHIP_DESCRIPTION_REQUIRED')
    if (target === ownerName) throw new Error('CHARACTER_ROSTER_RELATIONSHIP_SELF')
    const key = `${target}\u0000${relation}`
    if (seen.has(key)) throw new Error('CHARACTER_ROSTER_RELATIONSHIP_DUPLICATE')
    seen.add(key)
    return { target, relation }
  }).sort((left, right) => (
    compareText(left.target, right.target) || compareText(left.relation, right.relation)
  ))
}

function normalizeEntry(
  value: unknown,
  allowLegacyRelationshipNotes: boolean,
): CharacterRosterEntry {
  if (!isObject(value)) throw new Error('CHARACTER_ROSTER_ENTRY_INVALID')
  const name = requiredText(value.name)
  if (!name) throw new Error('CHARACTER_ROSTER_NAME_REQUIRED')
  if (!isRosterRole(value.role)) throw new Error('CHARACTER_ROSTER_ROLE_INVALID')

  if (Object.hasOwn(value, 'legacyRelationshipNotes') && !allowLegacyRelationshipNotes) {
    throw new Error('CHARACTER_ROSTER_FREE_RELATIONSHIPS_FORBIDDEN')
  }
  const legacyRelationshipNotes = allowLegacyRelationshipNotes && typeof value.legacyRelationshipNotes === 'string'
    ? value.legacyRelationshipNotes.trim()
    : undefined
  return {
    name,
    role: value.role,
    gender: requiredText(value.gender),
    age: requiredTextOrFiniteNumber(value.age),
    appearance: requiredText(value.appearance),
    personality: requiredText(value.personality),
    background: requiredText(value.background),
    abilities: requiredText(value.abilities),
    motivation: requiredText(value.motivation),
    relationships: normalizeRelationships(value.relationships, name),
    arc: requiredText(value.arc),
    notes: requiredText(value.notes),
    currentState: normalizeState(value.currentState),
    ...(legacyRelationshipNotes ? { legacyRelationshipNotes } : {}),
  }
}

/** Validate migration candidates without re-enabling the retired name-based write path. */
export function validateLegacyRosterCandidate(value: unknown): CharacterRosterEntry[] {
  if (!isObject(value)) throw new Error('CHARACTER_ROSTER_REQUEST_INVALID')
  if (value.schemaVersion !== CHARACTER_ROSTER_SCHEMA_VERSION) throw new Error('CHARACTER_ROSTER_SCHEMA_UNSUPPORTED')
  if (!Array.isArray(value.entries) || value.entries.length === 0) throw new Error('CHARACTER_ROSTER_ENTRIES_REQUIRED')
  const entries = value.entries.map(entry => normalizeEntry(entry, false))
  const names = new Set(entries.map(entry => characterRosterIdentityKey(entry.name)))
  if (names.size !== entries.length) throw new Error('CHARACTER_ROSTER_NAME_DUPLICATE')
  for (const entry of entries) {
    for (const relationship of entry.relationships) {
      if (!names.has(characterRosterIdentityKey(relationship.target))) {
        throw new Error('CHARACTER_ROSTER_RELATIONSHIP_TARGET_UNKNOWN')
      }
    }
  }
  return entries
}

/** Shared scalar validation; the author boundary validates relationships by ID separately. */
export function normalizeAuthorRosterEntry(value: unknown): CharacterRosterEntry {
  if (!isObject(value)) throw new Error('CHARACTER_AUTHOR_ENTRY_INVALID')
  return normalizeEntry({ ...value, relationships: [] }, true)
}

function canonicalEntries(entries: CharacterRosterEntry[]): CharacterRosterEntry[] {
  return [...entries]
    .map(entry => ({
      ...entry,
      relationships: [...entry.relationships].sort((left, right) => (
        compareText(left.target, right.target) || compareText(left.relation, right.relation)
      )),
    }))
    .sort((left, right) => compareText(left.name, right.name))
}

/**
 * 稳定身份规范化：以 characterId、关系目标 targetCharacterId 为排序主键。
 * 重名角色不会因为显示名相同而互相折叠，关系从同名目标 A 改指向同名目标 B
 * 也会产生不同序列。只用于身份 schema 项目的公开事实哈希，旧项目仍走
 * canonicalEntries 的姓名版本，保证既有 ready 项目的持久哈希不变。
 */
function canonicalIdentityEntries(entries: CharacterRosterEntry[]): CharacterRosterEntry[] {
  return [...entries]
    .map(entry => ({
      ...entry,
      relationships: [...entry.relationships]
        .map(relationship => ({ ...relationship }))
        .sort((left, right) => (
          compareText(left.targetCharacterId ?? '', right.targetCharacterId ?? '')
          || compareText(left.target, right.target)
          || compareText(left.relation, right.relation)
        )),
    }))
    .sort((left, right) => (
      compareText(left.characterId ?? '', right.characterId ?? '')
      || compareText(left.name, right.name)
    ))
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isStructuredRelationships(value: string): value is string {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every(relationship => (
      isObject(relationship)
      && typeof relationship.target === 'string'
      && typeof relationship.relation === 'string'
    ))
  } catch {
    return false
  }
}

function entryFromCharacter(character: CharacterData): CharacterRosterEntry {
  const hasStructuredRelationships = isStructuredRelationships(character.relationships)
  const relationships = hasStructuredRelationships
    ? JSON.parse(character.relationships) as CharacterRosterRelationship[]
    : []
  return {
    name: character.name,
    role: normalizeCharacterRole(character.role),
    gender: character.gender,
    age: character.age,
    appearance: character.appearance,
    personality: character.personality,
    background: character.background,
    abilities: character.abilities,
    motivation: character.motivation,
    relationships: [...relationships].sort((left, right) => (
      compareText(left.target, right.target) || compareText(left.relation, right.relation)
    )),
    arc: character.arc,
    notes: character.notes,
    currentState: character.currentState,
    ...(hasStructuredRelationships || !character.relationships
      ? {}
      : { legacyRelationshipNotes: character.relationships }),
  }
}

function fullFactHash(entries: CharacterRosterEntry[]): string {
  return hashText(JSON.stringify(canonicalEntries(entries)))
}

/**
 * 公开事实哈希。身份 schema 项目从带稳定 ID 的事实派生，因此角色改名、
 * 同名目标重指向都会改变它；旧项目保持 meta.fact_hash 的姓名版本不变。
 */
function fullIdentityFactHash(entries: CharacterRosterEntry[]): string {
  return hashText(JSON.stringify(canonicalIdentityEntries(entries)))
}

function sortedEntries(entries: CharacterRosterEntry[]): CharacterRosterEntry[] {
  return [...entries].sort((left, right) => (
    ROLE_ORDER[left.role] - ROLE_ORDER[right.role] || compareText(left.name, right.name)
  ))
}

/**
 * 只从结构化角色名单生成展示 Markdown。此函数绝不读取或解释旧 Markdown。
 */
export function renderCharacterRosterMarkdown(
  entries: CharacterRosterEntry[],
  writingLanguage: WritingLanguage = DEFAULT_WRITING_LANGUAGE,
): string {
  const canonical = sortedEntries(entries)
  if (canonical.length === 0) return ''
  const english = writingLanguage === 'en-US'

  const blocks = canonical.map(entry => {
    const roleLabel = english
      ? CHARACTER_ROLE_LABELS[entry.role].enUS
      : CHARACTER_ROLE_LABELS[entry.role].zhCN
    const lines = [`## ${roleLabel}${english ? ': ' : '：'}${entry.name}`]
    const fields: Array<[string, string]> = [
      [english ? 'Gender' : '性别', entry.gender],
      [english ? 'Age' : '年龄', entry.age],
      [english ? 'Appearance' : '外貌', entry.appearance],
      [english ? 'Personality' : '性格', entry.personality],
      [english ? 'Background' : '背景', entry.background],
      [english ? 'Abilities' : '能力', entry.abilities],
      [english ? 'Motivation' : '动机', entry.motivation],
      [english ? 'Arc' : '弧光', entry.arc],
      [english ? 'Notes' : '备注', entry.notes],
    ]
    for (const [label, value] of fields) {
      if (value) lines.push(`- ${label}${english ? ': ' : '：'}${value}`)
    }
    for (const relationship of entry.relationships) {
      lines.push(english
        ? `- Relationship: ${relationship.target} (${relationship.relation})`
        : `- 关系：${relationship.target}（${relationship.relation}）`)
    }
    if (entry.legacyRelationshipNotes) {
      lines.push(english
        ? `- Relationship notes: ${entry.legacyRelationshipNotes}`
        : `- 关系备注：${entry.legacyRelationshipNotes}`)
    }
    return lines.join('\n')
  })
  return [english ? '# Character graph' : '# 角色图谱', ...blocks].join('\n\n')
}

function readMeta(db: BetterSqlite3.Database): CharacterRosterMetaRow {
  const row = db.prepare(`
    SELECT schema_version, revision, migration_state, legacy_markdown, projection_hash, fact_hash
    FROM character_roster_meta
    WHERE id = 'main'
  `).get() as CharacterRosterMetaRow | undefined
  if (!row) throw new Error('CHARACTER_ROSTER_META_MISSING')
  return row
}

function readCurrentProjection(db: BetterSqlite3.Database): string {
  return (db.prepare(
    "SELECT COALESCE(characters_arch, '') AS characters_arch FROM project_core WHERE id = 'main'",
  ).get() as { characters_arch?: string } | undefined)?.characters_arch ?? ''
}

/**
 * 严格区分“可安全使用的既有角色卡”和“需要作者显式修复的旧 Markdown”。
 * 所有自动打开/读取路径只做分类，绝不在这里写入或解析旧文本。
 */
function deriveRosterStatus(
  meta: CharacterRosterMetaRow,
  entries: readonly CharacterRosterEntry[],
  renderedMarkdown: string,
  currentProjection: string,
): CharacterRosterStatus {
  switch (meta.migration_state) {
    case 'empty':
      return entries.length === 0 && !meta.legacy_markdown.trim() && !currentProjection.trim()
        ? 'empty'
        : 'inconsistent'
    case 'legacy_cards_preserved':
      // 已有角色卡本身是受保护的结构化事实，但旧项目还未用这些事实重建
      // 确定性只读图谱。不能在打开项目时自动写入，也不能直接标记 ready。
      return 'inconsistent'
    case 'legacy_markdown_pending':
      return entries.length === 0 && !!meta.legacy_markdown.trim()
        ? 'legacy_repair_required'
        : 'inconsistent'
    case 'ready':
      // 投影和包含 currentState 的完整事实哈希都必须与表内事实一致。
      if (
        meta.projection_hash !== hashText(renderedMarkdown)
        || meta.fact_hash !== fullFactHash([...entries])
        || currentProjection !== renderedMarkdown
      ) return 'inconsistent'
      return entries.length > 0 ? 'ready' : 'empty'
  }
}

function identityProjectionEntries(db: BetterSqlite3.Database, includeIds = false): CharacterRosterEntry[] {
  const relationships = db.prepare(`SELECT r.source_character_id,r.target_character_id,c.name,r.relation FROM character_relationships r
    JOIN characters c ON c.character_id=r.target_character_id WHERE c.retired=0 ORDER BY r.relationship_id`).all() as { source_character_id: string; target_character_id: string; name: string; relation: string }[]
  const activeIds = new Set((db.prepare('SELECT character_id FROM characters WHERE retired=0').all() as { character_id: string }[]).map(row => row.character_id))
  return sortedEntries(CharacterRepository.getAll(db).filter(character => activeIds.has(character.characterId!)).map(character => ({ ...entryFromCharacter(character),
    ...(includeIds ? { characterId: character.characterId } : {}),
    relationships: relationships.filter(item => item.source_character_id === character.characterId).map(item => ({ target: item.name, relation: item.relation,
      ...(includeIds ? { targetCharacterId: item.target_character_id } : {}) })) })))
}
/** 清空故事架构时丢弃升级遗留的角色架构原文，再按当前 ID 事实重建投影。 */
export function clearLegacyCharacterArchitecture(db: BetterSqlite3.Database): void {
  if (!db.inTransaction) throw new Error('CHARACTER_ID_TRANSACTION_REQUIRED')
  db.prepare("UPDATE character_roster_meta SET legacy_markdown='' WHERE id='main'").run()
  refreshCharacterIdentityProjection(db)
}
/** Compatibility prose is derived from ID facts and never acts as an identity write source. */
export function refreshCharacterIdentityProjection(db: BetterSqlite3.Database): void {
  if (!db.inTransaction || !hasCharacterIdentitySchema(db)) throw new Error('CHARACTER_ID_TRANSACTION_REQUIRED')
  const entries = identityProjectionEntries(db), writingLanguage = db.prepare("SELECT writing_language FROM project_core WHERE id='main'").pluck().get() === 'en-US' ? 'en-US' : DEFAULT_WRITING_LANGUAGE
  const projection = renderCharacterRosterMarkdown(entries, writingLanguage)
  db.prepare("UPDATE project_core SET characters_arch=? WHERE id='main'").run(projection)
  db.prepare("UPDATE character_roster_meta SET revision=revision+1,migration_state='ready',projection_hash=?,fact_hash=?,updated_at=datetime('now') WHERE id='main'").run(hashText(projection), fullFactHash(entries))
}
/** Dynamic state refreshes invalidate readers without rewriting author/static compatibility prose. */
export function refreshCharacterStateProjection(db: BetterSqlite3.Database): void {
  if (!db.inTransaction || !hasCharacterIdentitySchema(db)) throw new Error('CHARACTER_ID_TRANSACTION_REQUIRED')
  db.prepare("UPDATE character_roster_meta SET revision=revision+1,fact_hash=?,updated_at=datetime('now') WHERE id='main'")
    .run(fullFactHash(identityProjectionEntries(db)))
}
function readSnapshot(db: BetterSqlite3.Database): CharacterRosterSnapshot {
  const meta = readMeta(db)
  const hasIdentitySchema = hasCharacterIdentitySchema(db)
  const entries = hasIdentitySchema ? identityProjectionEntries(db) : sortedEntries(CharacterRepository.getAll(db).map(entryFromCharacter))
  // 身份 schema 项目额外读取带稳定 ID 的事实，用于公开 DTO 与公开事实哈希。
  // 持久化 meta.fact_hash 仍是姓名版本，ready 校验不受影响。
  const identityEntries = hasIdentitySchema ? identityProjectionEntries(db, true) : entries
  const writingLanguage = ProjectCoreRepository.get(db)?.writingLanguage ?? DEFAULT_WRITING_LANGUAGE
  const currentProjection = readCurrentProjection(db)
  const localizedProjection = renderCharacterRosterMarkdown(entries, writingLanguage)
  const previousLanguageProjection = renderCharacterRosterMarkdown(
    entries,
    writingLanguage === 'en-US' ? 'zh-CN' : 'en-US',
  )
  // A project may change writing language after a ready roster was committed.
  // Keep that exact historical projection readable.
  const renderedMarkdown = (
    meta.migration_state === 'ready'
    && currentProjection === previousLanguageProjection
    && meta.projection_hash === hashText(previousLanguageProjection)
  ) ? previousLanguageProjection : localizedProjection
  const projectionHash = hashText(renderedMarkdown)
  return {
    schemaVersion: CHARACTER_ROSTER_SCHEMA_VERSION,
    revision: meta.revision,
    migrationState: meta.migration_state,
    status: deriveRosterStatus(meta, entries, renderedMarkdown, currentProjection),
    entries: identityEntries,
    ...(hasIdentitySchema ? {
      identityRevision: db.prepare("SELECT revision FROM character_identity_meta WHERE id='main'").pluck().get() as number,
      aliases: db.prepare(`SELECT a.character_id AS characterId,a.name,a.source_key AS sourceKey,
        a.valid_from AS validFrom,a.valid_through AS validThrough FROM character_aliases a
        JOIN characters c ON c.character_id=a.character_id WHERE c.retired=0
        ORDER BY a.character_id,a.name,a.source_key,a.valid_from`).all() as NonNullable<CharacterRosterSnapshot['aliases']>,
    } : {}),
    renderedMarkdown,
    projectionHash,
    // 旧项目沿用持久化的姓名版本哈希；身份 schema 项目改为按稳定 ID 派生。
    factHash: hasIdentitySchema ? fullIdentityFactHash(identityEntries) : meta.fact_hash,
    // 该值始终是持久化的姓名版本哈希，供按姓名写入的历史收据做兼容校验。
    nameOnlyFactHash: meta.fact_hash,
    ...(meta.legacy_markdown ? { legacyMarkdown: meta.legacy_markdown } : {}),
  }
}

/** 名单只读入口；写入只走 character-roster-author 的身份路径。 */
export class CharacterRosterRepository {
  static read(db = requiredDb()): CharacterRosterSnapshot {
    ensureCharacterRosterSchema(db)
    return readSnapshot(db)
  }
}

export interface CharacterIdentityChange {
  characterId: string
  /** Static edits leave all cs_* dynamic provenance untouched. */
  fields: Partial<Pick<CharacterData, 'name' | 'role' | 'gender' | 'age' | 'appearance' | 'personality' | 'background' | 'abilities' | 'motivation' | 'arc' | 'notes'>>
}
export interface CharacterIdentityCommitRequest {
  approval: import('../../src/shared/character-identity').CharacterApproval
  changes: CharacterIdentityChange[]
  creations: { selectionKey: string; fields: CharacterIdentityChange['fields'] & { name: string } }[]
  retireIds: string[]
  relationships: { sourceCharacterId?: string; sourceSelectionKey?: string; targetCharacterId?: string; targetSelectionKey?: string; relation: string; effectiveChapter?: number }[]
  resolutions: { proposalId: string; characterId: string }[]
}
export interface CharacterIdentityCommitReceipt {
  approval: import('../../src/shared/character-identity').CharacterApproval
  operationId: string
  revision: number
  created: { selectionKey: string; characterId: string }[]
  idempotent: boolean
}
/** Only the main approval boundary supplies authorize. Legacy name-only commits never reach this API. */
export function commitCharacterIdentities(
  db: BetterSqlite3.Database,
  request: CharacterIdentityCommitRequest,
  authorize: (request: CharacterIdentityCommitRequest) => boolean = () => false,
): CharacterIdentityCommitReceipt {
  if (!hasCharacterIdentitySchema(db)) throw new Error('CHARACTER_ID_SCHEMA_REQUIRED')
  const encoded = JSON.stringify(request), digest = createHash('sha256').update(encoded).digest('hex')
  return db.transaction(() => {
    if (!authorize(request)) throw new Error('CHARACTER_APPROVAL_REQUIRED')
    if (JSON.stringify(request) !== encoded) throw new Error('CHARACTER_APPROVAL_MUTATED')
    const previous = db.prepare('SELECT payload_hash,receipt_json FROM character_identity_approvals WHERE operation_id=?').get(request.approval.operationId) as { payload_hash: string; receipt_json: string } | undefined
    if (previous) {
      if (previous.payload_hash !== digest) throw new Error('CHARACTER_APPROVAL_NONCE_CONFLICT')
      return { ...JSON.parse(previous.receipt_json), idempotent: true } as CharacterIdentityCommitReceipt
    }
    const current = (db.prepare("SELECT revision FROM character_identity_meta WHERE id='main'").get() as { revision: number }).revision
    if (current !== request.approval.expectedRevision) throw new Error('CHARACTER_ID_REVISION_CONFLICT')
    if (!request.approval.operationId || !request.approval.source || !['author-edit', 'adopt-generated', 'adopt-import', 'confirm-identity'].includes(request.approval.action)) throw new Error('CHARACTER_APPROVAL_INVALID')
    const allowedSources = {
      'author-edit': ['author'],
      'adopt-generated': ['generated'],
      'adopt-import': ['generated', 'derived'],
      'confirm-identity': ['author'],
    } as const
    if (request.approval.source.kind === 'legacy'
      || !(allowedSources[request.approval.action] as readonly string[]).includes(request.approval.source.kind)) throw new Error('CHARACTER_PROVENANCE_INVALID')
    const provenance = request.approval.source
    const ref = provenance.source
    if (!ref || typeof ref.projectId !== 'string' || !ref.projectId.trim() || typeof ref.epoch !== 'string' || !ref.epoch.trim() || typeof ref.sourceId !== 'string' || !ref.sourceId.trim() || !Number.isSafeInteger(ref.revision) || ref.revision < 0 || !isContentHash(ref.contentHash)
      || (provenance.kind === 'generated' || provenance.kind === 'derived') && !isContentHash(provenance.modelRevision)) throw new Error('CHARACTER_PROVENANCE_INVALID')
    const revision = current + 1
    const attributedSource = { ...request.approval.source, approvalId: request.approval.operationId }
    const source = JSON.stringify(attributedSource)
    if (request.resolutions.length && request.approval.action !== 'confirm-identity') throw new Error('CHARACTER_ID_CONFIRMATION_REQUIRED')
    const created: CharacterIdentityCommitReceipt['created'] = []
    const allowed = new Set(['name', 'role', 'gender', 'age', 'appearance', 'personality', 'background', 'abilities', 'motivation', 'arc', 'notes'])
    const validateFields = (fields: CharacterIdentityChange['fields']) => {
      for (const [key, value] of Object.entries(fields)) if (!allowed.has(key) || typeof value !== 'string' || key === 'name' && !value.trim()) throw new Error('CHARACTER_FIELDS_INVALID')
    }
    const unique = (ids: string[]) => { if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('CHARACTER_ID_DUPLICATE') }
    unique(request.changes.map(change => change.characterId)); unique(request.creations.map(creation => creation.selectionKey)); unique(request.retireIds)
    if (request.retireIds.some(id => request.changes.some(change => change.characterId === id))) throw new Error('CHARACTER_ID_CONFLICT')
    const active = (id: string) => {
      const row = db.prepare('SELECT * FROM characters WHERE character_id=? AND retired=0').get(id) as Record<string, unknown> | undefined
      if (!row) throw new Error('CHARACTER_ID_UNKNOWN')
      return row
    }
    for (const creation of request.creations) {
      validateFields(creation.fields)
      if (typeof creation.fields.name !== 'string' || !creation.fields.name.trim()) throw new Error('CHARACTER_FIELDS_INVALID')
      const id = randomUUIDForIdentity(), keys = Object.keys(creation.fields)
      db.prepare(`INSERT INTO characters(character_id,static_provenance,identity_revision,${keys.join(',')}) VALUES(?,?,?,${keys.map(() => '?').join(',')})`).run(id, source, revision, ...Object.values(creation.fields))
      db.prepare('INSERT INTO character_aliases VALUES(?,?,?,?,NULL)').run(id, creation.fields.name, request.approval.operationId, revision)
      created.push({ selectionKey: creation.selectionKey, characterId: id })
    }
    for (const change of request.changes) {
      const row = active(change.characterId); validateFields(change.fields)
      const keys = Object.keys(change.fields)
      if (keys.length) {
        // Field provenance is merged so adopting generated text never relabels untouched author fields.
        const prior = JSON.parse(row.static_provenance as string) as Record<string, unknown>
        const provenance = { ...prior, fields: { ...(prior.fields as Record<string, unknown> | undefined), ...Object.fromEntries(keys.map(key => [key, attributedSource])) } }
        db.prepare(`UPDATE characters SET ${keys.map(key => `${key}=?`).join(',')},static_provenance=?,identity_revision=? WHERE character_id=?`).run(...Object.values(change.fields), JSON.stringify(provenance), revision, change.characterId)
      }
      if (change.fields.name !== undefined && change.fields.name !== row.name) {
        db.prepare('UPDATE character_aliases SET valid_through=? WHERE character_id=? AND valid_through IS NULL').run(current, change.characterId)
        db.prepare('INSERT INTO character_aliases VALUES(?,?,?,?,NULL)').run(change.characterId, change.fields.name, request.approval.operationId, revision)
      }
    }
    for (const id of request.retireIds) { active(id); db.prepare('UPDATE characters SET retired=1,identity_revision=? WHERE character_id=?').run(revision, id); db.prepare('UPDATE character_aliases SET valid_through=? WHERE character_id=? AND valid_through IS NULL').run(current, id) }
    const receipt: CharacterIdentityCommitReceipt = { approval: structuredClone(request.approval), operationId: request.approval.operationId, revision, created, idempotent: false }
    db.prepare('INSERT INTO character_identity_approvals VALUES(?,?,?)').run(request.approval.operationId, digest, JSON.stringify(receipt))
    const endpoint = (id: string | undefined, selectionKey: string | undefined) => {
      if (Boolean(id) === Boolean(selectionKey)) throw new Error('CHARACTER_RELATIONSHIP_ID_REQUIRED')
      const resolved = id ?? created.find(item => item.selectionKey === selectionKey)?.characterId
      if (!resolved) throw new Error('CHARACTER_RELATIONSHIP_ID_REQUIRED')
      return resolved
    }
    const relationKeys = new Set<string>()
    for (const relationship of request.relationships) {
      const fromId = endpoint(relationship.sourceCharacterId, relationship.sourceSelectionKey), toId = endpoint(relationship.targetCharacterId, relationship.targetSelectionKey)
      const from = active(fromId), to = active(toId), relationKey = JSON.stringify([fromId,toId,relationship.relation])
      if (!relationship.relation.trim() || fromId === toId || relationKeys.has(relationKey)) throw new Error('CHARACTER_RELATIONSHIP_INVALID')
      relationKeys.add(relationKey)
      insertCharacterRelationship(db, { relationshipId: randomUUIDForIdentity(), sourceId: fromId, sourceName: from.name as string, targetId: toId, targetName: to.name as string,
        relation: relationship.relation, provenanceJson: source }, request.approval, relationship.effectiveChapter)
    }
    for (const resolution of request.resolutions) {
      active(resolution.characterId)
      const proposal = db.prepare('SELECT resolved_character_id,owner_character_id,raw_value,source_key FROM character_identity_proposals WHERE proposal_id=?').get(resolution.proposalId) as { resolved_character_id: string | null; owner_character_id: string | null; raw_value: string; source_key: string } | undefined
      if (!proposal || proposal.resolved_character_id) throw new Error('CHARACTER_PROPOSAL_CONFLICT')
      // Generic legacy resolution cannot mutate immutable finalization snapshots or versioned proposal envelopes.
      if (!/^legacy:(?:characters:\d+:relationships:\d+|blueprints:\d+:characters:\d+)$/u.test(proposal.source_key))
        throw new Error('CHARACTER_PROPOSAL_KIND_INVALID')
      db.prepare('UPDATE character_identity_proposals SET resolved_character_id=?,approval_id=? WHERE proposal_id=?').run(resolution.characterId, request.approval.operationId, resolution.proposalId)
      if (proposal.owner_character_id) {
        let parsed: unknown
        try { parsed = JSON.parse(proposal.raw_value) } catch { parsed = null }
        if (parsed && typeof parsed === 'object' && 'relation' in parsed && typeof parsed.relation === 'string' && parsed.relation.trim()) {
          const from = active(proposal.owner_character_id), to = active(resolution.characterId)
          if (proposal.owner_character_id === resolution.characterId) throw new Error('CHARACTER_RELATIONSHIP_INVALID')
          insertCharacterRelationship(db, { relationshipId: randomUUIDForIdentity(), sourceId: proposal.owner_character_id, sourceName: from.name as string, targetId: resolution.characterId, targetName: to.name as string,
            relation: parsed.relation, provenanceJson: source }, request.approval)
        }
      }
    }
    db.prepare("UPDATE character_identity_meta SET revision=? WHERE id='main'").run(revision)
    return receipt
  })()
}

export function readCharacterIdentitySnapshot(db: BetterSqlite3.Database) {
  if (!hasCharacterIdentitySchema(db)) throw new Error('CHARACTER_ID_SCHEMA_REQUIRED')
  return db.transaction(() => ({
    revision: (db.prepare("SELECT revision FROM character_identity_meta WHERE id='main'").get() as { revision: number }).revision,
    characters: db.prepare('SELECT * FROM characters ORDER BY character_id').all(),
    aliases: db.prepare('SELECT * FROM character_aliases ORDER BY character_id,name,valid_from').all(),
    relationships: db.prepare('SELECT * FROM character_relationships ORDER BY relationship_id').all(),
    proposals: db.prepare('SELECT * FROM character_identity_proposals ORDER BY proposal_id').all(),
  }))()
}
