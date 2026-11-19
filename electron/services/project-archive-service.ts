import fs, { createReadStream } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import { CHARACTER_STATE_TEXT_FIELDS } from '../../src/shared/character-roster'
import { validThreadOutcome } from '../../src/shared/chapter-goal-review'
import { writtenChapterThreadTasks } from '../../src/shared/narrative-thread'
import { readPortableCurrentAuthority } from './portable-current-authority'
import { parsePortableRuntimeFreeze, readPortableRuntimeFreeze } from './portable-runtime-freeze'

import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import {
  CANONICAL_PROJECT_DATABASE,
  CANONICAL_PROJECT_DIRECTORY,
  parseCanonicalProjectManifest,
} from '../../src/shared/project-format'
import { logicalTableName } from '../migrations/m07-chapter-recycle'
import { readPortableCharacterAvatarRows } from '../repositories/character-asset-repository'
import {
  DEFAULT_PORTABLE_ARCHIVE_LIMITS,
  PORTABLE_PROJECT_FORMAT_VERSION,
  PORTABLE_SOURCE_SCHEMA_VERSION,
  PORTABLE_READABLE_SOURCE_SCHEMA_VERSIONS,
  assertPortableExportSource,
  assertPortableSourceSchema,
  getPortableFieldPolicy,
  portablePathKey,
  type PortableEntryDisposition,
  type PortableOmissionReason,
  type PortableProjectManifest,
  type PortableProjectManifestEntry,
} from './portable-project-format'
import {
  PortableProjectArchiveError,
  writePortableProjectArchive,
  type PortableArchiveSource,
} from './portable-project-archive'
import { snapshotProjectSqlite } from './sqlite-project-migration'
import { withKnowledgeSourceGate } from './knowledge-source-gate'
import { sqliteSchemaFingerprint } from '../migrations/sqlite-schema-adapter'
import { inspectM03ReviewCycles, type UnprovableReviewCycle } from '../migrations/m03-review-cycle'
import { SchemaMigrationError } from '../migrations/registry'
import type { DamagedReviewCycle } from '../../src/shared/damaged-review-cycle'
import {
  PORTABLE_TRANSFER_AUTHORITY_PATH,
  createPortableTransferAuthority,
  serializePortableTransferAuthority,
} from './portable-transfer-authority'

const require = createRequire(import.meta.url)
const BetterSqlite = require('better-sqlite3') as typeof import('better-sqlite3')
const HASH = /^[a-f0-9]{64}$/u
const SAFE_ID = /^[\p{L}\p{N}._:@+-]{1,512}$/u
const SAFE_CODE = /^[a-z][a-z0-9_.-]{0,63}$/u
const PROVIDED_DISPOSITIONS = new Set<PortableEntryDisposition>([
  'author-content', 'knowledge-source', 'prompt', 'skill', 'transfer-receipt', 'history-projection',
])
const JSON_NEUTRAL = new Set([
  'blueprint_character_sync_operations.character_sync_input',
  'blueprint_character_sync_operations.completion_receipt',
  'blueprint_commit_operations.character_sync_input',
  'character_identity_approvals.receipt_json',
  'character_relationships.provenance_json',
  'finalized_draft_import_operations.receipt_json',
  'generation_attempts.attempt_json',
  'generation_attempts.usage_receipt_json',
  'generation_roots.action_json',
  'generation_roots.budget_json',
  'generation_runs.binding_json',
  'import_global_fact_operations.receipt_json',
  'import_run_receipts.payload_json',
  'import_run_receipts.effect_receipt_json',
])
const REQUIRED_JSON_PROJECTORS = new Set([
  'drafts.source_dependencies',
  'generation_artifacts.artifact_json',
  'generation_attempts.attempt_json',
  'generation_roots.action_json',
  'generation_roots.budget_json',
  'import_run_sources.display_json',
  'import_runs.source_display_json',
  'recovery_candidates.source_snapshot',
])
/** 导入效果的命名空间与键由运行号和固定字面量拼成，各行互不相同（receipts 表有唯一约束），校验后保留原值。 */
const PRESERVED_SAFE_ID_FIELDS = new Set([
  'import_run_receipts.effect_namespace',
  'import_run_receipts.effect_key',
  'import_runs.effect_namespace',
])
const BLANKED_REDACTED_FIELDS = new Set([
  'blueprint_character_sync_operations.blueprint_commit_payload_hash',
  'blueprint_commit_operations.payload_hash',
  'chapter_deletion_operations.manuscript_error',
  'chapter_deletion_operations.knowledge_error',
  'finalization_outbox.last_error',
  'finalized_draft_import_operations.payload_hash',
  'import_global_fact_operations.payload_hash',
  'import_run_receipts.payload_hash',
  'import_run_sources.source_fingerprint',
  'import_run_sources.legacy_source_fingerprint',
  'import_run_sources.manifest_fingerprint',
  'import_run_sources.last_error',
  'import_runs.source_fingerprint',
  'import_runs.manifest_fingerprint',
  'import_runs.authority_fingerprint',
  'import_runs.legacy_source_fingerprint',
  'import_runs.last_error',
  'post_process_steps.error_msg',
  'recovery_candidates.source_hash',
  'recovery_candidates.failure_reason',
])
export const PORTABLE_CLEARED_TABLES = Object.freeze(['import_legacy_identity_bridge', 'text_metric_versions', 'llm_calls'])

export type PortableRedaction = 'cleared-table' | 'json-projection' | 'json-neutral' | 'safe-id' | 'blank'

export function portableRedactionFor(table: string, field: string): PortableRedaction | undefined {
  const key = `${table}.${field}`
  if (PORTABLE_CLEARED_TABLES.includes(table)) return 'cleared-table'
  if (REQUIRED_JSON_PROJECTORS.has(key)) return 'json-projection'
  if (JSON_NEUTRAL.has(key)) return 'json-neutral'
  if (PRESERVED_SAFE_ID_FIELDS.has(key)) return 'safe-id'
  if (BLANKED_REDACTED_FIELDS.has(key)) return 'blank'
  return undefined
}
const REVIEW_FINGERPRINT_FIELDS = [
  'chapterBriefHash', 'authorGuidanceHash', 'dependencyHash', 'contextSnapshotHash', 'templateHash',
  'skillSnapshotHash', 'modelLeaseRevision', 'policyHash', 'outputContractHash',
] as const
const REVIEW_CONTEXT_FIELDS = [
  'version', 'operation', 'source', 'sourceHash', 'config', 'writingLanguage', 'uiLocale', 'authorInputs',
  'characterStates', 'worldbuilding', 'history', 'blueprints', 'frozenGoals', 'preflightFindings',
  'confirmation', 'recheck', 'predecessor',
] as const
const HISTORY_ID_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  blueprint_character_sync_operations: ['operation_id'],
  blueprint_commit_operations: ['operation_id'],
  chapter_deletion_operations: ['operation_id'],
  character_identity_approvals: ['operation_id'],
  character_relationships: ['relationship_id'],
  drafts: ['id'],
  finalization_outbox: ['finalization_id'],
  finalized_draft_import_operations: ['operation_id'],
  generation_artifacts: ['artifact_id'],
  generation_attempts: ['attempt_id'],
  generation_roots: ['root_action_id'],
  generation_runs: ['run_id'],
  import_effect_ledger: ['run_id', 'stage', 'batch_id'],
  import_global_fact_operations: ['operation_id'],
  import_run_receipts: ['run_id', 'stage', 'batch_id'],
  import_run_sources: ['run_id', 'source_id'],
  import_runs: ['id'],
  llm_calls: ['id'],
  post_process_runs: ['id'],
  post_process_steps: ['id'],
  recovery_candidates: ['candidate_id'],
  review_cycles: ['cycle_id'],
  review_findings: ['cycle_id', 'finding_id'],
})
const HISTORY_STATE_COLUMNS = [
  'status', 'state', 'publication_status', 'manuscript_status', 'knowledge_status', 'revision_status',
] as const

export type ProjectArchiveServiceErrorCode =
  | 'PORTABLE_ASSET_MISSING'
  | 'PORTABLE_ASSET_UNSAFE'
  | 'PORTABLE_CONTEXT_INVALID'
  | 'PORTABLE_EXPORT_AVATAR_DAMAGED'
  | 'PORTABLE_EXPORT_SOURCE_CHANGED'
  | 'PORTABLE_TARGET_INSIDE_SOURCE'
  | 'PORTABLE_UNSAFE_PROJECTION'

export class ProjectArchiveServiceError extends Error {
  constructor(readonly code: ProjectArchiveServiceErrorCode) {
    super(code)
    this.name = 'ProjectArchiveServiceError'
  }
}

/** 快照时读到的大小与 sha。打包按路径重读并比这份 sha，对不上就整次重来。 */
export interface PortableSourceDigest {
  byteSize: number
  sha256: string
}

/** 内容二选一：bytes 是生成的小文件，sourcePath 是作品存储目录里交给 digestFile 算过的文件。 */
export interface PortableProvidedFile {
  id: string
  archivePath: string
  bytes?: Buffer
  sourcePath?: string
  byteSize: number
  sha256: string
  disposition: Exclude<PortableEntryDisposition, 'portable-database' | 'avatar-asset'>
}

export interface PortableAssetSnapshot {
  files: readonly PortableProvidedFile[]
  semanticCounts?: Readonly<Record<string, number>>
  omittedItems?: readonly { id: string; reason: PortableOmissionReason }[]
  transferReceiptIds?: readonly string[]
  historyProjectionIds?: readonly string[]
}

export interface PortableAssetProvider {
  snapshot(input: {
    sourceProjectRoot: string
    sourceDatabasePath: string
    projectSession: Readonly<ProjectSessionContext>
    snapshotGeneration: string
    /** checked 是调用方查过项目根与链接时 lstat 到的身份，打开的文件必须就是它。 */
    digestFile(sourcePath: string, checked: fs.BigIntStats): PortableSourceDigest
  }): PortableAssetSnapshot | Promise<PortableAssetSnapshot>
}

export interface ExportPortableProjectInput {
  sourceProjectRoot: string
  projectSession: ProjectSessionContext
  targetArchivePath: string
  attemptParentPath: string
  assertCurrentContext(context: Readonly<ProjectSessionContext>, sourceProjectRoot: string): boolean | void | Promise<boolean | void>
  assets: PortableAssetProvider
  now?: () => Date
  snapshotGeneration?: string
  /** @internal Deterministic mutation/failure injection. */
  __testHooks?: {
    afterPortableDatabaseCreated?(attemptRoot: string): void
    afterArchiveBuilt?(stagedArchivePath: string): void
  }
}

export interface ExportPortableProjectReceipt {
  originProjectId: string
  snapshotGeneration: string
  targetSha256: string
  targetByteSize: number
  sourceEvidence: {
    schemaVersion: number
    schemaFingerprint: string
    tableCount: number
    fieldCount: number
  }
  entryCount: number
  requiresRuntimeFreezeGuard: true
  /** 验不过、没放进存档的审修循环所在的章（ADR-0029）。 */
  omittedReviewCycles?: readonly DamagedReviewCycle[]
}

interface HistoryProjection {
  projectionId: string
  table: string
  recordId: string
  terminalState: string
  projection: Record<string, unknown>
  projectionHash: string
  excludedFields: string[]
  nonReplayable: true
  originalReceiptVerified: false
}

interface OwnedAttempt {
  root: string
  rootIdentity: fs.BigIntStats
  files: Map<string, fs.BigIntStats>
}

function fail(code: ProjectArchiveServiceErrorCode): never {
  throw new ProjectArchiveServiceError(code)
}

function quote(value: string): string { return `"${value.replaceAll('"', '""')}"` }

function normalizedPath(value: string): string {
  const resolved = path.resolve(value).replace(/^\\\\\?\\/u, '')
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function sameObject(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function safeDirectory(directory: string): void {
  const absolute = path.resolve(directory)
  let cursor = path.parse(absolute).root
  for (const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    let info: fs.Stats
    try { info = fs.lstatSync(cursor) } catch { return fail('PORTABLE_ASSET_UNSAFE') }
    if (!info.isDirectory() || info.isSymbolicLink()
      || normalizedPath(fs.realpathSync.native(cursor)) !== normalizedPath(cursor)) fail('PORTABLE_ASSET_UNSAFE')
  }
}

function regularFile(file: string, missingCode: ProjectArchiveServiceErrorCode): fs.BigIntStats {
  try {
    const absolute = path.resolve(file)
    const info = fs.lstatSync(absolute, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n
      || normalizedPath(fs.realpathSync.native(absolute)) !== normalizedPath(absolute)) fail('PORTABLE_ASSET_UNSAFE')
    return info
  } catch (error) {
    if (error instanceof ProjectArchiveServiceError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail(missingCode)
    fail('PORTABLE_ASSET_UNSAFE')
  }
}

function prepareAttempt(parent: string): OwnedAttempt {
  const root = fs.mkdtempSync(path.join(parent, '.pe-'))
  fs.chmodSync(root, 0o700)
  const rootIdentity = fs.lstatSync(root, { bigint: true })
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()
    || normalizedPath(fs.realpathSync.native(root)) !== normalizedPath(root)) fail('PORTABLE_ASSET_UNSAFE')
  return { root, rootIdentity, files: new Map() }
}

function recordOwnedFile(attempt: OwnedAttempt, file: string): void {
  const absolute = path.resolve(file)
  if (normalizedPath(path.dirname(absolute)) !== normalizedPath(attempt.root)) fail('PORTABLE_ASSET_UNSAFE')
  const info = fs.lstatSync(absolute, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink()
    || normalizedPath(fs.realpathSync.native(absolute)) !== normalizedPath(absolute)) fail('PORTABLE_ASSET_UNSAFE')
  attempt.files.set(absolute, info)
}

function recordOwnedFileIfPresent(attempt: OwnedAttempt, file: string): void {
  try { fs.lstatSync(file) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  recordOwnedFile(attempt, file)
}

function cleanupAttempt(attempt: OwnedAttempt): void {
  for (const [file, identity] of [...attempt.files].reverse()) {
    try {
      const actual = fs.lstatSync(file, { bigint: true })
      if (actual.isFile() && !actual.isSymbolicLink() && sameObject(identity, actual)
        && normalizedPath(fs.realpathSync.native(file)) === normalizedPath(file)) fs.unlinkSync(file)
    } catch { /* Preserve missing, replaced, linked, or otherwise unknown content. */ }
  }
  try {
    const actual = fs.lstatSync(attempt.root, { bigint: true })
    if (actual.isDirectory() && !actual.isSymbolicLink() && sameObject(attempt.rootIdentity, actual)
      && normalizedPath(fs.realpathSync.native(attempt.root)) === normalizedPath(attempt.root)
      && fs.readdirSync(attempt.root).length === 0) fs.rmdirSync(attempt.root)
  } catch { /* Preserve a replaced or non-empty attempt root. */ }
}

function sha256(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex') }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  return JSON.stringify(value)
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') fail('PORTABLE_UNSAFE_PROJECTION')
  try { return JSON.parse(value) }
  catch { return fail('PORTABLE_UNSAFE_PROJECTION') }
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PORTABLE_UNSAFE_PROJECTION')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key))) fail('PORTABLE_UNSAFE_PROJECTION')
  return result
}

/** 旧版导出器把这些列清成了空串，从旧存档恢复的副本带着空串，原样保留。 */
function preservedSafeId(value: unknown): string {
  return value === '' ? '' : safeId(value)
}

function safeId(value: unknown): string {
  const encoded = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof encoded !== 'string' || !SAFE_ID.test(encoded) || /^[a-z]:/iu.test(encoded)) fail('PORTABLE_UNSAFE_PROJECTION')
  return encoded
}

function contentHash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) fail('PORTABLE_UNSAFE_PROJECTION')
  return value
}

function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail('PORTABLE_UNSAFE_PROJECTION')
  return value as number
}

function safeString(value: unknown, maximum = 16 * 1024 * 1024): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum) fail('PORTABLE_UNSAFE_PROJECTION')
  return value
}

function projectSourceDependencies(value: unknown): unknown[] {
  const parsed = parseJson(value)
  if (!Array.isArray(parsed) || parsed.length > 500) fail('PORTABLE_UNSAFE_PROJECTION')
  return parsed.map(item => {
    const dependency = object(item, ['draftId', 'contentHash', 'kind', 'chapterNumber', 'finalizationId'])
    const kind = dependency.kind
    if (!(kind === undefined || kind === 'candidate' || kind === 'finalized' || kind === 'legacy-finalized')) {
      fail('PORTABLE_UNSAFE_PROJECTION')
    }
    const projected: Record<string, unknown> = {
      draftId: safeInteger(dependency.draftId, 1),
      contentHash: contentHash(dependency.contentHash),
    }
    if (kind !== undefined) projected.kind = kind
    if (kind === 'finalized' || kind === 'legacy-finalized') projected.chapterNumber = safeInteger(dependency.chapterNumber, 1)
    if (kind === 'finalized') projected.finalizationId = safeId(dependency.finalizationId)
    if (kind !== 'finalized' && dependency.finalizationId !== undefined) fail('PORTABLE_UNSAFE_PROJECTION')
    return projected
  })
}

function projectRecoverySource(value: unknown): Record<string, unknown> {
  const source = object(parseJson(value), [
    'chapterNumber', 'title', 'role', 'purpose', 'keyEvents', 'characters', 'suspenseHook', 'userGuidance',
  ])
  if (!Array.isArray(source.characters) || source.characters.length > 10_000
    || source.characters.some(item => typeof item !== 'string')) fail('PORTABLE_UNSAFE_PROJECTION')
  const projected: Record<string, unknown> = {
    chapterNumber: safeInteger(source.chapterNumber, 1),
    title: safeString(source.title),
    role: safeString(source.role),
    purpose: safeString(source.purpose),
    keyEvents: safeString(source.keyEvents),
    characters: source.characters.map(item => safeString(item)),
  }
  if (source.suspenseHook !== undefined) projected.suspenseHook = safeString(source.suspenseHook)
  if (source.userGuidance !== undefined) projected.userGuidance = safeString(source.userGuidance)
  return projected
}

function projectReviewFingerprint(value: unknown): Record<string, unknown> {
  const fingerprint = object(value, REVIEW_FINGERPRINT_FIELDS)
  if (Object.keys(fingerprint).length !== REVIEW_FINGERPRINT_FIELDS.length) fail('PORTABLE_UNSAFE_PROJECTION')
  for (const key of REVIEW_FINGERPRINT_FIELDS) contentHash(fingerprint[key])
  return fingerprint
}

function reviewArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) fail('PORTABLE_UNSAFE_PROJECTION')
  return value
}

function reviewTextFields(record: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) if (field in record) safeString(record[field])
}

function reviewIntegerFields(record: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) if (field in record) safeInteger(record[field])
}

function reviewSource(value: unknown): Record<string, unknown> {
  const source = object(value, ['id', 'chapterNumber', 'version', 'status', 'content'])
  if (Object.keys(source).length !== 5) fail('PORTABLE_UNSAFE_PROJECTION')
  reviewIntegerFields(source, ['id', 'chapterNumber', 'version'])
  reviewTextFields(source, ['status', 'content'])
  return source
}

function reviewRecheck(value: unknown): void {
  const recheck = object(value, ['version', 'cycleId', 'comparisonVersion', 'mergedHash', 'findingSetHash', 'findings', 'sourceContent'])
  if (recheck.version !== 1 && recheck.version !== 2) fail('PORTABLE_UNSAFE_PROJECTION')
  reviewTextFields(recheck, ['sourceContent'])
  safeId(recheck.cycleId)
  safeInteger(recheck.comparisonVersion, 1)
  contentHash(recheck.mergedHash)
  contentHash(recheck.findingSetHash)
  for (const value of reviewArray(recheck.findings)) {
    const finding = object(value, ['findingId', 'targetId', 'category', 'kind', 'problem', 'expected',
      'sourceSpan', 'occurrence', 'sourceExcerpt', 'mustShow'])
    reviewTextFields(finding, ['findingId', 'targetId', 'category', 'kind', 'problem', 'expected', 'sourceExcerpt'])
    if (finding.mustShow !== undefined && finding.mustShow !== true) fail('PORTABLE_UNSAFE_PROJECTION')
    if (finding.occurrence !== undefined) safeInteger(finding.occurrence)
    if (finding.sourceSpan !== undefined) {
      const span = object(finding.sourceSpan, ['start', 'end', 'unit'])
      const start = safeInteger(span.start), end = safeInteger(span.end)
      if (end < start || span.unit !== 'utf16-code-unit') fail('PORTABLE_UNSAFE_PROJECTION')
    }
  }
}

function reviewHistoryItem(value: unknown): void {
  const item = object(value, ['draftId', 'chapterNumber', 'chapterTitle', 'content', 'source', 'projection', 'identity'])
  reviewIntegerFields(item, ['draftId', 'chapterNumber'])
  reviewTextFields(item, ['chapterTitle', 'content'])
  if (item.source !== undefined) {
    const source = object(item.source, ['draftId', 'finalizationId', 'chapterNumber', 'contentHash'])
    reviewIntegerFields(source, ['draftId', 'chapterNumber'])
    reviewTextFields(source, ['finalizationId'])
    contentHash(source.contentHash)
  }
  if (item.identity !== undefined) {
    const identity = object(item.identity, ['projectId', 'sourceId', 'revision', 'contentHash', 'provenance'])
    reviewTextFields(identity, ['projectId', 'sourceId', 'provenance'])
    reviewIntegerFields(identity, ['revision'])
    contentHash(identity.contentHash)
  }
  if (item.projection !== undefined) {
    const projection = object(item.projection, ['draftId', 'currentFinalizedDraftId', 'chapterNumber',
      'chapterTitle', 'chapterNotes', 'facts', 'characterStateCandidates', 'source', 'sourceStatus'])
    reviewIntegerFields(projection, ['draftId', 'currentFinalizedDraftId', 'chapterNumber'])
    reviewTextFields(projection, ['chapterTitle', 'chapterNotes', 'sourceStatus'])
    if (projection.source !== undefined) {
      const source = object(projection.source, ['draftId', 'finalizationId', 'chapterNumber', 'contentHash'])
      reviewIntegerFields(source, ['draftId', 'chapterNumber'])
      reviewTextFields(source, ['finalizationId'])
      contentHash(source.contentHash)
    }
    if (projection.facts !== undefined) for (const factValue of reviewArray(projection.facts)) {
      const fact = object(factValue, ['category', 'entities', 'statement', 'sourceChapter', 'evidence', 'characterRefs'])
      reviewTextFields(fact, ['category', 'statement', 'evidence'])
      reviewIntegerFields(fact, ['sourceChapter'])
      reviewArray(fact.entities).forEach(item => safeString(item))
      if (fact.characterRefs !== undefined) for (const refValue of reviewArray(fact.characterRefs)) {
        const ref = object(refValue, ['characterId', 'displayNameSnapshot'])
        reviewTextFields(ref, ['characterId', 'displayNameSnapshot'])
      }
    }
    if (projection.characterStateCandidates !== undefined) {
      for (const candidateValue of reviewArray(projection.characterStateCandidates)) {
        const candidate = object(candidateValue, ['characterId', 'characterName', 'field', 'value', 'evidence',
          'selectionKey', 'displayName', 'rawValue', 'reason', 'candidateKey', 'source',
          'expectedFieldRevision', 'expectedFieldValueHash'])
        reviewTextFields(candidate, ['characterId', 'characterName', 'field', 'value', 'selectionKey',
          'displayName', 'reason', 'candidateKey', 'expectedFieldValueHash'])
        if (candidate.rawValue !== undefined) {
          if (typeof candidate.rawValue === 'string') safeString(candidate.rawValue)
          else {
            const update = object(candidate.rawValue, ['characterId', 'currentState', 'evidence'])
            safeId(update.characterId)
            const state = object(update.currentState, CHARACTER_STATE_TEXT_FIELDS)
            reviewTextFields(state, CHARACTER_STATE_TEXT_FIELDS)
            const evidence = object(update.evidence, ['start', 'end', 'text'])
            const start = safeInteger(evidence.start), end = safeInteger(evidence.end)
            if (end <= start || Object.keys(state).length === 0) fail('PORTABLE_UNSAFE_PROJECTION')
            safeString(evidence.text)
          }
        }
        reviewIntegerFields(candidate, ['expectedFieldRevision'])
        if (candidate.evidence !== undefined) {
          const evidence = object(candidate.evidence, ['start', 'end', 'text'])
          reviewIntegerFields(evidence, ['start', 'end'])
          reviewTextFields(evidence, ['text'])
        }
        if (candidate.source !== undefined) {
          const source = object(candidate.source, ['draftId', 'finalizationId', 'chapterNumber', 'contentHash'])
          reviewIntegerFields(source, ['draftId', 'chapterNumber'])
          reviewTextFields(source, ['finalizationId'])
          contentHash(source.contentHash)
        }
      }
    }
  }
}

function assertReviewContext(value: unknown): Record<string, unknown> {
  const context = object(value, REVIEW_CONTEXT_FIELDS)
  if (context.version !== 1 || !['review-chapter', 'refine-draft', 'refine-from-review'].includes(String(context.operation))) {
    fail('PORTABLE_UNSAFE_PROJECTION')
  }
  reviewSource(context.source)
  contentHash(context.sourceHash)
  const config = object(context.config, ['writingLanguage', 'creativeStrategy',
    'narrativeThreadDormantChapterThreshold', 'genre', 'subGenre', 'targetAudience', 'totalChapters',
    'wordsPerChapter', 'plotStructure', 'narrativePOV', 'coreOutline', 'worldSetting', 'goldenFinger',
    'protagonistProfile', 'globalGuidance', 'writingStyle', 'referenceWorks'])
  reviewTextFields(config, ['writingLanguage', 'creativeStrategy', 'genre', 'subGenre', 'targetAudience',
    'plotStructure', 'narrativePOV', 'coreOutline', 'worldSetting', 'goldenFinger', 'protagonistProfile',
    'globalGuidance', 'writingStyle', 'referenceWorks'])
  reviewIntegerFields(config, ['narrativeThreadDormantChapterThreshold', 'totalChapters', 'wordsPerChapter'])
  reviewTextFields(context, ['writingLanguage', 'uiLocale', 'characterStates', 'worldbuilding'])
  for (const value of reviewArray(context.authorInputs)) {
    const input = object(value, ['id', 'text'])
    reviewTextFields(input, ['id', 'text'])
  }
  reviewArray(context.history).forEach(reviewHistoryItem)
  if (context.predecessor !== undefined) reviewHistoryItem(context.predecessor)
  for (const value of reviewArray(context.blueprints)) {
    const blueprint = object(value, ['chapterNumber', 'title', 'role', 'purpose', 'keyEvents',
      'characters', 'suspenseHook', 'userGuidance', 'notes'])
    reviewIntegerFields(blueprint, ['chapterNumber'])
    reviewTextFields(blueprint, ['title', 'role', 'purpose', 'keyEvents', 'suspenseHook', 'userGuidance', 'notes'])
    reviewArray(blueprint.characters).forEach(item => safeString(item))
  }
  const goals = object(context.frozenGoals, ['chapterNumber', 'coverage', 'items'])
  reviewIntegerFields(goals, ['chapterNumber'])
  reviewTextFields(goals, ['coverage'])
  for (const value of reviewArray(goals.items)) reviewTextFields(object(value, ['id', 'text']), ['id', 'text'])
  for (const value of reviewArray(context.preflightFindings)) {
    const finding = object(value, ['stableFactKey', 'severity', 'sourceChapter', 'evidence', 'issue', 'suggestion'])
    reviewTextFields(finding, ['stableFactKey', 'severity', 'evidence'])
    reviewIntegerFields(finding, ['sourceChapter'])
    for (const field of ['issue', 'suggestion']) reviewTextFields(object(finding[field], ['zhCN', 'enUS']), ['zhCN', 'enUS'])
  }
  if (context.confirmation !== undefined) {
    const confirmation = object(context.confirmation, ['reviewSourceId', 'content', 'originalReviewContentHash', 'snapshot'])
    reviewIntegerFields(confirmation, ['reviewSourceId'])
    reviewTextFields(confirmation, ['content'])
    contentHash(confirmation.originalReviewContentHash)
    const snapshot = object(confirmation.snapshot, ['kind', 'schemaVersion', 'cycleId', 'sourceReviewId',
      'sourceDraft', 'summary', 'authorGuidance', 'items', 'goalReview'])
    reviewTextFields(snapshot, ['kind', 'cycleId', 'summary', 'authorGuidance'])
    reviewIntegerFields(snapshot, ['schemaVersion', 'sourceReviewId'])
    if (snapshot.sourceDraft !== undefined) reviewSource(snapshot.sourceDraft)
    for (const value of reviewArray(snapshot.items)) {
      const item = object(value, ['category', 'severity', 'description', 'quote', 'stableFactKey',
        'sourceChapter', 'goalId', 'findingId', 'decision', 'origin'])
      reviewTextFields(item, ['category', 'severity', 'description', 'quote', 'stableFactKey',
        'goalId', 'findingId', 'decision', 'origin'])
      reviewIntegerFields(item, ['sourceChapter'])
    }
    if (snapshot.goalReview !== undefined) {
      const goalReview = object(snapshot.goalReview, ['version', 'chapterNumber', 'coverage', 'items'])
      reviewIntegerFields(goalReview, ['version', 'chapterNumber'])
      reviewTextFields(goalReview, ['coverage'])
      for (const value of reviewArray(goalReview.items)) {
        const item = object(value, ['id', 'text', 'status', 'description', 'evidence', 'threadOutcome'])
        reviewTextFields(item, ['id', 'text', 'status', 'description', 'threadOutcome'])
        if (!validThreadOutcome(item)) fail('PORTABLE_UNSAFE_PROJECTION')
        for (const evidenceValue of reviewArray(item.evidence)) {
          const evidence = object(evidenceValue, ['quote', 'start', 'end'])
          reviewTextFields(evidence, ['quote'])
          reviewIntegerFields(evidence, ['start', 'end'])
        }
      }
    }
  }
  if (context.recheck !== undefined) reviewRecheck(context.recheck)
  return context
}

function projectReviewBinding(value: unknown): Record<string, unknown> {
  const stored = parseJson(value)
  const frozen = stored && typeof stored === 'object'
    ? Object.fromEntries(Object.entries(stored).filter(([key]) => !key.startsWith('$'))) : stored
  const binding = object(frozen, [
    'projectId', 'epoch', 'fingerprint', 'contextSnapshotId', 'sourceManifest', 'sourceRefs',
  ])
  const projected: Record<string, unknown> = {
    projectId: safeId(binding.projectId), epoch: safeId(binding.epoch),
    fingerprint: projectReviewFingerprint(binding.fingerprint),
  }
  const manifest = binding.sourceManifest as Record<string, unknown> | undefined
  if (manifest?.reviewRevisionContext === undefined) return projected
  const context = assertReviewContext(manifest.reviewRevisionContext)
  const encoded = JSON.stringify(context)
  const source = object(context.source, ['id', 'chapterNumber', 'version', 'status', 'content'])
  if (Buffer.byteLength(encoded, 'utf8') > 16 * 1024 * 1024
    || contentHash(context.sourceHash) !== sha256(safeString(source.content))
    || contentHash(manifest.reviewRevisionContextHash) !== sha256(encoded)
    || JSON.stringify(manifest.authorInputs) !== JSON.stringify([{ id: 'review-revision-context', text: encoded }])) {
    fail('PORTABLE_UNSAFE_PROJECTION')
  }
  projected.sourceManifest = { operation: safeId(manifest.operation), reviewRevisionContext: context,
    reviewRevisionContextHash: manifest.reviewRevisionContextHash, authorInputs: manifest.authorInputs }
  return projected
}

function projectReviewArtifactRef(value: unknown): Record<string, unknown> {
  const ref = object(value, ['artifactId', 'revision', 'textHash'])
  return { artifactId: safeId(ref.artifactId), revision: safeInteger(ref.revision),
    textHash: contentHash(ref.textHash) }
}

function projectReviewRecheckReceipt(value: unknown): Record<string, unknown> {
  const receipt = object(value, ['version', 'cycleId', 'comparisonVersion', 'mergedHash', 'findingSetHash', 'findings'])
  if (Object.keys(receipt).length !== 6 || (receipt.version !== 1 && receipt.version !== 2)) fail('PORTABLE_UNSAFE_PROJECTION')
  return { version: receipt.version, cycleId: safeId(receipt.cycleId),
    comparisonVersion: safeInteger(receipt.comparisonVersion, 1), mergedHash: contentHash(receipt.mergedHash),
    findingSetHash: contentHash(receipt.findingSetHash), findings: reviewArray(receipt.findings).map(value => {
      const finding = object(value, ['findingId', 'targetId', 'reviewItemIndex', 'evidenceHash', 'resolved'])
      if (Object.keys(finding).length !== 5 || typeof finding.resolved !== 'boolean') fail('PORTABLE_UNSAFE_PROJECTION')
      return { findingId: safeId(finding.findingId), targetId: safeId(finding.targetId),
        reviewItemIndex: safeInteger(finding.reviewItemIndex), evidenceHash: contentHash(finding.evidenceHash),
        resolved: finding.resolved }
    }) }
}

function projectReviewSegment(usage: Record<string, unknown>): Record<string, unknown> {
  const identity = object(usage.artifactIdentity, ['artifactId', 'epoch', 'fingerprint'])
  // 没结算或请求失败的尝试没有结束原因，只带身份。
  const result: Record<string, unknown> = usage.result === undefined ? {} : object(usage.result, ['usage', 'finishReason', 'failureCode', 'diagnostics'])
  return {
    artifactIdentity: { artifactId: safeId(identity.artifactId), epoch: safeId(identity.epoch),
      fingerprint: projectReviewFingerprint(identity.fingerprint) },
    ...(result.finishReason == null ? {} : { result: { finishReason: safeId(result.finishReason) } }),
  }
}

function projectReviewUsage(value: unknown): Record<string, unknown> | null {
  if (value === null) return null
  const usage = parseJson(value) as Record<string, unknown>
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null
  if (!usage.reviewRevisionEffect) {
    if (!usage.artifactIdentity) return null
    // 修稿续写时效果收据只落在最后一段，前面各段只有产物身份和结束原因；循环校验会逐段读这两项，所以不能丢。
    // 投影不过的就不带：没被组合用到的尝试本来就不是证据，被用到的会在副本最后的从严校验里被拦下。
    try { return projectReviewSegment(usage) }
    catch (error) {
      if (error instanceof ProjectArchiveServiceError && error.code === 'PORTABLE_UNSAFE_PROJECTION') return null
      throw error
    }
  }
  const segment = projectReviewSegment(usage)
  const effect = object(usage.reviewRevisionEffect, [
    'kind', 'id', 'index', 'contentHash', 'contextHash', 'artifact', 'compositionHash', 'reportVersion',
  ])
  if (effect.kind !== 'review' && effect.kind !== 'revision') fail('PORTABLE_UNSAFE_PROJECTION')
  if (effect.reportVersion !== undefined && (effect.reportVersion !== 2 || effect.kind !== 'review')) fail('PORTABLE_UNSAFE_PROJECTION')
  const projected: Record<string, unknown> = {
    ...segment,
    reviewRevisionEffect: { kind: effect.kind, id: safeInteger(effect.id, 1), index: safeInteger(effect.index, 1),
      contentHash: contentHash(effect.contentHash), contextHash: contentHash(effect.contextHash),
      artifact: projectReviewArtifactRef(effect.artifact),
      ...(effect.reportVersion === 2 ? { reportVersion: 2 } : {}),
      ...(effect.kind === 'revision' ? { compositionHash: contentHash(effect.compositionHash) } : {}) },
  }
  if (usage.visibleComposition !== undefined) {
    const composition = object(usage.visibleComposition, ['algorithm', 'textHash', 'artifactIds', 'sources'])
    if (composition.algorithm !== 'visible-append-v1' || !Array.isArray(composition.artifactIds)
      || !Array.isArray(composition.sources) || composition.artifactIds.length > 32
      || composition.artifactIds.length !== composition.sources.length) fail('PORTABLE_UNSAFE_PROJECTION')
    projected.visibleComposition = { algorithm: composition.algorithm, textHash: contentHash(composition.textHash),
      artifactIds: composition.artifactIds.map(safeId), sources: composition.sources.map(projectReviewArtifactRef) }
  }
  if (usage.reviewCycleRecheck !== undefined) {
    projected.reviewCycleRecheck = projectReviewRecheckReceipt(usage.reviewCycleRecheck)
  }
  return projected
}

function projectArtifact(value: unknown, reviewProof = false): Record<string, unknown> {
  const artifact = object(parseJson(value), [
    'artifactId', 'attemptId', 'rootActionId', 'projectId', 'epoch', 'fingerprint', 'revision', 'text', 'textHash',
  ])
  return {
    artifactId: safeId(artifact.artifactId),
    attemptId: safeId(artifact.attemptId),
    rootActionId: safeId(artifact.rootActionId),
    revision: safeInteger(artifact.revision),
    text: safeString(artifact.text),
    textHash: contentHash(artifact.textHash),
    ...(reviewProof ? { projectId: safeId(artifact.projectId), epoch: safeId(artifact.epoch),
      fingerprint: projectReviewFingerprint(artifact.fingerprint) } : {}),
  }
}

function projectGenerationAttempt(value: unknown): Record<string, unknown> {
  const attempt = object(parseJson(value), [
    'attemptId', 'reservationId', 'rootActionId', 'status', 'reservedTokens', 'requestedOutputTokens', 'actualTokens',
  ])
  const status = safeString(attempt.status, 64)
  if (!['reserved', 'dispatch-marked', 'settled', 'unknown', 'cancelled-before-dispatch'].includes(status)) {
    fail('PORTABLE_UNSAFE_PROJECTION')
  }
  const projected: Record<string, unknown> = {
    attemptId: safeId(attempt.attemptId),
    rootActionId: safeId(attempt.rootActionId),
    status,
    reservedTokens: safeInteger(attempt.reservedTokens, 1),
    requestedOutputTokens: safeInteger(attempt.requestedOutputTokens, 1),
  }
  if (attempt.actualTokens !== undefined) projected.actualTokens = safeInteger(attempt.actualTokens)
  return projected
}

function projectGenerationAction(value: unknown, reviewProof = false): Record<string, unknown> {
  const action = object(parseJson(value), [
    'projectId', 'epoch', 'operation', 'uiActionNonce', 'frozenInputHash', 'rootActionId', 'status',
    'secretRef', 'credential', 'path', 'grantId', 'apiKey', 'token',
  ])
  const status = safeString(action.status, 64)
  if (!['active', 'paused', 'cancelled', 'sealed'].includes(status)) fail('PORTABLE_UNSAFE_PROJECTION')
  return { rootActionId: safeId(action.rootActionId), operation: safeId(action.operation), status,
    ...(reviewProof ? { projectId: safeId(action.projectId), epoch: safeId(action.epoch) } : {}) }
}

function projectGenerationBudget(value: unknown): Record<string, unknown> {
  const budget = object(parseJson(value), [
    'maxPhysicalRequests', 'maxTokenLiability', 'maxOutputPerRequest', 'maxActiveElapsedMs',
  ])
  return {
    maxPhysicalRequests: safeInteger(budget.maxPhysicalRequests, 1),
    maxTokenLiability: safeInteger(budget.maxTokenLiability, 1),
    maxOutputPerRequest: safeInteger(budget.maxOutputPerRequest, 1),
    maxActiveElapsedMs: safeInteger(budget.maxActiveElapsedMs, 1),
  }
}

function projectDisplay(value: unknown, many: boolean): unknown {
  const parsed = parseJson(value)
  const values = many ? parsed : [parsed]
  if (!Array.isArray(values) || values.length > 256) fail('PORTABLE_UNSAFE_PROJECTION')
  const projected = values.map(item => {
    const display = object(item, ['displayName', 'mediaType', 'size'])
    const displayName = safeString(display.displayName, 1024)
    const mediaType = safeString(display.mediaType, 255)
    if (path.isAbsolute(displayName) || displayName.includes('/') || displayName.includes('\\')
      || !/^[\w.+-]+\/[\w.+-]+$/u.test(mediaType)) fail('PORTABLE_UNSAFE_PROJECTION')
    return { displayName, mediaType, size: safeInteger(display.size) }
  })
  return many ? projected : projected[0]
}

function requiredProjection(key: string, value: unknown): unknown {
  switch (key) {
    case 'drafts.source_dependencies': return projectSourceDependencies(value)
    case 'generation_artifacts.artifact_json': return projectArtifact(value)
    case 'generation_attempts.attempt_json': return projectGenerationAttempt(value)
    case 'generation_roots.action_json': return projectGenerationAction(value)
    case 'generation_roots.budget_json': return projectGenerationBudget(value)
    case 'import_run_sources.display_json': return projectDisplay(value, false)
    case 'import_runs.source_display_json': return projectDisplay(value, true)
    case 'recovery_candidates.source_snapshot': return projectRecoverySource(value)
    default: return fail('PORTABLE_UNSAFE_PROJECTION')
  }
}

function neutralValue(key: string, column: { type: string; notnull: number }, value: unknown,
  reviewProof = false): unknown {
  if (reviewProof) {
    if (key === 'generation_roots.action_json') return JSON.stringify(projectGenerationAction(value, true))
    if (key === 'generation_runs.binding_json') return JSON.stringify(projectReviewBinding(value))
    if (key === 'generation_attempts.usage_receipt_json') {
      const usage = projectReviewUsage(value)
      return usage === null ? null : JSON.stringify(usage)
    }
    if (key === 'generation_artifacts.artifact_json') return JSON.stringify(projectArtifact(value, true))
  }
  if (REQUIRED_JSON_PROJECTORS.has(key)) return JSON.stringify(requiredProjection(key, value))
  if (JSON_NEUTRAL.has(key)) {
    if (value !== null) parseJson(value)
    return key === 'blueprint_character_sync_operations.completion_receipt'
      || key === 'generation_attempts.usage_receipt_json'
      || key === 'import_run_receipts.effect_receipt_json' ? null : '{}'
  }
  if (PRESERVED_SAFE_ID_FIELDS.has(key)) return preservedSafeId(value)
  if (!column.notnull) return null
  return /INT|REAL|NUM|DEC|BOOL/u.test(column.type.toUpperCase()) ? 0 : ''
}

function recordId(table: string, row: Record<string, unknown>, rowid: string): string {
  const fields = HISTORY_ID_COLUMNS[table] ?? []
  if (!fields.length) return `${table}:${rowid}`
  return fields.map(field => safeId(row[field])).join(':')
}

function terminalState(row: Record<string, unknown>): string {
  const value = HISTORY_STATE_COLUMNS.map(field => row[field]).find(item => typeof item === 'string')
  if (typeof value === 'string' && SAFE_CODE.test(value)) return value
  if (typeof row.attempt_json === 'string') {
    const attempt = projectGenerationAttempt(row.attempt_json)
    if (typeof attempt.status === 'string') return attempt.status
  }
  if (typeof row.action_json === 'string') {
    const action = projectGenerationAction(row.action_json)
    if (typeof action.status === 'string') return action.status
  }
  return 'historical'
}

function projectionForRow(
  table: string,
  row: Record<string, unknown>,
  columns: readonly { name: string; type: string; notnull: number }[],
): { projection: Record<string, unknown>; excludedFields: string[] } {
  const projection: Record<string, unknown> = {}
  const excludedFields: string[] = []
  for (const column of columns) {
    const key = `${table}.${column.name}`
    const policy = getPortableFieldPolicy(table, column.name)
    if (policy.disposition !== 'redacted-projection') continue
    if (REQUIRED_JSON_PROJECTORS.has(key)) projection[column.name] = requiredProjection(key, row[column.name])
    else if (PRESERVED_SAFE_ID_FIELDS.has(key)) projection[column.name] = preservedSafeId(row[column.name])
    else excludedFields.push(column.name)
  }
  return { projection, excludedFields }
}

/** 未审稿件的审稿目标要读写稿运行冻结的线索任务（见 review-revision-context.ts 的 draftThreadTasks），导出时别把这两处一并清空。 */
function draftThreadTaskProofs(db: InstanceType<typeof BetterSqlite>, reviewRoots: ReadonlySet<string>): {
  receipts: Map<string, string>; bindings: Map<string, string>
} {
  const rows = db.prepare(`SELECT a.attempt_id,a.run_id,a.root_action_id,r.binding_json,
      json_extract(a.usage_receipt_json,'$.draftCommit.id') AS draft_id,
      json_extract(a.usage_receipt_json,'$.draftCommit.chapterNumber') AS chapter_number,
      json_type(a.usage_receipt_json,'$.draftCommit.id') AS draft_id_type,
      json_type(a.usage_receipt_json,'$.draftCommit.chapterNumber') AS chapter_number_type
    FROM generation_attempts a JOIN generation_runs r ON r.run_id=a.run_id
    WHERE json_valid(a.usage_receipt_json) AND json_extract(a.usage_receipt_json,'$.draftCommit.id') IS NOT NULL`).all() as Array<{
    attempt_id: string; run_id: string; root_action_id: string; binding_json: string; draft_id: unknown; chapter_number: unknown
    draft_id_type: string; chapter_number_type: string | null }>
  const receipts = new Map<string, string>(), bindings = new Map<string, string>()
  for (const row of rows) {
    if (reviewRoots.has(row.root_action_id)) continue
    const tasks = writtenChapterThreadTasks(row.binding_json)
    if (!tasks || row.draft_id_type !== 'integer' || row.chapter_number_type !== 'integer'
      || !Number.isSafeInteger(row.draft_id) || !Number.isSafeInteger(row.chapter_number)) {
      console.warn('[portable-export] 写稿记录里的线索任务读不出，这份稿的线索任务不随副本带走', { draftId: row.draft_id })
      continue
    }
    if (!tasks.length) continue
    receipts.set(row.attempt_id, JSON.stringify({ draftCommit: { id: row.draft_id, chapterNumber: row.chapter_number } }))
    bindings.set(row.run_id, JSON.stringify({ sourceManifest: {
      authorInputs: [{ id: 'draft:chapter-info', text: JSON.stringify({ threadTasks: tasks }) }] } }))
  }
  return { receipts, bindings }
}

/**
 * Shared C17 copy-only history projection. Call only on an isolated target staging DB.
 * omitReviewCycles：导出时验不过的审修循环。按根处理，与审修循环的校验同一单位：这些循环所在的根下的全部循环，投影前连同意见与合并快照从副本里删掉；
 * 最后的校验仍从严，证明存档里没有坏循环。删掉以后根仍过不了投影，就带着这个根的定位报 MIGRATION_VERIFICATION_FAILED（指不出章节时定位不带章节）；其他失败原样抛出。
 * 返回的 omittedReviewCycles 每个删掉的根一项，一根下有多条循环时不带章节。
 * verifiedSchema：调用方已对字节相同的库跑过 assertPortableExportSource 时传它的结果，这里不再重验。
 */
export function sanitizePortableDatabase(databasePath: string, options: {
  omitReviewCycles?: ReadonlyMap<string, DamagedReviewCycle>
  verifiedSchema?: ReturnType<typeof assertPortableSourceSchema>
} = {}): {
  history: HistoryProjection[]
  tableCounts: Record<string, number>
  omittedReviewCycles: DamagedReviewCycle[]
} {
  const db = new BetterSqlite(databasePath, { fileMustExist: true })
  try {
    db.pragma('foreign_keys = ON')
    db.pragma('secure_delete = ON')
    const schemaVersion = PORTABLE_READABLE_SOURCE_SCHEMA_VERSIONS.find(version => version === db.pragma('user_version', { simple: true }))
    if (schemaVersion === undefined) throw new Error('PORTABLE_SCHEMA_UNSUPPORTED')
    const omitted = options.omitReviewCycles ?? new Map<string, DamagedReviewCycle>()
    const sourceSchema = options.verifiedSchema ?? assertPortableSourceSchema(db, schemaVersion, () => new Set(omitted.keys()))
    // 必须在算 reviewRoots 之前删，删掉后这条根才会按普通根投影。验不过的循环自己的链接不可信，只取它的根。
    const omittedRoots = new Map<string, DamagedReviewCycle>()
    if (omitted.size) {
      const rootOf = db.prepare('SELECT root_action_id FROM review_cycles WHERE cycle_id=?').pluck()
      const cyclesOn = db.prepare('SELECT COUNT(*) FROM review_cycles WHERE root_action_id=?').pluck()
      for (const [cycleId, location] of omitted) {
        const root = rootOf.get(cycleId) as string
        omittedRoots.set(root, cyclesOn.get(root) === 1 ? location : { chapterNumber: null, chapterTitle: '', inTrash: false })
      }
      const omit = db.prepare('DELETE FROM review_cycles WHERE root_action_id=?')
      db.transaction(() => { for (const root of omittedRoots.keys()) omit.run(root) })()
    }
    const avatarRows = readPortableCharacterAvatarRows(db)
    const reviewRoots = new Set((db.prepare('SELECT root_action_id FROM review_cycles').all() as Array<{
      root_action_id: string }>).map(row => row.root_action_id))
    // 对不上根的产物不归章，也不按审稿证据投影。
    const artifactRoots = new Map((db.prepare(`SELECT a.artifact_id,t.root_action_id FROM generation_artifacts a
      JOIN generation_attempts t ON t.attempt_id=a.attempt_id AND t.run_id=a.run_id
      JOIN generation_runs r ON r.run_id=a.run_id AND r.root_action_id=t.root_action_id`).all() as Array<{
      artifact_id: string; root_action_id: string }>).map(row => [row.artifact_id, row.root_action_id]))
    const draftProofs = draftThreadTaskProofs(db, reviewRoots)
    for (const row of avatarRows) {
      if ('recordId' in row) safeId(row.recordId)
      if ('characterId' in row) safeId(row.characterId)
      if ('candidateCharacterIds' in row) row.candidateCharacterIds.forEach(safeId)
      if ('sourceReference' in row) {
        const provenance = /^(?:character-delete|runtime-replace|runtime-remove):(.+)$/u.exec(row.sourceReference)
        if (provenance) safeId(provenance[1])
        else portablePathKey(row.sourceReference)
      }
      if ('sourceRelativePath' in row) portablePathKey(row.sourceRelativePath)
      if ('relativePath' in row) portablePathKey(row.relativePath)
    }
    const history: HistoryProjection[] = []
    const tableCounts: Record<string, number> = {}
    db.transaction(() => {
      for (const table of PORTABLE_CLEARED_TABLES) db.prepare(`DELETE FROM ${quote(table)}`).run()
      db.prepare("UPDATE character_avatar_assets SET source_reference='' ").run()
      const tables = db.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>
      let accountedFields = 0
      for (const { name: physical } of tables) {
        const table = logicalTableName(physical)
        const columns = db.prepare(`PRAGMA table_info(${quote(physical)})`).all() as Array<{
          name: string; type: string; notnull: number
        }>
        accountedFields += columns.length
        const policies = columns.map(column => getPortableFieldPolicy(table, column.name))
        if (columns.some((column, index) => policies[index]!.disposition === 'redacted-projection'
          && !portableRedactionFor(table, column.name))) fail('PORTABLE_UNSAFE_PROJECTION')
        const hasProjection = policies.some(policy => policy.disposition === 'redacted-projection')
        const hasHistory = policies.some(policy => policy.disposition === 'historical-nonreplayable')
        const rows = db.prepare(`SELECT CAST(rowid AS TEXT) AS __portable_rowid__, * FROM ${quote(physical)}`).all() as Array<Record<string, unknown>>
        tableCounts[`table.${table}`] = rows.length
        const updates = columns.filter((_column, index) => {
          const disposition = policies[index]!.disposition
          return disposition === 'redacted-projection' || disposition === 'exclude-machine-authority'
        })
        const update = updates.length
          ? db.prepare(`UPDATE ${quote(physical)} SET ${updates.map(column => `${quote(column.name)}=?`).join(',')} WHERE rowid=?`)
          : null
        for (const row of rows) {
          const root = table === 'generation_artifacts' ? artifactRoots.get(String(row.artifact_id)) : String(row.root_action_id)
          const reviewProof = root !== undefined && reviewRoots.has(root)
          try {
            if (hasProjection || hasHistory) {
              const safe = projectionForRow(table, row, columns)
              const id = recordId(table, row, String(row.__portable_rowid__))
              const projectionId = `history:${table}:${id}`
              history.push({
                projectionId,
                table,
                recordId: id,
                terminalState: terminalState(row),
                projection: safe.projection,
                projectionHash: sha256(stableJson(safe.projection)),
                excludedFields: safe.excludedFields,
                nonReplayable: true,
                originalReceiptVerified: false,
              })
            }
            const draftProof = table === 'generation_attempts' ? draftProofs.receipts.get(String(row.attempt_id))
              : table === 'generation_runs' ? draftProofs.bindings.get(String(row.run_id)) : undefined
            const changed = update?.run(...updates.map(column => {
              const key = `${table}.${column.name}`
              if (draftProof !== undefined && (key === 'generation_attempts.usage_receipt_json' || key === 'generation_runs.binding_json')) return draftProof
              return neutralValue(key, column, row[column.name], reviewProof)
            }), BigInt(String(row.__portable_rowid__))).changes
            if (changed !== undefined && changed !== 1) throw new Error('PORTABLE_REDACTION_MISSED_ROW')
          } catch (error) {
            const location = root === undefined ? undefined : omittedRoots.get(root)
            if (error instanceof ProjectArchiveServiceError && error.code === 'PORTABLE_UNSAFE_PROJECTION' && location)
              throw new SchemaMigrationError('MIGRATION_VERIFICATION_FAILED', location)
            throw error
          }
          for (const [index, column] of columns.entries()) {
            if (policies[index]!.disposition !== 'validated-relative') continue
            const value = row[column.name]
            if (typeof value !== 'string') fail('PORTABLE_UNSAFE_PROJECTION')
            portablePathKey(value)
          }
        }
      }
      if (tables.length !== sourceSchema.tables || accountedFields !== sourceSchema.fields) fail('PORTABLE_UNSAFE_PROJECTION')
    }).immediate()
    db.exec('VACUUM')
    db.pragma('wal_checkpoint(TRUNCATE)')
    assertPortableSourceSchema(db, schemaVersion)
    return { history, tableCounts, omittedReviewCycles: [...omittedRoots.values()] }
  } finally { db.close() }
}

/** 先建文件并登记再写：写到一半失败（如磁盘满），清理也认得它。 */
function writeOwnedFile(attempt: OwnedAttempt, file: string, bytes: Buffer): void {
  const descriptor = fs.openSync(file, 'wx', 0o600)
  try {
    recordOwnedFile(attempt, file)
    fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor)
  } finally { fs.closeSync(descriptor) }
}

const DIGEST_CHUNK_BYTES = 1024 * 1024

function sourceChangedDuringExport(): never {
  throw new PortableProjectArchiveError('PORTABLE_ARCHIVE_SOURCE_CHANGED')
}

/** 打开后再查路径上没有链接、路径指向的仍是打开的这个文件：查过之后父目录被换成联接也拦得下。 */
function digestCheckedFile(sourcePath: string, checked: fs.BigIntStats): PortableSourceDigest {
  const source = fs.openSync(sourcePath, 'r')
  try {
    const opened = fs.fstatSync(source, { bigint: true })
    if (!sameObject(opened, checked)) sourceChangedDuringExport()
    if (opened.nlink !== 1n) fail('PORTABLE_ASSET_UNSAFE')
    safeDirectory(path.dirname(sourcePath))
    if (!sameObject(fs.lstatSync(sourcePath, { bigint: true }), opened)) sourceChangedDuringExport()
    if (opened.size > BigInt(DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxEntryBytes)) throw new PortableProjectArchiveError('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
    const size = Number(opened.size)
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(DIGEST_CHUNK_BYTES)
    let byteSize = 0
    while (byteSize < size) {
      const read = fs.readSync(source, buffer, 0, Math.min(buffer.length, size - byteSize), null)
      if (read === 0) break
      digest.update(buffer.subarray(0, read))
      byteSize += read
    }
    if (byteSize !== size || fs.readSync(source, buffer, 0, 1, null) > 0) sourceChangedDuringExport()
    return { byteSize, sha256: digest.digest('hex') }
  } finally { fs.closeSync(source) }
}

/** 字节与声明的大小、sha 对不上时，打包逐文件流式核对会拒绝，这里只查元数据。 */
function verifyFile(file: PortableProvidedFile, projectStorageRoot: string): void {
  const content = file.sourcePath === undefined
    ? Buffer.isBuffer(file.bytes) && file.bytes.length === file.byteSize
    : file.bytes === undefined && contained(projectStorageRoot, path.resolve(file.sourcePath))
  if (!file.id || !PROVIDED_DISPOSITIONS.has(file.disposition) || !content || !HASH.test(file.sha256)) fail('PORTABLE_ASSET_UNSAFE')
  portablePathKey(file.archivePath)
}

/** 打包器查过之后、打开之前资料被删，它报的是原始 ENOENT。 */
function missingSource(error: unknown, sourcePaths: Iterable<string>): boolean {
  const missing = (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? (error as NodeJS.ErrnoException).path : undefined
  if (!missing) return false
  const resolved = normalizedPath(path.resolve(missing))
  for (const sourcePath of sourcePaths) if (normalizedPath(path.resolve(sourcePath)) === resolved) return true
  return false
}

/** 打包器不查硬链接，这里补上。快照后被删掉的算资料有改动。 */
function assertSourceStillOwned(sourcePath: string): void {
  const info = fs.lstatSync(sourcePath, { bigint: true, throwIfNoEntry: false })
  if (!info) sourceChangedDuringExport()
  if (info.nlink !== 1n) throw new PortableProjectArchiveError('PORTABLE_ARCHIVE_SOURCE_UNSAFE')
}

/** 只包住资料阶段的错。库一侧的错不包，所以永远不会被重来。 */
class AssetPhaseFailure extends Error {
  constructor(readonly failure: unknown) { super('PORTABLE_ASSET_PHASE_FAILED') }
}

async function assetPhase<T>(work: () => T | Promise<T>): Promise<T> {
  try { return await work() }
  catch (error) { throw new AssetPhaseFailure(error) }
}

/** 资料阶段里也不重来：重来也不会变。 */
const NOT_RETRIED = new Set(['PORTABLE_ARCHIVE_LIMIT_EXCEEDED'])

function failureCode(error: unknown): string | undefined {
  const { code, message } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; message?: unknown }
  if (typeof code === 'string') return code
  return typeof message === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(message) ? message : undefined
}

function sourceChanged(error: unknown): boolean {
  return error instanceof PortableProjectArchiveError && error.code === 'PORTABLE_ARCHIVE_SOURCE_CHANGED'
}


async function hashFile(file: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer)
  return digest.digest('hex')
}

function publishStagedArchive(stagedArchivePath: string, targetPath: string): fs.BigIntStats {
  const staged = fs.lstatSync(stagedArchivePath, { bigint: true })
  if (!staged.isFile() || staged.isSymbolicLink()
    || normalizedPath(fs.realpathSync.native(stagedArchivePath)) !== normalizedPath(stagedArchivePath)) {
    fail('PORTABLE_ASSET_UNSAFE')
  }
  safeDirectory(path.dirname(targetPath))
  try { fs.linkSync(stagedArchivePath, targetPath) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new PortableProjectArchiveError('PORTABLE_ARCHIVE_TARGET_EXISTS')
    }
    throw new PortableProjectArchiveError('PORTABLE_ARCHIVE_PUBLISH_UNSUPPORTED')
  }
  const published = fs.lstatSync(targetPath, { bigint: true })
  if (!published.isFile() || published.isSymbolicLink() || !sameObject(staged, published)
    || normalizedPath(fs.realpathSync.native(targetPath)) !== normalizedPath(targetPath)) {
    try {
      const current = fs.lstatSync(targetPath, { bigint: true })
      if (current.isFile() && !current.isSymbolicLink() && sameObject(staged, current)
        && normalizedPath(fs.realpathSync.native(targetPath)) === normalizedPath(targetPath)) fs.unlinkSync(targetPath)
    } catch { /* Preserve an unknown replacement. */ }
    throw new PortableProjectArchiveError('PORTABLE_ARCHIVE_INVALID')
  }
  return published
}

function assertContextShape(context: ProjectSessionContext, sourceRoot: string): void {
  if (!context || typeof context.projectId !== 'string' || !context.projectId || typeof context.leaseId !== 'string'
    || !context.leaseId || typeof context.projectPath !== 'string'
    || normalizedPath(context.projectPath) !== normalizedPath(sourceRoot)) fail('PORTABLE_CONTEXT_INVALID')
}

async function assertCurrentContext(input: ExportPortableProjectInput, context: Readonly<ProjectSessionContext>, sourceRoot: string): Promise<void> {
  try {
    if (await input.assertCurrentContext(context, sourceRoot) === false) fail('PORTABLE_CONTEXT_INVALID')
  }
  catch { fail('PORTABLE_CONTEXT_INVALID') }
}

const omittable = (cycles: readonly UnprovableReviewCycle[]): ReadonlyMap<string, DamagedReviewCycle> =>
  new Map(cycles.flatMap(item => item.cycleId === null ? [] : [[item.cycleId, item.location] as const]))

/** 资料阶段出错：丢掉这次的临时目录，整次重来一次，仍失败报第二次的错。重来时库文件已被换掉就拒绝。本地导出和云备份都走这里。 */
export async function exportPortableProject(input: ExportPortableProjectInput): Promise<ExportPortableProjectReceipt> {
  const source: SourceDatabasePin = {}
  try { return await exportPortableProjectOnce(input, source) }
  catch (error) {
    if (!(error instanceof AssetPhaseFailure)) throw error
    const code = failureCode(error.failure)
    if (code && NOT_RETRIED.has(code)) throw error.failure
    console.warn('[portable-export] 资料阶段出错，整次重来一次', { code })
  }
  try { return await exportPortableProjectOnce(input, source) }
  catch (error) {
    const failure = error instanceof AssetPhaseFailure ? error.failure : error
    if (sourceChanged(failure)) fail('PORTABLE_EXPORT_SOURCE_CHANGED')
    throw failure
  }
}

/** 只比 dev、ino：写库会改大小和修改时间，不改身份。 */
interface SourceDatabasePin { database?: fs.BigIntStats }

async function exportPortableProjectOnce(input: ExportPortableProjectInput, source: SourceDatabasePin): Promise<ExportPortableProjectReceipt> {
  const sourceRoot = path.resolve(input.sourceProjectRoot)
  const targetPath = path.resolve(input.targetArchivePath)
  const attemptParent = path.resolve(input.attemptParentPath)
  assertContextShape(input.projectSession, sourceRoot)
  if (contained(sourceRoot, targetPath) || contained(sourceRoot, attemptParent)) fail('PORTABLE_TARGET_INSIDE_SOURCE')
  safeDirectory(sourceRoot)
  safeDirectory(attemptParent)
  const frozenContext = Object.freeze({ ...input.projectSession })
  await assertCurrentContext(input, frozenContext, sourceRoot)
  const projectStorageRoot = path.join(sourceRoot, CANONICAL_PROJECT_DIRECTORY)
  safeDirectory(projectStorageRoot)
  const sourceDatabasePath = path.join(projectStorageRoot, CANONICAL_PROJECT_DATABASE)
  const checkedDatabase = regularFile(sourceDatabasePath, 'PORTABLE_ASSET_MISSING')
  if (source.database && !sameObject(source.database, checkedDatabase)) throw new Error('PROJECT_MIGRATION_SOURCE_CHANGED')
  source.database = checkedDatabase
  const assertSameDatabase = () => {
    if (!sameObject(regularFile(sourceDatabasePath, 'PORTABLE_ASSET_MISSING'), checkedDatabase)) throw new Error('PROJECT_MIGRATION_SOURCE_CHANGED')
  }
  const canonicalManifestPath = path.join(projectStorageRoot, 'project.json')
  regularFile(canonicalManifestPath, 'PORTABLE_ASSET_MISSING')
  const canonicalManifest = parseCanonicalProjectManifest(JSON.parse(
    fs.readFileSync(canonicalManifestPath, 'utf8'),
  ))
  if (canonicalManifest.projectId !== frozenContext.projectId) fail('PORTABLE_CONTEXT_INVALID')
  const snapshotGeneration = input.snapshotGeneration ?? randomUUID()
  const createdAt = (input.now?.() ?? new Date()).toISOString()
  const attempt = prepareAttempt(attemptParent)
  const attemptRoot = attempt.root
  try {
    const sourceSnapshotPath = path.join(attemptRoot, 'source.db')
    // 知识库的写入都持这把闸门。从取库快照到读完知识库一直持着，存档里的知识库就是库快照那一刻的，不会比库新。
    const { sourceFreeze, sourceSchema, sourceFingerprint, unprovable, avatarRows, avatarFiles, avatarReferenceProjections, provided } =
      await withKnowledgeSourceGate(projectStorageRoot, async () => {
        // 排队等闸门期间作品可能被关掉或换掉，取快照前重查。
        await assertCurrentContext(input, frozenContext, sourceRoot)
        assertSameDatabase()
        try { await snapshotProjectSqlite({ sourceDatabasePath, targetDatabasePath: sourceSnapshotPath, sourceIdentity: checkedDatabase }) }
        finally { recordOwnedFileIfPresent(attempt, sourceSnapshotPath) }
        const sourceFreeze = readPortableRuntimeFreeze(sourceRoot)
        const sourceSnapshot = new BetterSqlite(sourceSnapshotPath, { readonly: true, fileMustExist: true })
        let avatarRows: ReturnType<typeof readPortableCharacterAvatarRows>
        let sourceSchema: ReturnType<typeof assertPortableSourceSchema>
        let sourceFingerprint: string
        let unprovable: readonly UnprovableReviewCycle[] = []
        try {
          // 校验时才知道有没有验不过的审修循环，有才再扫一遍取清单放行；健康的书只扫一遍。
          const accepted = () => new Set(omittable(unprovable = inspectM03ReviewCycles(sourceSnapshot).unprovable).keys())
          sourceSchema = assertPortableExportSource(sourceSnapshot, accepted)
          sourceFingerprint = sqliteSchemaFingerprint(sourceSnapshot)
          if (sourceFreeze.active) readPortableCurrentAuthority({ database: sourceSnapshot, projectStorageRoot, projectId: canonicalManifest.projectId })
          avatarRows = readPortableCharacterAvatarRows(sourceSnapshot)
        } finally {
          sourceSnapshot.close()
          recordOwnedFileIfPresent(attempt, `${sourceSnapshotPath}-wal`)
          recordOwnedFileIfPresent(attempt, `${sourceSnapshotPath}-shm`)
        }

        const { avatarFiles, avatarReferenceProjections, provided } = await assetPhase(async () => {
          const avatarReferenceProjections: Array<Record<string, unknown>> = []
          const digestFile = (sourcePath: string, checked: fs.BigIntStats) => {
            if (!contained(projectStorageRoot, path.resolve(sourcePath))) fail('PORTABLE_ASSET_UNSAFE')
            return digestCheckedFile(sourcePath, checked)
          }
          const avatarFiles: Array<{ entry: PortableProjectManifestEntry; sourcePath: string }> = []
          for (const row of avatarRows) {
            if (row.kind === 'unresolved-reference') {
              avatarReferenceProjections.push({ ...row, nonReplayable: true })
              continue
            }
            const relativePath = portablePathKey(row.relativePath)
            if (!relativePath) fail('PORTABLE_ASSET_UNSAFE')
            const sourcePath = path.resolve(projectStorageRoot, ...row.relativePath.split('/'))
            if (!contained(projectStorageRoot, sourcePath)) fail('PORTABLE_ASSET_UNSAFE')
            const digest = digestFile(sourcePath, regularFile(sourcePath, 'PORTABLE_ASSET_MISSING'))
            if (digest.byteSize !== row.byteSize || digest.sha256 !== row.contentHash) fail('PORTABLE_EXPORT_AVATAR_DAMAGED')
            avatarFiles.push({ entry: { path: row.relativePath, byteSize: row.byteSize, sha256: row.contentHash,
              disposition: 'avatar-asset' }, sourcePath })
          }
          const provided = await input.assets.snapshot({
            sourceProjectRoot: sourceRoot,
            sourceDatabasePath: sourceSnapshotPath,
            projectSession: frozenContext,
            snapshotGeneration,
            digestFile,
          })
          return { avatarFiles, avatarReferenceProjections, provided }
        })
        return { sourceFreeze, sourceSchema, sourceFingerprint, unprovable, avatarRows, avatarFiles, avatarReferenceProjections, provided }
      })

    const portableDatabasePath = path.join(attemptRoot, 'project.db')
    fs.copyFileSync(sourceSnapshotPath, portableDatabasePath, fs.constants.COPYFILE_EXCL)
    recordOwnedFile(attempt, portableDatabasePath)
    const sanitized = sanitizePortableDatabase(portableDatabasePath, { omitReviewCycles: omittable(unprovable), verifiedSchema: sourceSchema })
    recordOwnedFile(attempt, portableDatabasePath)
    input.__testHooks?.afterPortableDatabaseCreated?.(attemptRoot)

    const sources: PortableArchiveSource[] = []
    const entryKeys = new Set<string>()
    const addSource = (entry: PortableProjectManifestEntry, sourcePath: string) => {
      const key = portablePathKey(entry.path)
      if (entryKeys.has(key)) fail('PORTABLE_ASSET_UNSAFE')
      entryKeys.add(key)
      sources.push({ entry, sourcePath })
    }
    const databaseInfo = regularFile(portableDatabasePath, 'PORTABLE_ASSET_MISSING')
    const portableDatabaseSha256 = await hashFile(portableDatabasePath)
    addSource({ path: CANONICAL_PROJECT_DATABASE, byteSize: Number(databaseInfo.size),
      sha256: portableDatabaseSha256, disposition: 'portable-database' }, portableDatabasePath)

    const portableDatabase = new BetterSqlite(portableDatabasePath, { readonly: true, fileMustExist: true })
    let transferAuthority
    try {
      transferAuthority = createPortableTransferAuthority({
        database: portableDatabase,
        freeze: sourceFreeze,
        originProjectId: canonicalManifest.projectId,
        snapshotGeneration,
        portableDatabaseSha256,
      })
    } finally { portableDatabase.close() }
    recordOwnedFileIfPresent(attempt, `${portableDatabasePath}-wal`)
    recordOwnedFileIfPresent(attempt, `${portableDatabasePath}-shm`)
    const transferBytes = serializePortableTransferAuthority(transferAuthority)
    const transferPath = path.join(attemptRoot, 'portable-transfer-authority.json')
    writeOwnedFile(attempt, transferPath, transferBytes)
    addSource({ path: PORTABLE_TRANSFER_AUTHORITY_PATH, byteSize: transferBytes.length,
      sha256: sha256(transferBytes), disposition: 'transfer-receipt' }, transferPath)

    const projectSources = avatarFiles.map(({ sourcePath }) => sourcePath)
    for (const { entry, sourcePath } of avatarFiles) addSource(entry, sourcePath)
    for (const [index, file] of provided.files.entries()) {
      verifyFile(file, projectStorageRoot)
      let sourcePath = file.sourcePath
      if (sourcePath === undefined) {
        sourcePath = path.join(attemptRoot, `provided-${index}`)
        writeOwnedFile(attempt, sourcePath, file.bytes!)
      } else projectSources.push(sourcePath)
      addSource({ path: file.archivePath, byteSize: file.byteSize, sha256: file.sha256,
        disposition: file.disposition }, sourcePath)
    }

    const historyDocument = {
      version: 1,
      originProjectId: canonicalManifest.projectId,
      snapshotGeneration,
      nonReplayable: true,
      requiresRuntimeFreezeGuard: true,
      records: sanitized.history,
      avatarReferenceProjections,
    }
    const historyBytes = Buffer.from(stableJson(historyDocument), 'utf8')
    parsePortableRuntimeFreeze(historyBytes)
    const historyPath = path.join(attemptRoot, 'portable-runtime-freeze.json')
    writeOwnedFile(attempt, historyPath, historyBytes)
    addSource({ path: 'portable-runtime-freeze.json', byteSize: historyBytes.length,
      sha256: sha256(historyBytes), disposition: 'history-projection' }, historyPath)

    const entries = sources.map(source => source.entry)
    const payloadBytes = entries.reduce((sum, entry) => sum + entry.byteSize, 0)
    const historyProjectionIds = [
      ...sanitized.history.map(item => item.projectionId),
      ...avatarReferenceProjections.map(item => `avatar-reference:${safeId(item.recordId)}`),
      ...(provided.historyProjectionIds ?? []),
    ]
    const manifest: PortableProjectManifest = {
      formatVersion: PORTABLE_PROJECT_FORMAT_VERSION,
      sourceSchemaVersion: PORTABLE_SOURCE_SCHEMA_VERSION,
      originProjectId: canonicalManifest.projectId,
      snapshotGeneration,
      createdAt,
      declaredUncompressedBytes: payloadBytes,
      declaredCompressedBytes: payloadBytes,
      entries,
      semanticCounts: {
        ...(provided.semanticCounts ?? {}),
        ...sanitized.tableCounts,
        avatars: avatarRows.filter(row => row.kind !== 'unresolved-reference').length,
        'avatar-references': avatarReferenceProjections.length,
      },
      omittedItems: [
        { id: 'vectors', reason: 'rebuild-stale' },
        { id: 'cache', reason: 'rebuild-stale' },
        { id: 'logs', reason: 'exclude-machine-authority' },
        { id: 'temp', reason: 'exclude-machine-authority' },
        { id: 'migration-backups', reason: 'exclude-machine-authority' },
        { id: 'machine-authority-fields', reason: 'exclude-machine-authority' },
        ...(provided.omittedItems ?? []),
      ],
      transferReceiptIds: [transferAuthority.receiptId, ...(provided.transferReceiptIds ?? [])],
      historyProjectionIds,
    }
    const stagedArchivePath = path.join(attemptRoot, 'portable-project.archive')
    const archiveReceipt = await assetPhase(() => {
      for (const sourcePath of projectSources) assertSourceStillOwned(sourcePath)
      return writePortableProjectArchive({ manifest, sources, targetPath: stagedArchivePath })
        .catch((error: unknown) => {
          if (missingSource(error, projectSources)) sourceChangedDuringExport()
          throw error
        })
    })
    recordOwnedFile(attempt, stagedArchivePath)
    input.__testHooks?.afterArchiveBuilt?.(stagedArchivePath)

    await assertCurrentContext(input, frozenContext, sourceRoot)
    assertSameDatabase()
    const targetInfo = publishStagedArchive(stagedArchivePath, targetPath)
    return {
      originProjectId: canonicalManifest.projectId,
      snapshotGeneration,
      targetSha256: await hashFile(targetPath),
      targetByteSize: Number(targetInfo.size),
      sourceEvidence: {
        schemaVersion: PORTABLE_SOURCE_SCHEMA_VERSION,
        schemaFingerprint: sourceFingerprint,
        tableCount: sourceSchema.tables,
        fieldCount: sourceSchema.fields,
      },
      entryCount: archiveReceipt.entryCount,
      requiresRuntimeFreezeGuard: true,
      ...(sanitized.omittedReviewCycles.length ? { omittedReviewCycles: sanitized.omittedReviewCycles } : {}),
    }
  } finally {
    cleanupAttempt(attempt)
  }
}
