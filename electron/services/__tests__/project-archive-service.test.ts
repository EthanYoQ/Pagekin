import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { verifyM03ReviewCycle, canonicalM03FindingSetHash, inspectM03ReviewCycles } from '../../migrations/m03-review-cycle'
import { CANONICAL_PROJECT_DATABASE, CANONICAL_PROJECT_DIRECTORY, createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { buildReviewGenerationReport } from '../../../src/shared/review-generation-report'
import type { ReviewCycleRecheckContext } from '../../../src/shared/review-cycle'
import type { GenerationTransportDiagnostics } from '../../../src/shared/generation-contract'
import { extractPortableProjectArchive, writePortableProjectArchive } from '../portable-project-archive'
import {
  createPortableTransferAuthority,
  parsePortableTransferAuthority,
  PORTABLE_TRANSFER_AUTHORITY_PATH,
  serializePortableTransferAuthority,
} from '../portable-transfer-authority'
import { getPortableFieldPolicy, listPortableFieldPolicyKeys } from '../portable-project-format'
import { logicalTableName } from '../../migrations/m07-chapter-recycle'
import { restorePortableProject } from '../project-restore-service'
import { readPortableRuntimeFreeze } from '../portable-runtime-freeze'
import { createPortableProjectAssetProvider } from '../portable-project-assets'
import { ReviewRevisionGeneration } from '../review-revision-generation'
import { GenerationRunRepository, textHash } from '../../repositories/generation-run-repository'
import { captureReviewRevisionContext } from '../review-revision-context'
import {
  exportPortableProject,
  PORTABLE_CLEARED_TABLES,
  portableRedactionFor,
  sanitizePortableDatabase,
  type ExportPortableProjectInput,
  type PortableAssetSnapshot,
  type PortableProvidedFile,
} from '../project-archive-service'
import {
  AUTHOR_IMPORT_EFFECTS,
  AUTHOR_IMPORT_RUN_ID,
  createProjectArchiveRoundtripFixture,
  insertAuthorImportReceipts,
} from '../../../test/desktop/project-archive.fixture'
import { createMainGenerationOwner } from '../main-generation-owner'
import { ModelExecutionLeaseRegistry } from '../model-execution-lease'
import { readMainGenerationPolicy } from '../main-generation-plan'
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding } from '../generation-source-binding'
import { ReviewRepository } from '../../repositories/review-repository'
import { RevisionRepository } from '../../repositories/revision-repository'
import { createHumanConfirmedReviewSnapshot, renderHumanConfirmedReviewBrief, serializeHumanConfirmedReviewSnapshot } from '../../../src/shared/human-confirmed-review'
import { generationOutputContract, type BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import { composeVisibleContinuation } from '../../../src/shared/visible-continuation'
import { countDraftUnits } from '../../../src/shared/draft-units'

import { withKnowledgeSourceGate } from '../knowledge-source-gate'
import { activateCanonicalProjectData, getProjectDataRoot } from '../project-data-locator'
import { PORTABLE_KNOWLEDGE_SOURCE_PATH } from '../portable-project-assets'

const archiveLimits = vi.hoisted(() => ({ current: {} as Record<string, number>, defaults: {} as Record<string, number> }))
vi.mock('../portable-project-format', async importOriginal => {
  const actual = await importOriginal<typeof import('../portable-project-format')>()
  Object.assign(archiveLimits.defaults, actual.DEFAULT_PORTABLE_ARCHIVE_LIMITS)
  Object.assign(archiveLimits.current, actual.DEFAULT_PORTABLE_ARCHIVE_LIMITS)
  return { ...actual, DEFAULT_PORTABLE_ARCHIVE_LIMITS: archiveLimits.current }
})
const gateRequests = vi.hoisted(() => ({ onRequest: undefined as undefined | (() => void) }))
vi.mock('../knowledge-source-gate', async importOriginal => {
  const actual = await importOriginal<typeof import('../knowledge-source-gate')>()
  return {
    ...actual,
    withKnowledgeSourceGate: <T>(root: string, operation: () => T | Promise<T>) => {
      gateRequests.onRequest?.()
      return actual.withKnowledgeSourceGate(root, operation)
    },
  }
})

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

interface Fixture {
  base: string
  root: string
  storage: string
  databasePath: string
  target: string
  attemptParent: string
  extractParent: string
  projectId: string
  session: { projectId: string; projectPath: string; leaseId: string }
}

function fixture(donor = false): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'b01-export-service-'))
  roots.push(base)
  const root = path.join(base, '作者项目')
  const storage = path.join(root, '.ai-novel')
  const attemptParent = path.join(base, 'private-attempts')
  const extractParent = path.join(base, 'private-extracts')
  fs.mkdirSync(storage, { recursive: true })
  fs.mkdirSync(attemptParent)
  fs.mkdirSync(extractParent)
  const projectId = randomUUID()
  fs.writeFileSync(path.join(storage, 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId,
    createdAt: '2026-09-20T00:00:00.000Z',
  })))
  if (donor) {
    const db = new Database(path.join(storage, 'project.db'))
    try {
      initializeLegacyBaselineSchema(db)
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='characters'").get() as { sql: string }
      db.exec('ALTER TABLE characters RENAME TO characters_without_avatar')
      db.exec(row.sql.replace("      cs_location TEXT DEFAULT '',", "      avatar TEXT NOT NULL DEFAULT '',\n      cs_location TEXT DEFAULT '',"))
      db.exec('DROP TABLE characters_without_avatar')
      migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 7)
    } finally { db.close() }
  } else createProjectDatabase(root, Buffer.alloc(32, 7))
  initProjectDatabase(root)
  BlueprintRepository.listPendingCharacterSyncOperations()
  closeProjectDatabase()
  return {
    base,
    root,
    storage,
    databasePath: path.join(storage, 'project.db'),
    target: path.join(base, '项目副本.ainovel'),
    attemptParent,
    extractParent,
    projectId,
    session: { projectId, projectPath: root, leaseId: 'lease-current' },
  }
}

function providedFile(archivePath: string, value: string, disposition: PortableProvidedFile['disposition']): PortableProvidedFile {
  const bytes = Buffer.from(value, 'utf8')
  return { id: archivePath, archivePath, bytes, byteSize: bytes.length, sha256: hash(bytes), disposition }
}

function provider(files: readonly PortableProvidedFile[] = []): ExportPortableProjectInput['assets'] {
  return {
    snapshot(): PortableAssetSnapshot {
      return {
        files,
        semanticCounts: { 'provided-assets': files.length },
        omittedItems: [],
        transferReceiptIds: [],
        historyProjectionIds: [],
      }
    },
  }
}

function input(f: Fixture, assets = provider(), overrides: Partial<ExportPortableProjectInput> = {}): ExportPortableProjectInput {
  return {
    sourceProjectRoot: f.root,
    projectSession: f.session,
    targetArchivePath: f.target,
    attemptParentPath: f.attemptParent,
    assertCurrentContext: context => {
      if (context.leaseId !== f.session.leaseId) throw new Error('stale')
    },
    assets,
    now: () => new Date('2026-09-21T00:00:00.000Z'),
    snapshotGeneration: 'generation-test-1',
    ...overrides,
  }
}

function seedProject(f: Fixture, secret = 'token-绝不外带'): { body: string; avatar: Buffer; secretDigest: string } {
  const body = '雨落在铜钥匙上。作者写下 C:\\某地\\旧稿.txt，字节必须原样。'
  const avatar = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 9)])
  const characterA = randomUUID()
  const characterB = randomUUID()
  const avatarPath = `avatars/${hash(characterA)}/1-${hash(avatar)}.png`
  fs.mkdirSync(path.dirname(path.join(f.storage, avatarPath)), { recursive: true })
  fs.writeFileSync(path.join(f.storage, avatarPath), avatar)
  const db = new Database(f.databasePath)
  db.pragma('foreign_keys = ON')
  try {
    db.prepare("INSERT INTO project_core(id,project_name,writing_language) VALUES('main',?,'zh-CN')").run('铜钥匙')
    db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run(body)
    db.prepare(`INSERT INTO drafts_all(id,chapter_number,version,status,source,content_id,word_count,source_dependencies)
      VALUES(1,1,1,'finalized','write',1,?,?)`).run(body.length, '[]')
    db.prepare(`INSERT INTO finalization_outbox_all(
      finalization_id,draft_id,chapter_number,chapter_title,content_hash,content_revision,content_snapshot,
      target_file_name,publication_status,last_error
    ) VALUES(?,?,?,?,?,1,?,?,'pending',?)`).run('finalization-1', 1, 1, '雨夜', hash(body), body, '第一章-雨夜.md', `C:\\错误\\${secret}`)
    db.prepare(`INSERT INTO characters(character_id,name,role,static_provenance)
      VALUES(?,?,'protagonist','{}'),(?,?,'supporting','{}')`).run(characterA, '林澈', characterB, '苏晚')
    db.prepare(`INSERT INTO character_avatar_assets(
      character_id,asset_revision,relative_path,content_hash,mime,byte_size,source_reference
    ) VALUES(?,1,?,?,'image/png',?,'avatar.png')`).run(characterA, avatarPath, hash(avatar), avatar.length)
    db.prepare('INSERT INTO character_identity_approvals(operation_id,payload_hash,receipt_json) VALUES(?,?,?)')
      .run('approval-1', hash('approval'), JSON.stringify({ operationId: 'approval-1', secretRef: secret }))
    db.prepare(`INSERT INTO character_relationships(
      relationship_id,source_character_id,target_character_id,relation,source_display_snapshot,
      target_display_snapshot,provenance_json,approval_id
    ) VALUES(?,?,?,?,?,?,?,?)`).run('relationship-1', characterA, characterB, '盟友', '林澈', '苏晚',
      JSON.stringify({ source: 'author' }), 'approval-1')
    db.prepare(`INSERT INTO recovery_candidates(
      candidate_id,run_id,step_id,project_id,chapter_number,chapter_title,source_snapshot,source_hash,
      source_draft_identity_captured,visible_text,content_hash,failure_code,failure_reason,status
    ) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?,'pending')`).run(
      'candidate-1', 'run-1', 'step-1', f.projectId, 2, '第二章', JSON.stringify({
        chapterNumber: 2, title: '第二章', role: '推进', purpose: '追踪', keyEvents: '发现线索', characters: ['林澈'],
      }), hash('source'), '候选正文', hash('候选正文'), 'MODEL_UNKNOWN', `secretRef=${secret}`,
    )
    const action = { projectId: f.projectId, epoch: 'epoch-1', operation: 'draft', uiActionNonce: 'nonce',
      frozenInputHash: hash('input'), rootActionId: 'root-1', status: 'active' }
    db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
      .run('root-1', 'root-key-1', JSON.stringify({ ...action, secretRef: secret }), JSON.stringify({
        maxPhysicalRequests: 2, maxTokenLiability: 1000, maxOutputPerRequest: 500, maxActiveElapsedMs: 1000,
      }))
    db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run(
      'run-1', 'root-1', JSON.stringify({ projectId: f.projectId, epoch: 'epoch-1', fingerprint: {},
        contextSnapshotId: 'context-1', sourceManifest: { secretRef: secret }, sourceRefs: [] }), 'running', 1, 'open-key-1')
    const attempt = { attemptId: 'attempt-1', reservationId: 'reservation-1', rootActionId: 'root-1',
      status: 'unknown', reservedTokens: 500, requestedOutputTokens: 400 }
    const rawReceipt = JSON.stringify({ secretRef: secret, path: 'C:\\Users\\writer\\token.txt' })
    const secretDigest = hash(rawReceipt)
    db.prepare('INSERT INTO generation_attempts VALUES(?,?,?,?,?,?,?)').run(
      'attempt-1', 'reservation-1', 'run-1', 'root-1', JSON.stringify(attempt),
      JSON.stringify({ rawReceipt, digest: secretDigest }), 'invocation-1')
    const artifact = { artifactId: 'artifact-1', attemptId: 'attempt-1', rootActionId: 'root-1',
      projectId: f.projectId, epoch: 'epoch-1', fingerprint: {}, revision: 1,
      text: '候选续写 C:\\作者设定\\地点', textHash: hash('候选续写 C:\\作者设定\\地点') }
    db.prepare('INSERT INTO generation_artifacts VALUES(?,?,?,?,?,?)').run(
      'artifact-1', 'attempt-1', 'run-1', JSON.stringify(artifact), 1, 'partial')
    db.prepare('INSERT INTO import_legacy_identity_bridge VALUES(?,?,?,?,datetime(\'now\'))')
      .run('legacy-secret', Buffer.from(secret).toString('hex'), '01'.repeat(12), '02'.repeat(16))
    db.prepare(`INSERT INTO import_runs(
      id,purpose,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,source_display_json,
      locale,stage,status,total_chapters,manifest_chapter_count,execution_owner,execution_epoch,lease_expires_at
    ) VALUES(?,?,?,?,?,?,?,'zh-CN','parsing','running',0,0,?,?,?)`).run(
      'import-1', 'reference', 'import-1', 'import:reference:import-1', hash('source-file'), hash('manifest'),
      JSON.stringify([{ displayName: '资料.txt', mediaType: 'text/plain', size: 12 }]), secret, 9, 999999,
    )
    return { body, avatar, secretDigest }
  } finally { db.close() }
}

function seedMergedCycle(f: Fixture, config: Record<string, unknown> = {}, recheckReceipt?: Record<string, unknown>,
  reportOptions: { longReport?: boolean; reportVersion?: 2; recheckReportVersion?: 1 | 2;
    diagnostics?: GenerationTransportDiagnostics } = {}): {
  cycleId: string; body: string; mergedHash: string; reviewBody: string; recheckBody?: string
} {
  const db = new Database(f.databasePath)
  db.pragma('foreign_keys = ON')
  try {
  const source = reportOptions.longReport ? '甲推开门，'.repeat(40) + '但这只是传闻。' : '甲推开门，雨水顺着袖口落下。'
  const body = '甲推开门，作者手工合并了新正文。'
  const reviewOutput = JSON.stringify({ summary: reportOptions.longReport ? '核对原文。'.repeat(30) + '保留限定。' : '检查完成', items: [{ category: 'continuity',
    severity: 'warning', description: reportOptions.longReport ? '门闩状态需确认。'.repeat(30) + '但这只是传闻。' : '门闩状态需确认。',
    quote: reportOptions.longReport ? source : '甲推开门' }] })
  const reviewBody = JSON.stringify(buildReviewGenerationReport({ content: reviewOutput, sourceContent: source,
    frozenGoals: { chapterNumber: 1, coverage: 'not_configured', items: [] }, writingLanguage: 'zh-CN', uiLocale: 'zh-CN',
    preflightFindings: [], reportVersion: reportOptions.reportVersion ?? 1 }), null, 2)
  const addContent = (value: string) => Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(value).lastInsertRowid)
  const draftId = Number(db.prepare("INSERT INTO drafts_all(chapter_number,version,status,content_id) VALUES(1,1,'revised',?)")
    .run(addContent(body)).lastInsertRowid)
  const reviewId = Number(db.prepare(`INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,
    source_draft_version,source_draft_status,source_content,content_id) VALUES(?,1,1,1,'draft',?,?)`)
    .run(draftId, source, addContent(reviewBody)).lastInsertRowid)
  const confirmationBody = JSON.stringify({ kind: 'human-confirmed-review', schemaVersion: 1, sourceReviewId: reviewId,
    sourceDraft: { id: draftId, chapterNumber: 1, version: 1, status: 'draft', content: source },
    summary: '', authorGuidance: '', items: [] }, null, 2)
  const confirmationId = Number(db.prepare(`INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,
    source_draft_version,source_draft_status,source_content,content_id) VALUES(?,2,1,1,'draft',?,?)`)
    .run(draftId, source, addContent(confirmationBody)).lastInsertRowid)
  const revisionBody = '甲推开门，先抖落袖口的雨水。'
  const revisionId = Number(db.prepare(`INSERT INTO revisions(base_draft_id,revision_index,revision_type,status,
    merged_to_draft_id,user_prompt,review_source_id,source_draft_chapter_number,source_draft_version,
    source_draft_status,source_content,content_id) VALUES(?,1,'review-fix','merged',?,'',?,1,1,'draft',?,?)`)
    .run(draftId, draftId, confirmationId, source, addContent(revisionBody)).lastInsertRowid)
  const root = 'root-merge'
  db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
    .run(root, 'root-key', JSON.stringify({ projectId: f.projectId, epoch: 'epoch', operation: 'review-chapter',
      uiActionNonce: 'merge', frozenInputHash: hash(source), rootActionId: root, status: 'active' }),
    JSON.stringify({ maxPhysicalRequests: 1, maxTokenLiability: 100, maxOutputPerRequest: 100, maxActiveElapsedMs: 1000 }))
  const attempt = (kind: 'review' | 'revision', id: number, index: number, content: string, output: string,
    confirmation?: object, recheck?: ReviewCycleRecheckContext) => {
    const label = recheck ? 'recheck' : kind
    const attemptId = `attempt-${label}`, runId = `run-${label}`, artifactId = `artifact-${label}`
    const frozenSource = recheck ? body : source
    const operation = kind === 'review' ? 'review-chapter' : 'refine-from-review'
    const context = { version: 1, operation, sourceHash: hash(frozenSource),
      source: { id: draftId, chapterNumber: 1, version: 1, status: recheck ? 'revised' : 'draft', content: frozenSource },
      config, writingLanguage: 'zh-CN', uiLocale: 'zh-CN', authorInputs: [], characterStates: '（暂无）',
      worldbuilding: '', history: [], blueprints: [],
      frozenGoals: { chapterNumber: 1, coverage: 'not_configured', items: [] }, preflightFindings: [],
      ...(confirmation ? { confirmation } : {}), ...(recheck ? { recheck } : {}) }
    const fingerprint = Object.fromEntries([
      'chapterBriefHash', 'authorGuidanceHash', 'dependencyHash', 'contextSnapshotHash', 'templateHash',
      'skillSnapshotHash', 'modelLeaseRevision', 'policyHash', 'outputContractHash',
    ].map((key, number) => [key, hash(`${attemptId}:${number}`)]))
    const artifact = { artifactId, attemptId, rootActionId: root, projectId: f.projectId, epoch: 'epoch',
      fingerprint, revision: 1, text: output, textHash: hash(output) }
    const artifactRef = { artifactId, revision: 1, textHash: hash(output) }
    const reportVersion = recheck ? reportOptions.recheckReportVersion === 2 ? 2 : undefined : reportOptions.reportVersion
    const effect = { kind, id, index, contentHash: hash(content), contextHash: hash(JSON.stringify(context)),
      artifact: artifactRef, ...(kind === 'revision' ? { compositionHash: hash(content) }
        : reportVersion === undefined ? {} : { reportVersion }) }
    db.prepare('INSERT INTO generation_runs(run_id,root_action_id,binding_json,status,created_at_ms,open_key) VALUES(?,?,?,?,?,?)')
      .run(runId, root, JSON.stringify({ projectId: f.projectId, epoch: 'epoch', fingerprint,
        sourceManifest: { operation, secretRef: 'private-credential-sentinel',
          machinePath: 'C:\\Users\\EthanQ\\private-machine-sentinel',
          reviewRevisionContext: context, reviewRevisionContextHash: effect.contextHash,
          authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(context) }] } }),
      'completed', 1, `open-${label}`)
    db.prepare(`INSERT INTO generation_attempts(attempt_id,reservation_id,run_id,root_action_id,attempt_json,
      usage_receipt_json,invocation_nonce) VALUES(?,?,?,?,?,?,?)`).run(attemptId, `reservation-${label}`, runId, root,
      JSON.stringify({ attemptId, reservationId: `reservation-${label}`, rootActionId: root, status: 'settled',
        reservedTokens: 100, requestedOutputTokens: 100, actualTokens: 1 }),
      JSON.stringify({ artifactIdentity: { artifactId, epoch: 'epoch', fingerprint }, result: { usage: null, finishReason: 'stop',
        ...(reportOptions.diagnostics ? { diagnostics: reportOptions.diagnostics } : {}) },
        reviewRevisionEffect: effect, ...(kind === 'review' && (recheck || recheckReceipt)
          ? { reviewCycleRecheck: recheck ?? recheckReceipt } : {}),
        ...(kind === 'revision' ? { visibleComposition: { algorithm: 'visible-append-v1',
          textHash: hash(content), artifactIds: [artifactId], sources: [artifactRef] } } : {}) }), `nonce-${label}`)
    db.prepare('INSERT INTO generation_artifacts(artifact_id,attempt_id,run_id,artifact_json,revision,status) VALUES(?,?,?,?,1,?)')
      .run(artifactId, attemptId, runId, JSON.stringify(artifact), 'partial')
  }
    attempt('review', reviewId, 1, reviewBody, reviewOutput)
    attempt('revision', revisionId, 1, revisionBody, revisionBody, {
      reviewSourceId: confirmationId, content: confirmationBody, originalReviewContentHash: hash(reviewBody),
      snapshot: JSON.parse(confirmationBody),
    })
    const cycleId = 'cycle-merge'
    db.prepare('INSERT INTO review_cycles VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(cycleId, root, reviewId,
      hash(reviewBody), confirmationId, hash(confirmationBody), revisionId, hash(source),
      canonicalM03FindingSetHash([]), 1, 'merge-committed', hash(body), 0, null)
    db.prepare('INSERT INTO review_cycle_merges(cycle_id,body) VALUES(?,?)').run(cycleId, body)
    let recheckBody: string | undefined
    if (reportOptions.recheckReportVersion) {
      const recheck: ReviewCycleRecheckContext = { version: 2, cycleId, comparisonVersion: 1,
        mergedHash: hash(body), findingSetHash: canonicalM03FindingSetHash([]), findings: [] }
      const output = `复核说明\n\`\`\`json\n${JSON.stringify({ summary: '保留完整复核说明。', items: [] })}\n\`\`\`\n说明结束`
      recheckBody = JSON.stringify({ summary: reportOptions.recheckReportVersion === 2
        ? '保留完整复核说明。' : '复核输出无效；受影响项目保持待核实。', items: [] }, null, 2)
      const recheckId = Number(db.prepare(`INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,
        source_draft_version,source_draft_status,source_content,content_id) VALUES(?,3,1,1,'revised',?,?)`)
        .run(draftId, body, addContent(recheckBody)).lastInsertRowid)
      attempt('review', recheckId, 3, recheckBody, output, undefined, recheck)
      db.prepare('UPDATE review_cycles SET recheck_count=1,recheck_attempt_id=? WHERE cycle_id=?').run('attempt-recheck', cycleId)
    }
    if (!verifyM03ReviewCycle(db)) throw new Error('MERGED_CYCLE_FIXTURE_INVALID')
    return { cycleId, body, mergedHash: hash(body), reviewBody, recheckBody }
  } finally { db.close() }
}

async function extract(f: Fixture) {
  return extractPortableProjectArchive({ archivePath: f.target, stagingParentPath: f.extractParent })
}

afterEach(() => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('portable project export service', () => {
  it('preserves admitted predecessor, recheck goals and state-update raw values without admitting unknown fields', async () => {
    const material = { draftId: 10, chapterNumber: 1, chapterTitle: '', content: '前驱正文',
      identity: { projectId: 'project', sourceId: 'candidate:10', revision: 1, contentHash: hash('前驱正文'), provenance: 'generated' } }
    const update = { characterId: 'character-1', currentState: { location: '城门' }, evidence: { start: 0, end: 2, text: '城门' } }
    const materials = { predecessor: material,
      history: [{ ...material, projection: { draftId: 10, currentFinalizedDraftId: 10, chapterNumber: 1,
        chapterTitle: '', chapterNotes: '', facts: [], characterStateCandidates: [{ characterName: '林澈', field: 'location', value: '城门', rawValue: update }] } }],
      recheck: { version: 2, cycleId: 'cycle-merge', comparisonVersion: 1, mergedHash: hash('merged'), findingSetHash: hash('findings'),
        sourceContent: '原文', findings: [{ findingId: 'goal-1', targetId: 'goal-1', category: 'goal', kind: 'objective',
          problem: '目标尚未呈现', expected: '出现线索', mustShow: true }] } }
    const seedContext = (f: Fixture, extras: typeof materials) => {
      seedMergedCycle(f)
      const db = new Database(f.databasePath)
      try {
        const binding = JSON.parse(db.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-review'").pluck().get() as string)
        Object.assign(binding.sourceManifest.reviewRevisionContext, extras)
        binding.sourceManifest.reviewRevisionContextHash = hash(JSON.stringify(binding.sourceManifest.reviewRevisionContext))
        binding.sourceManifest.authorInputs = [{ id: 'review-revision-context', text: JSON.stringify(binding.sourceManifest.reviewRevisionContext) }]
        db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run('run-next-review', 'root-merge', JSON.stringify(binding), 'open', 2, 'open-next-review')
      } finally { db.close() }
    }
    const f = fixture()
    seedContext(f, materials)
    await exportPortableProject(input(f))
    const targetRoot = path.join(f.base, 'restored-context')
    await restorePortableProject({ archivePath: f.target, targetProjectRoot: targetRoot })
    const restored = new Database(path.join(targetRoot, '.ai-novel', 'project.db'), { readonly: true })
    try {
      const binding = JSON.parse(restored.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-next-review'").pluck().get() as string)
      expect(binding.sourceManifest.reviewRevisionContext).toMatchObject(materials)
      expect(binding.sourceManifest.reviewRevisionContextHash).toBe(hash(JSON.stringify(binding.sourceManifest.reviewRevisionContext)))
    } finally { restored.close() }
    for (const mutate of [
      (value: typeof materials) => { Object.assign(value.predecessor, { secretRef: 'excluded' }) },
      (value: typeof materials) => { Object.assign(value.recheck.findings[0]!, { mustShow: false }) },
      (value: typeof materials) => { Object.assign(value.history[0]!.projection.characterStateCandidates[0]!.rawValue, { machinePath: 'C:/secret' }) },
    ]) {
      const invalid = fixture(), changed = structuredClone(materials)
      mutate(changed); seedContext(invalid, changed)
      await expect(exportPortableProject(input(invalid))).rejects.toThrow('PORTABLE_UNSAFE_PROJECTION')
    }
  })

  it('exports a confirmed review whose thread-task goal carries its outcome', async () => {
    const goalReview = { version: 1, chapterNumber: 1, coverage: 'not_configured', items: [
      { id: 'ch1:thread:3', text: '本章推进或回收线索「旧信」', status: 'completed', description: '结论：已回收。旧信读完。',
        evidence: [{ quote: '旧信', start: 0, end: 2 }], threadOutcome: 'resolved' },
    ] }
    const seedConfirmed = (f: Fixture, extra: Record<string, unknown>) => {
      seedMergedCycle(f)
      const db = new Database(f.databasePath)
      try {
        const binding = JSON.parse(db.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-revision'").pluck().get() as string)
        const context = binding.sourceManifest.reviewRevisionContext
        context.confirmation.snapshot.goalReview = { ...goalReview, items: goalReview.items.map(item => ({ ...item, ...extra })) }
        binding.sourceManifest.reviewRevisionContextHash = hash(JSON.stringify(context))
        binding.sourceManifest.authorInputs = [{ id: 'review-revision-context', text: JSON.stringify(context) }]
        db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run('run-next-revision', 'root-merge', JSON.stringify(binding), 'open', 2, 'open-next-revision')
      } finally { db.close() }
    }
    const f = fixture()
    seedConfirmed(f, {})
    await exportPortableProject(input(f))
    const targetRoot = path.join(f.base, 'restored-thread-goal')
    await restorePortableProject({ archivePath: f.target, targetProjectRoot: targetRoot })
    const restored = new Database(path.join(targetRoot, '.ai-novel', 'project.db'), { readonly: true })
    try {
      const binding = JSON.parse(restored.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-next-revision'").pluck().get() as string)
      expect(binding.sourceManifest.reviewRevisionContext.confirmation.snapshot.goalReview).toEqual(goalReview)
    } finally { restored.close() }
    const invalid = fixture()
    seedConfirmed(invalid, { machinePath: 'C:/secret' })
    await expect(exportPortableProject(input(invalid))).rejects.toThrow('PORTABLE_UNSAFE_PROJECTION')
    const unknownOutcome = fixture()
    seedConfirmed(unknownOutcome, { threadOutcome: 'finished' })
    await expect(exportPortableProject(input(unknownOutcome))).rejects.toThrow('PORTABLE_UNSAFE_PROJECTION')
  })

  it('cleans staging when a runtime freeze sidecar is invalid', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.storage, 'portable-runtime-freeze.json'), '{}')

    await expect(exportPortableProject(input(f))).rejects.toThrow('PORTABLE_RUNTIME_FREEZE_INVALID')
    expect(fs.existsSync(f.target)).toBe(false)
    expect(fs.readdirSync(f.attemptParent)).toEqual([])
  })

  describe('导出中途失败，临时目录不留作品内容（#744）', () => {
    afterEach(() => { vi.restoreAllMocks() })

    it('源库快照失败：已预留的快照文件和临时目录都删掉', async () => {
      const f = fixture()
      seedProject(f)
      vi.spyOn(Database.prototype, 'backup').mockRejectedValue(new Error('SQLITE_IOERR'))

      await expect(exportPortableProject(input(f))).rejects.toThrow('SQLITE_IOERR')
      expect(fs.readdirSync(f.attemptParent)).toEqual([])
    })

    it('写临时文件写到一半磁盘满：写了一半的文件和临时目录都删掉', async () => {
      const f = fixture()
      seedProject(f)
      const writeFileSync = fs.writeFileSync.bind(fs)
      vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: unknown, ...rest: unknown[]) => {
        if (typeof file !== 'number') return (writeFileSync as (...args: unknown[]) => void)(file, data, ...rest)
        fs.writeSync(file, Buffer.from('写了一半'))
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }) as typeof fs.writeFileSync)

      await expect(exportPortableProject(input(f))).rejects.toThrow('ENOSPC')
      expect(fs.readdirSync(f.attemptParent)).toEqual([])
    })

  })

  describe('资料阶段出错：整次重来一次，存档里每份资料都是完整的一版（#744）', () => {
    afterEach(() => { vi.restoreAllMocks() })

    function prompt(f: Fixture, content: string | Buffer): string {
      const file = path.join(f.storage, 'prompts', '章节.json')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
      return file
    }

    function replaceAtomically(file: string, content: string): void {
      fs.writeFileSync(`${file}.写入中`, content)
      fs.renameSync(`${file}.写入中`, file)
    }

    const exportLog = (warn: { mock: { calls: unknown[][] } }) =>
      warn.mock.calls.filter(call => String(call[0]).startsWith('[portable-export]')).map(call => JSON.stringify(call))

    it('提示词被原子替换：重来一次并记一行日志，存档里是完整的新内容', async () => {
      const f = fixture()
      const file = prompt(f, '{"提示":"快照时"}')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let replaced = false

      await exportPortableProject(input(f, createPortableProjectAssetProvider(), { __testHooks: { afterPortableDatabaseCreated: () => {
        if (replaced) return
        replaced = true
        replaceAtomically(file, '{"提示":"导出期间改的"}')
      } } }))

      expect(exportLog(warn)).toEqual([expect.stringContaining('PORTABLE_ARCHIVE_SOURCE_CHANGED')])
      const unpacked = await extract(f)
      expect(fs.readFileSync(path.join(unpacked.stagingPath, 'prompts', '章节.json'), 'utf8')).toBe('{"提示":"导出期间改的"}')
    })

    it('第一次导出途中库文件被换成另一本书、资料又被改：重来时拒绝，不发布另一本书的内容', async () => {
      const f = fixture()
      seedProject(f)
      const file = prompt(f, '{"提示":"快照时"}')
      const other = fixture()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      let replaced = false

      await expect(exportPortableProject(input(f, createPortableProjectAssetProvider(), { __testHooks: { afterPortableDatabaseCreated: () => {
        if (replaced) return
        replaced = true
        replaceAtomically(file, '{"提示":"导出期间改的"}')
        fs.renameSync(f.databasePath, path.join(f.base, '原书.db'))
        fs.copyFileSync(other.databasePath, f.databasePath)
      } } }))).rejects.toThrow('PROJECT_MIGRATION_SOURCE_CHANGED')
      expect(fs.existsSync(f.target)).toBe(false)
      expect(fs.readdirSync(f.attemptParent)).toEqual([])
    })

    it('库快照取完、列资料时库被换成另一本书：拒绝发布，不把两本书拼进一个存档', async () => {
      const f = fixture()
      seedProject(f)
      const other = fixture()
      const assets = provider()

      await expect(exportPortableProject(input(f, { snapshot: request => {
        fs.renameSync(f.databasePath, path.join(f.base, '原书.db'))
        fs.copyFileSync(other.databasePath, f.databasePath)
        return assets.snapshot(request)
      } }))).rejects.toThrow('PROJECT_MIGRATION_SOURCE_CHANGED')
      expect(fs.existsSync(f.target)).toBe(false)
    })

    it('别的程序在读资料途中原地改写同样大小的内容、又把修改时间改回去：存档里是完整的新内容，不是新旧混合', async () => {
      const f = fixture()
      const size = 3 * 1024 * 1024
      const file = prompt(f, Buffer.alloc(size, 'a'))
      const mtime = new Date('2026-11-01T00:00:00.000Z')
      fs.utimesSync(file, mtime, mtime)
      const readSync = fs.readSync.bind(fs) as (...args: unknown[]) => number
      let rewritten = false
      vi.spyOn(fs, 'readSync').mockImplementation(((...args: unknown[]) => {
        const read = readSync(...args)
        if (!rewritten && read === 1024 * 1024) {
          rewritten = true
          fs.writeFileSync(file, Buffer.alloc(size, 'b'))
          fs.utimesSync(file, mtime, mtime)
        }
        return read
      }) as typeof fs.readSync)
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      await exportPortableProject(input(f, createPortableProjectAssetProvider()))

      expect(rewritten).toBe(true)
      const unpacked = await extract(f)
      expect(fs.readFileSync(path.join(unpacked.stagingPath, 'prompts', '章节.json')).equals(Buffer.alloc(size, 'b'))).toBe(true)
    })

    function avatarSwap(f: Fixture) {
      const db = new Database(f.databasePath, { readonly: true })
      const old = db.prepare('SELECT character_id, relative_path FROM character_avatar_assets').get() as { character_id: string; relative_path: string }
      db.close()
      const avatar = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)])
      const relativePath = `avatars/${hash(old.character_id)}/2-${hash(avatar)}.png`
      let replaced = false
      const replaceOnce = () => {
        if (replaced) return
        replaced = true
        fs.writeFileSync(path.join(f.storage, ...relativePath.split('/')), avatar)
        const writer = new Database(f.databasePath)
        try {
          writer.prepare('UPDATE character_avatar_assets SET asset_revision=2, relative_path=?, content_hash=?, byte_size=? WHERE character_id=?')
            .run(relativePath, hash(avatar), avatar.length, old.character_id)
        } finally { writer.close() }
        fs.rmSync(path.join(f.storage, ...old.relative_path.split('/')))
      }
      const expectNewAvatar = async () => {
        const unpacked = await extract(f)
        const entry = unpacked.manifest.entries.find(item => item.disposition === 'avatar-asset')!
        expect(entry.path).toBe(relativePath)
        expect(fs.readFileSync(path.join(unpacked.stagingPath, ...entry.path.split('/')))).toEqual(avatar)
      }
      return { replaceOnce, expectNewAvatar }
    }

    it('换了头像、旧头像文件被回收：重来一次，存档里是新头像', async () => {
      const f = fixture()
      seedProject(f)
      const swap = avatarSwap(f)
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      await exportPortableProject(input(f, provider(), { __testHooks: { afterPortableDatabaseCreated: swap.replaceOnce } }))

      await swap.expectNewAvatar()
    })

    it('库快照取完、核对头像之前换了头像并回收旧文件：重来一次，存档里是新头像', async () => {
      const f = fixture()
      seedProject(f)
      const swap = avatarSwap(f)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const backup = Database.prototype.backup
      vi.spyOn(Database.prototype, 'backup').mockImplementation(async function (this: InstanceType<typeof Database>, ...args: Parameters<typeof backup>) {
        const result = await backup.apply(this, args)
        swap.replaceOnce()
        return result
      })

      await exportPortableProject(input(f))

      expect(exportLog(warn)).toEqual([expect.stringContaining('PORTABLE_ASSET_MISSING')])
      await swap.expectNewAvatar()
    })

    it('快照算哈希时资料刚被原子替换，打开的不是查过的那个文件：重来一次，存档里是完整的新内容', async () => {
      const f = fixture()
      const file = prompt(f, '{"提示":"快照时"}')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const openSync = fs.openSync.bind(fs) as (...args: unknown[]) => number
      let replaced = false
      vi.spyOn(fs, 'openSync').mockImplementation(((target: unknown, ...rest: unknown[]) => {
        if (!replaced && typeof target === 'string' && path.resolve(target) === path.resolve(file)) {
          replaced = true
          replaceAtomically(file, '{"提示":"打开前刚换的"}')
        }
        return openSync(target, ...rest)
      }) as typeof fs.openSync)

      await exportPortableProject(input(f, createPortableProjectAssetProvider()))

      expect(exportLog(warn)).toEqual([expect.stringContaining('PORTABLE_ARCHIVE_SOURCE_CHANGED')])
      const unpacked = await extract(f)
      expect(fs.readFileSync(path.join(unpacked.stagingPath, 'prompts', '章节.json'), 'utf8')).toBe('{"提示":"打开前刚换的"}')
    })

    it('算哈希途中资料被追加变大：只读到核对时的大小，当作资料被改重来，不读过存档上限', async () => {
      const MiB = 1024 * 1024
      archiveLimits.current.maxEntryBytes = 2 * MiB
      try {
        const f = fixture()
        const file = prompt(f, Buffer.alloc(MiB + MiB / 2, 'a'))
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const openSync = fs.openSync.bind(fs) as (...args: unknown[]) => number
        const readSync = fs.readSync.bind(fs) as (...args: unknown[]) => number
        const watched = new Set<number>()
        let bytesRead = 0, grown = false
        vi.spyOn(fs, 'openSync').mockImplementation(((target: unknown, ...rest: unknown[]) => {
          const descriptor = openSync(target, ...rest)
          if (typeof target === 'string' && path.resolve(target) === path.resolve(file)) watched.add(descriptor)
          return descriptor
        }) as typeof fs.openSync)
        vi.spyOn(fs, 'readSync').mockImplementation(((descriptor: number, ...rest: unknown[]) => {
          const read = readSync(descriptor, ...rest)
          if (!watched.has(descriptor)) return read
          bytesRead += read
          if (!grown) {
            grown = true
            fs.appendFileSync(file, Buffer.alloc(2 * MiB, 'b'))
          }
          return read
        }) as typeof fs.readSync)

        await expect(exportPortableProject(input(f, createPortableProjectAssetProvider()))).rejects.toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')

        expect(grown).toBe(true)
        expect(bytesRead).toBeLessThanOrEqual(2 * MiB)
        expect(exportLog(warn)).toEqual([expect.stringContaining('PORTABLE_ARCHIVE_SOURCE_CHANGED')])
        expect(fs.readdirSync(f.attemptParent)).toEqual([])
      } finally { Object.assign(archiveLimits.current, archiveLimits.defaults) }
    })

    it('头像文件坏了、和库行对不上：重来一次仍对不上，报头像损坏，不说资料被改', async () => {
      const f = fixture()
      const { avatar } = seedProject(f)
      const db = new Database(f.databasePath, { readonly: true })
      const relativePath = db.prepare('SELECT relative_path FROM character_avatar_assets').pluck().get() as string
      db.close()
      fs.writeFileSync(path.join(f.storage, ...relativePath.split('/')), Buffer.alloc(avatar.length, 0))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await expect(exportPortableProject(input(f))).rejects.toThrow('PORTABLE_EXPORT_AVATAR_DAMAGED')

      expect(exportLog(warn)).toEqual([expect.stringContaining('PORTABLE_EXPORT_AVATAR_DAMAGED')])
      expect(fs.existsSync(f.target)).toBe(false)
      expect(fs.readdirSync(f.attemptParent)).toEqual([])
    })

    it('作者删掉一份技能文件：重来一次，存档里没有它', async () => {
      const f = fixture()
      prompt(f, '{"提示":"留着"}')
      const skill = path.join(f.storage, 'skills', '旧技能.md')
      fs.mkdirSync(path.dirname(skill))
      fs.writeFileSync(skill, '删掉的技能')
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      await exportPortableProject(input(f, createPortableProjectAssetProvider(), { __testHooks: {
        afterPortableDatabaseCreated: () => fs.rmSync(skill, { force: true }),
      } }))

      const unpacked = await extract(f)
      expect(unpacked.manifest.entries.map(entry => entry.path)).toContain('prompts/章节.json')
      expect(unpacked.manifest.entries.map(entry => entry.path)).not.toContain('skills/旧技能.md')
    })

    it('打包器打开资料前它刚被删掉：重来一次，存档里没有它', async () => {
      const f = fixture()
      prompt(f, '{"提示":"留着"}')
      const skill = path.join(f.storage, 'skills', '旧技能.md')
      fs.mkdirSync(path.dirname(skill))
      fs.writeFileSync(skill, '打包时被删')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const open = fs.promises.open.bind(fs.promises)
      vi.spyOn(fs.promises, 'open').mockImplementation(((target: fs.PathLike, ...rest: [fs.OpenMode?, fs.Mode?]) => {
        if (String(target).endsWith('旧技能.md')) fs.rmSync(skill, { force: true })
        return open(target, ...rest)
      }) as typeof fs.promises.open)

      await exportPortableProject(input(f, createPortableProjectAssetProvider()))

      expect(exportLog(warn)).toEqual([expect.stringContaining('PORTABLE_ARCHIVE_SOURCE_CHANGED')])
      const unpacked = await extract(f)
      expect(unpacked.manifest.entries.map(entry => entry.path)).not.toContain('skills/旧技能.md')
    })

    it('重来一次资料又被改：报资料有改动，不发布存档，临时目录清干净', async () => {
      const f = fixture()
      const file = prompt(f, '{"提示":"快照时"}')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let round = 0

      await expect(exportPortableProject(input(f, createPortableProjectAssetProvider(), { __testHooks: {
        afterPortableDatabaseCreated: () => replaceAtomically(file, `{"提示":"第 ${++round} 次改的"}`),
      } }))).rejects.toThrow('PORTABLE_EXPORT_SOURCE_CHANGED')

      expect(exportLog(warn)).toHaveLength(1)
      expect(fs.existsSync(f.target)).toBe(false)
      expect(fs.readdirSync(f.attemptParent)).toEqual([])
    })

    it('打包前资料被换成指向项目外文件的硬链接（字节相同）：拒绝导出', async () => {
      const f = fixture()
      const file = prompt(f, '{"提示":"作者自己的"}')
      const outside = path.join(f.base, '项目外.json')
      fs.copyFileSync(file, outside)
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      await expect(exportPortableProject(input(f, createPortableProjectAssetProvider(), { __testHooks: { afterPortableDatabaseCreated: () => {
        if (fs.statSync(file).nlink > 1) return
        fs.rmSync(file)
        fs.linkSync(outside, file)
      } } }))).rejects.toThrow('PORTABLE_ASSET_UNSAFE')
      expect(fs.existsSync(f.target)).toBe(false)
    })

    it('资料不拷进导出临时目录：目标盘上不出现第二份资料', async () => {
      const f = fixture()
      const seeded = seedProject(f)
      const content = Buffer.from('{"提示":"只在作品目录里有一份"}'.repeat(64))
      prompt(f, content)
      const copies: string[] = []

      await exportPortableProject(input(f, createPortableProjectAssetProvider(), { __testHooks: { afterPortableDatabaseCreated: root => {
        for (const name of fs.readdirSync(root)) {
          const entry = path.join(root, name)
          if (!fs.statSync(entry).isFile()) continue
          const bytes = fs.readFileSync(entry)
          if (bytes.equals(content) || bytes.equals(seeded.avatar)) copies.push(name)
        }
      } } }))

      expect(copies).toEqual([])
      expect(fs.existsSync(f.target)).toBe(true)
    })
  })

  describe('查过之后、打开之前，文件所在目录被换成指向项目外的联接（#744）', () => {
    afterEach(() => { vi.restoreAllMocks() })

    function swapDirectoryBeforeOpen(f: Fixture, file: string) {
      const directory = path.dirname(file)
      const outside = fs.mkdtempSync(path.join(f.base, '项目外-'))
      fs.writeFileSync(path.join(outside, path.basename(file)), Buffer.alloc(fs.statSync(file).size, 'x'))
      const openSync = fs.openSync.bind(fs) as (...args: unknown[]) => number
      const state = { swapped: false }
      vi.spyOn(fs, 'openSync').mockImplementation(((target: unknown, ...rest: unknown[]) => {
        if (!state.swapped && typeof target === 'string' && path.resolve(target) === path.resolve(file)) {
          state.swapped = true
          fs.renameSync(directory, `${outside}-原目录`)
          fs.symlinkSync(outside, directory, 'junction')
        }
        return openSync(target, ...rest)
      }) as typeof fs.openSync)
      return state
    }

    it('资料：拒绝导出，项目外的字节不进存档', async () => {
      const f = fixture()
      const prompt = path.join(f.storage, 'prompts', '章节.txt')
      fs.mkdirSync(path.dirname(prompt))
      fs.writeFileSync(prompt, '作者自己的提示词')
      const state = swapDirectoryBeforeOpen(f, prompt)

      await expect(exportPortableProject(input(f, createPortableProjectAssetProvider()))).rejects.toThrow('PORTABLE_ASSET_UNSAFE')
      expect(state.swapped).toBe(true)
      expect(fs.existsSync(f.target)).toBe(false)
      expect(fs.readdirSync(f.attemptParent)).toEqual([])
    })

    it('头像：拒绝导出，项目外的字节不进存档', async () => {
      const f = fixture()
      seedProject(f)
      const db = new Database(f.databasePath, { readonly: true })
      const relativePath = db.prepare('SELECT relative_path FROM character_avatar_assets').pluck().get() as string
      db.close()
      const state = swapDirectoryBeforeOpen(f, path.join(f.storage, ...relativePath.split('/')))

      await expect(exportPortableProject(input(f))).rejects.toThrow('PORTABLE_ASSET_UNSAFE')
      expect(state.swapped).toBe(true)
      expect(fs.existsSync(f.target)).toBe(false)
    })
  })

  describe('资料超出存档上限：不把资料写到目标盘（#744）', () => {
    const MiB = 1024 * 1024
    afterEach(() => {
      vi.restoreAllMocks()
      Object.assign(archiveLimits.current, archiveLimits.defaults)
    })

    function countWrittenBytes() {
      const counter = { bytes: 0 }
      const writeSync = fs.writeSync.bind(fs) as (...args: unknown[]) => number
      vi.spyOn(fs, 'writeSync').mockImplementation(((...args: unknown[]) => {
        const written = writeSync(...args)
        counter.bytes += written
        return written
      }) as typeof fs.writeSync)
      return counter
    }

    function prompts(f: Fixture, sizes: readonly number[]): string[] {
      fs.mkdirSync(path.join(f.storage, 'prompts'))
      return sizes.map((size, index) => {
        const file = path.join(f.storage, 'prompts', `设定-${index}.txt`)
        fs.writeFileSync(file, Buffer.alloc(size, 'a'))
        return file
      })
    }

    it('单份资料超过单项上限', async () => {
      const f = fixture()
      archiveLimits.current.maxEntryBytes = 2 * MiB
      prompts(f, [3 * MiB])
      const written = countWrittenBytes()

      await expect(exportPortableProject(input(f, createPortableProjectAssetProvider()))).rejects.toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
      expect(written.bytes).toBeLessThan(MiB)
      expect(fs.readdirSync(f.attemptParent)).toEqual([])
    })

    it('每份都没超单项上限，加起来超过总量上限', async () => {
      const f = fixture()
      archiveLimits.current.maxEntryBytes = 2 * MiB
      archiveLimits.current.maxTotalBytes = 3 * MiB
      prompts(f, [2 * MiB, 2 * MiB])
      const written = countWrittenBytes()

      await expect(exportPortableProject(input(f, createPortableProjectAssetProvider()))).rejects.toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
      expect(written.bytes).toBeLessThanOrEqual(3 * MiB)
    })
  })

  describe('与资料无关、重来也不会变的错误：只跑一遍，不重来（#744）', () => {
    afterEach(() => {
      vi.restoreAllMocks()
      Object.assign(archiveLimits.current, archiveLimits.defaults)
    })

    function counted(f: Fixture) {
      const assets = createPortableProjectAssetProvider()
      const runs = { snapshots: 0 }
      fs.mkdirSync(path.join(f.storage, 'prompts'), { recursive: true })
      fs.writeFileSync(path.join(f.storage, 'prompts', '设定.txt'), Buffer.alloc(3 * 1024 * 1024, 'a'))
      return { runs, assets: { snapshot: (request: Parameters<typeof assets.snapshot>[0]) => { runs.snapshots += 1; return assets.snapshot(request) } } }
    }

    async function expectSingleRun(f: Fixture, overrides: Partial<ExportPortableProjectInput>, code: string, snapshots: number) {
      const { runs, assets } = counted(f)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await expect(exportPortableProject(input(f, assets, overrides))).rejects.toThrow(code)
      expect(runs.snapshots).toBe(snapshots)
      expect(warn.mock.calls.filter(call => String(call[0]).startsWith('[portable-export]'))).toEqual([])
      expect(fs.readdirSync(f.attemptParent)).toEqual([])
    }

    it('存档上限', async () => {
      const f = fixture()
      archiveLimits.current.maxEntryBytes = 2 * 1024 * 1024
      await expectSingleRun(f, {}, 'PORTABLE_ARCHIVE_LIMIT_EXCEEDED', 1)
    })

    it('目标文件已存在', async () => {
      const f = fixture()
      fs.writeFileSync(f.target, '作者原有的文件')
      await expectSingleRun(f, {}, 'PORTABLE_ARCHIVE_TARGET_EXISTS', 1)
      expect(fs.readFileSync(f.target, 'utf8')).toBe('作者原有的文件')
    })

    it('目标在作品目录里', async () => {
      const f = fixture()
      await expectSingleRun(f, { targetArchivePath: path.join(f.root, '副本.ainovel') }, 'PORTABLE_TARGET_INSIDE_SOURCE', 0)
    })

    it('上下文无效', async () => {
      const f = fixture()
      await expectSingleRun(f, { projectSession: { ...f.session, leaseId: 'lease-stale' } }, 'PORTABLE_CONTEXT_INVALID', 0)
    })

    it('打包完、发布前作品被关掉', async () => {
      const f = fixture()
      let checks = 0
      await expectSingleRun(f, { assertCurrentContext: () => ++checks < 3 }, 'PORTABLE_CONTEXT_INVALID', 1)
    })
  })

  describe('导出排在知识库闸门后面等待时，作品被换掉或关掉（#744）', () => {
    afterEach(() => { vi.restoreAllMocks() })

    function holdGate(f: Fixture) {
      activateCanonicalProjectData(f.root)
      let release!: () => void
      const released = new Promise<void>(resolve => { release = resolve })
      const held = withKnowledgeSourceGate(getProjectDataRoot(f.root), () => released)
      return { held, whenExportQueues: (action: () => void) => {
        gateRequests.onRequest = () => { gateRequests.onRequest = undefined; action(); release() }
      } }
    }

    it('等待期间库文件被换成另一本书：拒绝导出，不发布另一本书的内容', async () => {
      const f = fixture()
      seedProject(f)
      const other = fixture()
      const gate = holdGate(f)
      gate.whenExportQueues(() => {
        fs.renameSync(f.databasePath, `${f.databasePath}.原书`)
        fs.copyFileSync(other.databasePath, f.databasePath)
      })

      try { await expect(exportPortableProject(input(f))).rejects.toThrow('PROJECT_MIGRATION_SOURCE_CHANGED') }
      finally { gateRequests.onRequest = undefined }
      await gate.held
      expect(fs.existsSync(f.target)).toBe(false)
    })

    it('取到闸门、核对过库文件之后才换成另一本书：拒绝导出，不发布另一本书的内容', async () => {
      const f = fixture()
      seedProject(f)
      const other = fixture()
      const lstatSync = fs.lstatSync.bind(fs)
      const gate = holdGate(f)
      gate.whenExportQueues(() => {
        const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
          const info = (lstatSync as (...args: unknown[]) => unknown)(file, ...rest)
          if (path.resolve(String(file)) === path.resolve(f.databasePath)) {
            spy.mockRestore()
            fs.renameSync(f.databasePath, `${f.databasePath}.原书`)
            fs.copyFileSync(other.databasePath, f.databasePath)
          }
          return info
        }) as typeof fs.lstatSync)
      })

      try { await expect(exportPortableProject(input(f))).rejects.toThrow('PROJECT_MIGRATION_SOURCE_CHANGED') }
      finally { gateRequests.onRequest = undefined }
      await gate.held
      expect(fs.existsSync(f.target)).toBe(false)
    })

    it('等待期间作品被关掉：拒绝导出，源目录里不多出 SQLite 旁文件', async () => {
      const f = fixture()
      seedProject(f)
      const sidecars = () => fs.readdirSync(f.storage).filter(name => /^project\.db-(wal|shm)$/u.test(name)).sort()
      const before = sidecars()
      let closed = false
      const gate = holdGate(f)
      gate.whenExportQueues(() => { closed = true })

      try {
        await expect(exportPortableProject(input(f, provider(), {
          assertCurrentContext: () => { if (closed) throw new Error('closed') },
        }))).rejects.toThrow('PORTABLE_CONTEXT_INVALID')
      } finally { gateRequests.onRequest = undefined }
      await gate.held
      expect(sidecars()).toEqual(before)
      expect(fs.existsSync(f.target)).toBe(false)
    })
  })

  it('列资料途中作品存储目录被换成指向项目外的联接：拒绝导出，项目外的字节不进存档（#744）', async () => {
    const f = fixture()
    const prompt = path.join(f.storage, 'prompts', '章节.txt')
    fs.mkdirSync(path.dirname(prompt))
    fs.writeFileSync(prompt, '作者自己的提示词')
    const outside = path.join(f.base, '项目外存储')
    fs.mkdirSync(path.join(outside, 'prompts'), { recursive: true })
    fs.writeFileSync(path.join(outside, 'prompts', '章节.txt'), Buffer.alloc(fs.statSync(prompt).size, 'x'))
    const lstatSync = fs.lstatSync.bind(fs) as (...args: unknown[]) => fs.Stats
    let swapped = false
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: unknown, ...rest: unknown[]) => {
      if (!swapped && typeof target === 'string' && path.resolve(target) === prompt) {
        swapped = true
        fs.renameSync(f.storage, `${f.storage}-原目录`)
        fs.symlinkSync(outside, f.storage, 'junction')
      }
      return lstatSync(target, ...rest)
    }) as typeof fs.lstatSync)

    try {
      await expect(exportPortableProject(input(f, createPortableProjectAssetProvider()))).rejects.toThrow('PORTABLE_ASSET_UNSAFE')
    } finally { vi.restoreAllMocks() }
    expect(swapped).toBe(true)
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('导出时知识库正在导入，草稿保存先提交：存档里的知识库不比库新（#744）', async () => {
    const f = fixture()
    seedProject(f)
    let knowledge = '知识库：只有第一章'
    let finishImport!: () => void
    activateCanonicalProjectData(f.root)
    const imported = new Promise<void>(resolve => {
      finishImport = () => { knowledge = '知识库：已收进第二章'; resolve() }
    })
    const importing = withKnowledgeSourceGate(getProjectDataRoot(f.root), () => imported)
    gateRequests.onRequest = () => {
      gateRequests.onRequest = undefined
      const db = new Database(f.databasePath)
      try {
        db.prepare('INSERT INTO contents(id,body) VALUES(2,?)').run('第二章草稿')
        db.prepare(`INSERT INTO drafts_all(id,chapter_number,version,status,source,content_id,word_count,source_dependencies)
          VALUES(2,2,1,'draft','write',2,5,'[]')`).run()
      } finally { db.close() }
      finishImport()
    }
    const assets: ExportPortableProjectInput['assets'] = {
      async snapshot({ sourceProjectRoot }) {
        const text = await withKnowledgeSourceGate(path.join(path.resolve(sourceProjectRoot), CANONICAL_PROJECT_DIRECTORY), () => knowledge)
        return { files: [providedFile(PORTABLE_KNOWLEDGE_SOURCE_PATH, text, 'knowledge-source')] }
      },
    }

    try { await exportPortableProject(input(f, assets)) }
    finally { gateRequests.onRequest = undefined }
    await importing
    const unpacked = await extract(f)
    expect(fs.readFileSync(path.join(unpacked.stagingPath, PORTABLE_KNOWLEDGE_SOURCE_PATH), 'utf8')).toBe('知识库：已收进第二章')
    const archived = new Database(path.join(unpacked.stagingPath, CANONICAL_PROJECT_DATABASE), { readonly: true })
    try {
      expect(archived.prepare('SELECT body FROM contents WHERE id = 2').pluck().get()).toBe('第二章草稿')
    } finally { archived.close() }
  })

  it('rejects an export whose combined frozen history cannot be read back', async () => {
    const f = fixture()
    seedProject(f)
    const db = new Database(f.databasePath)
    const artifact = JSON.parse(db.prepare('SELECT artifact_json FROM generation_artifacts').pluck().get() as string)
    artifact.text = 'a'.repeat(9 * 1024 * 1024); artifact.textHash = hash(artifact.text)
    db.prepare('UPDATE generation_artifacts SET artifact_json=?').run(JSON.stringify(artifact))
    const attempt = JSON.parse(db.prepare('SELECT attempt_json FROM generation_attempts').pluck().get() as string)
    db.prepare('INSERT INTO generation_attempts VALUES(?,?,?,?,?,?,?)').run('attempt-2', 'reservation-2', 'run-1', 'root-1',
      JSON.stringify({ ...attempt, attemptId: 'attempt-2', reservationId: 'reservation-2' }), null, 'invocation-2')
    db.prepare('INSERT INTO generation_artifacts VALUES(?,?,?,?,?,?)').run('artifact-2', 'attempt-2', 'run-1',
      JSON.stringify({ ...artifact, artifactId: 'artifact-2', attemptId: 'attempt-2' }), 2, 'partial')
    db.close()
    await expect(exportPortableProject(input(f))).rejects.toThrow('PORTABLE_RUNTIME_FREEZE_INVALID')
    expect(fs.existsSync(f.target)).toBe(false)
    const source = new Database(f.databasePath, { readonly: true })
    try { expect(source.prepare('SELECT COUNT(*) FROM generation_artifacts').pluck().get()).toBe(2) }
    finally { source.close() }
  })

  it.each(['character-delete', 'runtime-replace', 'runtime-remove'])('exports %s avatar provenance with its retained asset', async provenance => {
    const f = fixture()
    seedProject(f)
    const db = new Database(f.databasePath)
    db.exec(`INSERT INTO character_avatar_unresolved(record_id,disposition,source_reference,source_relative_path,
      preserved_relative_path,content_hash,mime,byte_size,candidate_character_ids_json)
      SELECT 'orphan-1','orphan','${provenance}:'||character_id,relative_path,relative_path,content_hash,mime,byte_size,'[]'
      FROM character_avatar_assets`)
    db.exec('DELETE FROM character_avatar_assets'); db.close()
    await exportPortableProject(input(f))
    const restoredRoot = path.join(f.base, 'restored-avatar')
    await restorePortableProject({ archivePath: f.target, targetProjectRoot: restoredRoot })
    const restored = new Database(path.join(restoredRoot, '.ai-novel', 'project.db'), { readonly: true })
    try { expect(restored.prepare('SELECT source_reference FROM character_avatar_unresolved').pluck().get()).toMatch(new RegExp(`^${provenance}:`)) }
    finally { restored.close() }
  })

  it.each([1, 2] as const)('roundtrips a wrapped recheck with report derivation v%i and unchanged saved ACK', async version => {
    const f = fixture(), seeded = seedMergedCycle(f, {}, undefined, { recheckReportVersion: version })
    await exportPortableProject(input(f))
    const targetRoot = path.join(f.base, 'restored-recheck')
    await restorePortableProject({ archivePath: f.target, targetProjectRoot: targetRoot })
    const restored = new Database(path.join(targetRoot, '.ai-novel', 'project.db'), { readonly: true })
    try {
      const usage = JSON.parse(restored.prepare("SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id='attempt-recheck'")
        .pluck().get() as string)
      expect(usage.reviewRevisionEffect.reportVersion).toBe(version === 2 ? 2 : undefined)
      expect(usage.reviewCycleRecheck.version).toBe(2)
      expect(verifyM03ReviewCycle(restored)).toBe(true)
      const runs = new GenerationRunRepository(() => restored), run = runs.get('run-recheck')
      const scope = { projectId: run.binding.projectId, epoch: run.binding.epoch }
      const service = new ReviewRevisionGeneration(restored, runs, scope, () => {})
      const saved = service.commitReview({ contextId: 'saved-replay', handle: { ...scope, rootActionId: run.rootActionId, runId: run.runId },
        artifact: usage.reviewRevisionEffect.artifact }, () => { throw new Error('SAVED_REPLAY_MUST_NOT_RESUME') })
      expect(saved.content).toBe(seeded.recheckBody)
      expect(saved.contentHash).toBe(hash(seeded.recheckBody!))
      expect(runs.receipt('attempt-recheck').artifact?.text).toContain('复核说明\n```json\n')
    } finally { restored.close() }
  })

  it.each([1, 2] as const)('roundtrips an immutable v7 merged cycle and saved report version %i without local diagnostics', async version => {
    const f = fixture()
    const secret = 'private-diagnostics-sentinel'
    const seeded = seedMergedCycle(f, {}, undefined, { longReport: true, ...(version === 2 ? { reportVersion: 2 } : {}),
      diagnostics: { startedAt: 1, elapsedMs: 2, firstResponseMs: 1, lastResponseMs: 2, lastOutputMs: 2,
        phase: 'complete', endReason: 'completed', visibleEvents: 1, reasoningEvents: 0, errorCode: secret } })
    const sourceBefore = fs.readFileSync(f.databasePath)
    await exportPortableProject(input(f))
    expect(fs.readFileSync(f.databasePath)).toEqual(sourceBefore)
    expect(fs.readFileSync(f.target).includes(Buffer.from(secret))).toBe(false)
    const targetRoot = path.join(f.base, 'restored')
    await restorePortableProject({ archivePath: f.target, targetProjectRoot: targetRoot })
    expect(fs.readFileSync(path.join(targetRoot, '.ai-novel', 'project.db')).includes(Buffer.from(secret))).toBe(false)
    const freeze = readPortableRuntimeFreeze(targetRoot)
    for (const attemptId of ['attempt-review', 'attempt-revision']) {
      expect(() => freeze.assertMutable('generation_attempts', attemptId)).toThrow('PORTABLE_RUNTIME_FROZEN')
    }
    const restored = new Database(path.join(targetRoot, '.ai-novel', 'project.db'), { readonly: true })
    try {
      for (const receipt of restored.prepare('SELECT usage_receipt_json FROM generation_attempts').pluck().all() as string[]) {
        expect(JSON.parse(receipt).result).toEqual({ finishReason: 'stop' })
      }
      expect(restored.prepare('SELECT cycle_id,body FROM review_cycle_merges').get()).toEqual({
        cycle_id: seeded.cycleId, body: seeded.body,
      })
      expect(restored.prepare('SELECT merged_hash FROM review_cycles WHERE cycle_id=?').pluck().get(seeded.cycleId))
        .toBe(seeded.mergedHash)
      expect(hash(restored.prepare('SELECT body FROM review_cycle_merges WHERE cycle_id=?').pluck().get(seeded.cycleId) as string))
        .toBe(seeded.mergedHash)
      const restoredBinding = restored.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-review'")
        .pluck().get() as string
      expect(restoredBinding).not.toContain('private-credential-sentinel')
      expect(restoredBinding).not.toContain('private-machine-sentinel')
      const usage = JSON.parse(restored.prepare("SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id='attempt-review'")
        .pluck().get() as string)
      expect(usage.reviewRevisionEffect.reportVersion).toBe(version === 2 ? 2 : undefined)
      expect(verifyM03ReviewCycle(restored)).toBe(true)
      const runs = new GenerationRunRepository(() => restored), run = runs.get('run-review')
      const scope = { projectId: run.binding.projectId, epoch: run.binding.epoch }
      const service = new ReviewRevisionGeneration(restored, runs, scope, () => {})
      const saved = service.commitReview({ contextId: 'saved-replay', handle: { ...scope, rootActionId: run.rootActionId, runId: run.runId },
        artifact: usage.reviewRevisionEffect.artifact }, () => { throw new Error('SAVED_REPLAY_MUST_NOT_RESUME') })
      expect(saved.content).toBe(seeded.reviewBody)
      expect(saved.contentHash).toBe(hash(seeded.reviewBody))
      expect(saved.source.content).toBe(JSON.parse(restoredBinding).sourceManifest.reviewRevisionContext.source.content)
    } finally { restored.close() }
  })

  it('审稿报告保存后，同一循环的修稿卡点了「不再恢复」，项目照样能导出', async () => {
    const f = fixture()
    seedMergedCycle(f)
    const db = new Database(f.databasePath)
    try { new GenerationRunRepository(() => db).recordRecoveryAbandonment('run-revision', { 'artifact-revision': 14 }) }
    finally { db.close() }
    const sourceBefore = fs.readFileSync(f.databasePath)
    await exportPortableProject(input(f))
    expect(fs.readFileSync(f.databasePath)).toEqual(sourceBefore)
    const targetRoot = path.join(f.base, 'restored-abandoned')
    await restorePortableProject({ archivePath: f.target, targetProjectRoot: targetRoot })
    const restored = new Database(path.join(targetRoot, '.ai-novel', 'project.db'), { readonly: true })
    try {
      const binding = JSON.parse(restored.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-revision'").pluck().get() as string)
      expect(Object.keys(binding).filter(key => key.startsWith('$'))).toEqual([])
      expect(binding.sourceManifest.operation).toBe('refine-from-review')
    } finally { restored.close() }
  })

  it('rejects unknown fields in a saved review result', async () => {
    const f = fixture()
    seedMergedCycle(f)
    const db = new Database(f.databasePath)
    try {
      db.prepare("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.result.extra','private-extra-sentinel')").run()
    } finally { db.close() }
    const sourceBefore = fs.readFileSync(f.databasePath)
    await expect(exportPortableProject(input(f))).rejects.toMatchObject({ code: 'PORTABLE_UNSAFE_PROJECTION' })
    expect(fs.readFileSync(f.databasePath)).toEqual(sourceBefore)
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it.each([
    ['secretRef', 'private-credential-sentinel'],
    ['machinePath', 'C:\\Users\\EthanQ\\private-machine-sentinel'],
  ])('fails closed for a merged cycle context containing %s', async (key, sentinel) => {
    const f = fixture()
    seedMergedCycle(f, { [key]: sentinel })
    await expect(exportPortableProject(input(f))).rejects.toMatchObject({ code: 'PORTABLE_UNSAFE_PROJECTION' })
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('rejects a secret hidden in the wrong config field while the source cycle remains valid', async () => {
    const f = fixture()
    seedMergedCycle(f, { text: 'private-credential-sentinel' })
    await expect(exportPortableProject(input(f))).rejects.toMatchObject({ code: 'PORTABLE_UNSAFE_PROJECTION' })
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('rejects extra recheck receipt content while the source cycle remains valid', async () => {
    const f = fixture()
    seedMergedCycle(f, {}, { version: 2, cycleId: 'cycle-merge', comparisonVersion: 1,
      mergedHash: hash('甲推开门，作者手工合并了新正文。'), findingSetHash: canonicalM03FindingSetHash([]),
      findings: [], text: 'C:\\Users\\EthanQ\\private-machine-sentinel' })
    await expect(exportPortableProject(input(f))).rejects.toMatchObject({ code: 'PORTABLE_UNSAFE_PROJECTION' })
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('exports the shared 20-chapter corpus with authority, assets and frozen runtime history', async () => {
    const f = await createProjectArchiveRoundtripFixture()
    try {
      const sourceBefore = fs.readFileSync(f.sourceDatabasePath)
      await f.exportArchive()
      expect(fs.readFileSync(f.sourceDatabasePath)).toEqual(sourceBefore)

      const extractParent = path.join(f.base, 'shared-export-inspect')
      fs.mkdirSync(extractParent)
      const unpacked = await extractPortableProjectArchive({ archivePath: f.archivePath, stagingParentPath: extractParent })
      expect(unpacked.manifest.entries.map(entry => entry.path)).toEqual(expect.arrayContaining([
        'project.db', 'portable-runtime-freeze.json', '.ai-novel/portable-transfer-authority.json',
        'portable-knowledge-source.json', 'prompts/draft.json', 'skills/roundtrip/SKILL.md',
        'writing-skills.json', 'partial_arch/history.json', expect.stringMatching(/^avatars\//u),
      ]))
      const portable = new Database(path.join(unpacked.stagingPath, 'project.db'), { readonly: true })
      try {
        expect(portable.prepare("SELECT COUNT(*) FROM drafts WHERE status='finalized'").pluck().get()).toBe(20)
        expect(Buffer.from(portable.prepare('SELECT body FROM contents WHERE id=20').pluck().get() as string))
          .toEqual(f.chapter20BodyBytes)
        expect(portable.prepare('SELECT character_id FROM characters ORDER BY character_id').pluck().all())
          .toEqual([f.characterId, f.supportingCharacterId])
        expect(portable.prepare('SELECT relation FROM character_relationships').pluck().get()).toBe('盟友')
        expect(portable.prepare("SELECT status FROM recovery_candidates WHERE candidate_id='candidate-old'").pluck().get()).toBe('pending')
        expect(JSON.parse(portable.prepare("SELECT attempt_json FROM generation_attempts WHERE attempt_id='attempt-unknown'")
          .pluck().get() as string)).toMatchObject({ status: 'unknown' })
        expect(portable.prepare("SELECT publication_status FROM finalization_outbox WHERE finalization_id='outbox-old'").pluck().get()).toBe('pending')
        expect(portable.prepare("SELECT status FROM import_runs WHERE id='import-old'").pluck().get()).toBe('ready')
        expect(portable.prepare("SELECT execution_owner FROM import_runs WHERE id='import-old'").pluck().get()).toBe('')
      } finally { portable.close() }
      const avatar = unpacked.manifest.entries.find(entry => entry.disposition === 'avatar-asset')!
      expect(fs.readFileSync(path.join(unpacked.stagingPath, ...avatar.path.split('/')))).toEqual(f.avatarBytes)
      const freeze = JSON.parse(fs.readFileSync(path.join(unpacked.stagingPath, 'portable-runtime-freeze.json'), 'utf8'))
      expect(freeze.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'recovery_candidates', recordId: 'candidate-old', nonReplayable: true }),
        expect.objectContaining({ table: 'generation_attempts', recordId: 'attempt-unknown', nonReplayable: true }),
        expect.objectContaining({ table: 'finalization_outbox', recordId: 'outbox-old', nonReplayable: true }),
        expect.objectContaining({ table: 'import_runs', recordId: 'import-old', nonReplayable: true }),
      ]))
      const transfer = JSON.parse(fs.readFileSync(path.join(
        unpacked.stagingPath, '.ai-novel', 'portable-transfer-authority.json',
      ), 'utf8'))
      expect(transfer).toMatchObject({ originProjectId: f.sourceProjectId, targetProjectId: null })
      expect(transfer.finalizations).toHaveLength(20)
      expect(transfer.summarySources).toHaveLength(20)
      for (const entry of unpacked.manifest.entries) {
        const bytes = fs.readFileSync(path.join(unpacked.stagingPath, ...entry.path.split('/')))
        for (const forbidden of f.sensitiveValues) expect(bytes.includes(Buffer.from(forbidden))).toBe(false)
      }
    } finally { f.dispose() }
  })

  it('exports and restores an author import that left several effect receipts (#607)', async () => {
    const f = await createProjectArchiveRoundtripFixture()
    try {
      const namespace = `import:author-manuscript:${AUTHOR_IMPORT_RUN_ID}`
      const expected = AUTHOR_IMPORT_EFFECTS.map(effect => ({ stage: effect.stage, batch: effect.batchId, namespace, key: effect.effectKey }))
        .sort((left, right) => `${left.stage}:${left.batch}`.localeCompare(`${right.stage}:${right.batch}`))
      const sourceBefore = fs.readFileSync(f.sourceDatabasePath)
      await f.exportAndRestore()
      expect(fs.readFileSync(f.sourceDatabasePath)).toEqual(sourceBefore)

      const restored = new Database(f.targetDatabasePath, { readonly: true })
      try {
        const ledger = (table: string) => restored.prepare(`SELECT stage,batch_id AS batch,effect_namespace AS namespace,
          effect_key AS key FROM ${table} WHERE run_id=? ORDER BY stage,batch_id`).all(AUTHOR_IMPORT_RUN_ID)
        expect(ledger('import_run_receipts')).toEqual(expected)
        expect(ledger('import_effect_ledger')).toEqual(expected)
        expect(restored.prepare('SELECT effect_namespace,status FROM import_runs WHERE id=?').get(AUTHOR_IMPORT_RUN_ID))
          .toEqual({ effect_namespace: namespace, status: 'completed' })
      } finally { restored.close() }
      const frozen = readPortableRuntimeFreeze(f.targetRoot)
      expect(() => frozen.assertMutable('import_runs', AUTHOR_IMPORT_RUN_ID)).toThrow('PORTABLE_RUNTIME_FROZEN')
    } finally { f.dispose() }
  })

  it('leaves the source database untouched whether or not the import receipts project', async () => {
    const f = await createProjectArchiveRoundtripFixture()
    try {
      const sourceBefore = fs.readFileSync(f.sourceDatabasePath)
      await Promise.allSettled([f.exportArchive()])
      expect(fs.readFileSync(f.sourceDatabasePath)).toEqual(sourceBefore)
    } finally { f.dispose() }
  })

  it('re-exports a copy restored from an older archive whose import identifiers were already blanked', async () => {
    const f = fixture()
    seedProject(f)
    const db = new Database(f.databasePath)
    db.pragma('foreign_keys = ON')
    try {
      insertAuthorImportReceipts(db)
      db.prepare("UPDATE import_runs SET effect_namespace=''").run()
      db.prepare("UPDATE import_run_receipts SET effect_namespace='',effect_key='' WHERE stage='global'").run()
    } finally { db.close() }
    await exportPortableProject(input(f))
    const unpacked = await extract(f)
    const portable = new Database(path.join(unpacked.stagingPath, 'project.db'), { readonly: true })
    try {
      expect(portable.prepare('SELECT effect_namespace AS namespace,effect_key AS key FROM import_run_receipts ORDER BY stage').all())
        .toEqual([
          { namespace: `import:author-manuscript:${AUTHOR_IMPORT_RUN_ID}`, key: AUTHOR_IMPORT_EFFECTS[1].effectKey },
          { namespace: '', key: '' },
        ])
      expect(portable.prepare('SELECT DISTINCT effect_namespace FROM import_runs').pluck().all()).toEqual([''])
    } finally { portable.close() }
  })

  it('refuses an import effect key that is not a domain-safe identifier, with a readable code and no archive', async () => {
    const f = fixture()
    seedProject(f)
    const db = new Database(f.databasePath)
    db.pragma('foreign_keys = ON')
    try {
      insertAuthorImportReceipts(db)
      db.prepare("UPDATE import_run_receipts SET effect_key='C:\\Users\\writer\\原稿.txt' WHERE stage='global'").run()
    } finally { db.close() }
    const before = fs.readFileSync(f.databasePath)
    await expect(exportPortableProject(input(f))).rejects.toMatchObject({ code: 'PORTABLE_UNSAFE_PROJECTION' })
    expect(fs.existsSync(f.target)).toBe(false)
    expect(fs.readFileSync(f.databasePath)).toEqual(before)
  })

  it('keeps SQLite sidecar paths below the Windows limit under a long cloud staging parent', async () => {
    const f = fixture()
    const legacySuffix = path.join('.portable-export-attempt-123456', 'source-final-verification.db-wal')
    const padding = 263 - path.join(f.base, legacySuffix).length - 1
    expect(padding).toBeGreaterThan(0)
    const stagingParent = path.join(f.base, 'x'.repeat(padding))
    fs.mkdirSync(stagingParent)
    expect(path.join(stagingParent, legacySuffix).length).toBe(263)
    const targetArchivePath = path.join(stagingParent, 'backup.ainovel')
    const sourceBefore = fs.readFileSync(f.databasePath)
    const receipt = await exportPortableProject(input(f, provider(), {
      attemptParentPath: stagingParent,
      targetArchivePath,
      __testHooks: { afterPortableDatabaseCreated(attemptRoot) {
        expect(path.join(attemptRoot, 'source-final-verification.db-wal').length).toBeLessThan(260)
      } },
    }))
    expect(receipt.targetSha256).toBe(hash(fs.readFileSync(targetArchivePath)))
    expect(fs.readFileSync(f.databasePath)).toEqual(sourceBefore)
    expect(fs.readdirSync(stagingParent)).toEqual(['backup.ainovel'])
  })

  it('exports canonical v7 domain data, explicit assets and F03 avatars while freezing runtime history', async () => {
    const f = fixture()
    const seeded = seedProject(f)
    const assets = [
      providedFile('knowledge/世界观.txt', '城门只在雨夜开启。', 'knowledge-source'),
      providedFile('prompts/章节提示.txt', '保持克制。', 'prompt'),
      providedFile('skills/悬疑.md', '逐步揭示线索。', 'skill'),
      providedFile('candidates/旧候选.txt', '候选正文', 'author-content'),
    ]
    const before = fs.readFileSync(f.databasePath)
    const contextCalls: string[] = []
    const receipt = await exportPortableProject(input(f, provider(assets), {
      assertCurrentContext: context => { contextCalls.push(context.leaseId) },
    }))
    expect(receipt).toMatchObject({
      originProjectId: f.projectId,
      snapshotGeneration: 'generation-test-1',
      requiresRuntimeFreezeGuard: true,
      sourceEvidence: { schemaVersion: 10, tableCount: 55, fieldCount: 520 },
    })
    expect(contextCalls).toEqual(['lease-current', 'lease-current', 'lease-current'])
    expect(fs.readFileSync(f.databasePath)).toEqual(before)
    expect(fs.readdirSync(f.attemptParent)).toEqual([])

    const unpacked = await extract(f)
    expect(unpacked.manifest.declaredCompressedBytes).toBe(unpacked.manifest.declaredUncompressedBytes)
    expect(unpacked.manifest.semanticCounts['table.contents']).toBe(1)
    expect(unpacked.manifest.semanticCounts['table.review_cycle_merges']).toBe(0)
    expect(unpacked.manifest.entries.map(entry => entry.path)).toEqual(expect.arrayContaining([
      'project.db', 'portable-runtime-freeze.json', 'knowledge/世界观.txt', 'prompts/章节提示.txt',
      'skills/悬疑.md', 'candidates/旧候选.txt', '.ai-novel/portable-transfer-authority.json',
      expect.stringMatching(/^avatars\//u),
    ]))
    const transferEntry = unpacked.manifest.entries.find(entry => entry.path === '.ai-novel/portable-transfer-authority.json')!
    expect(transferEntry.disposition).toBe('transfer-receipt')
    const transfer = JSON.parse(fs.readFileSync(path.join(unpacked.stagingPath, ...transferEntry.path.split('/')), 'utf8'))
    expect(unpacked.manifest.transferReceiptIds).toContain(transfer.receiptId)
    expect(transfer).toMatchObject({
      originProjectId: f.projectId,
      targetProjectId: null,
      snapshotGeneration: 'generation-test-1',
      requiresRuntimeFreezeGuard: true,
    })
    const portable = new Database(path.join(unpacked.stagingPath, 'project.db'), { readonly: true })
    try {
      expect(portable.pragma('user_version', { simple: true })).toBe(10)
      expect(portable.prepare('SELECT COUNT(*) FROM review_cycle_merges').pluck().get()).toBe(0)
      expect(portable.prepare('SELECT body FROM contents WHERE id=1').pluck().get()).toBe(seeded.body)
      expect(portable.prepare('SELECT relation FROM character_relationships').pluck().get()).toBe('盟友')
      expect(portable.prepare('SELECT publication_status FROM finalization_outbox').pluck().get()).toBe('pending')
      expect(portable.prepare('SELECT status FROM recovery_candidates').pluck().get()).toBe('pending')
      expect(portable.prepare('SELECT status FROM generation_runs').pluck().get()).toBe('running')
      expect(portable.prepare('SELECT COUNT(*) FROM import_legacy_identity_bridge').pluck().get()).toBe(0)
      expect(portable.prepare('SELECT execution_owner FROM import_runs').pluck().get()).toBe('')
      expect(JSON.parse(portable.prepare('SELECT artifact_json FROM generation_artifacts').pluck().get() as string))
        .toMatchObject({ text: '候选续写 C:\\作者设定\\地点', revision: 1 })
    } finally { portable.close() }
    const avatarEntry = unpacked.manifest.entries.find(entry => entry.disposition === 'avatar-asset')!
    expect(fs.readFileSync(path.join(unpacked.stagingPath, ...avatarEntry.path.split('/')))).toEqual(seeded.avatar)
    const freeze = JSON.parse(fs.readFileSync(path.join(unpacked.stagingPath, 'portable-runtime-freeze.json'), 'utf8'))
    expect(freeze).toMatchObject({ nonReplayable: true, requiresRuntimeFreezeGuard: true })
    expect(freeze.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'generation_attempts', terminalState: 'unknown', nonReplayable: true }),
      expect.objectContaining({ table: 'finalization_outbox', terminalState: 'pending', nonReplayable: true }),
      expect.objectContaining({ table: 'import_runs', terminalState: 'running', nonReplayable: true }),
      expect.objectContaining({ table: 'recovery_candidates', terminalState: 'pending', nonReplayable: true }),
    ]))
  })

  it('exports and restores registered donor v7 avatars without carrying the legacy avatar reference', async () => {
    const f = fixture(true)
    const seeded = seedProject(f)
    const db = new Database(f.databasePath)
    try { db.prepare("UPDATE characters SET avatar='C:\\old-machine\\private-avatar.png' WHERE name='林澈'").run() }
    finally { db.close() }
    const before = fs.readFileSync(f.databasePath)

    const receipt = await exportPortableProject(input(f))
    expect(receipt.sourceEvidence).toMatchObject({ schemaVersion: 10, tableCount: 55, fieldCount: 521 })
    const targetProjectRoot = path.join(f.base, 'restored-donor')
    await restorePortableProject({ archivePath: f.target, targetProjectRoot })

    const restoredStorage = path.join(targetProjectRoot, '.ai-novel')
    const restored = new Database(path.join(restoredStorage, 'project.db'), { readonly: true })
    try {
      expect(restored.pragma('user_version', { simple: true })).toBe(10)
      expect(restored.prepare('SELECT avatar FROM characters').pluck().all()).toEqual(['', ''])
      expect(restored.prepare('SELECT body FROM contents WHERE id=1').pluck().get()).toBe(seeded.body)
      const avatarPath = restored.prepare('SELECT relative_path FROM character_avatar_assets').pluck().get() as string
      expect(fs.readFileSync(path.join(restoredStorage, avatarPath))).toEqual(seeded.avatar)
    } finally { restored.close() }
    expect(fs.readFileSync(f.databasePath)).toEqual(before)
  })

  it('never carries X values, secretRef, raw sensitive receipts or their digests while preserving author path-like text bytes', async () => {
    const f = fixture()
    const seeded = seedProject(f)
    await exportPortableProject(input(f))
    const bytes = fs.readFileSync(f.target)
    const rawReceipt = JSON.stringify({ secretRef: 'token-绝不外带', path: 'C:\\Users\\writer\\token.txt' })
    for (const forbidden of ['token-绝不外带', 'legacy-secret', rawReceipt, seeded.secretDigest]) {
      expect(bytes.includes(Buffer.from(forbidden, 'utf8'))).toBe(false)
    }
    const unpacked = await extract(f)
    const portable = new Database(path.join(unpacked.stagingPath, 'project.db'), { readonly: true })
    try {
      expect(portable.prepare('SELECT body FROM contents').pluck().get()).toBe(seeded.body)
      expect(portable.prepare('SELECT last_error FROM finalization_outbox').pluck().get()).toBe('')
      expect(portable.prepare('SELECT usage_receipt_json FROM generation_attempts').pluck().get()).toBeNull()
    } finally { portable.close() }
  })

  it('records F03 reference-only avatars without inventing a file', async () => {
    const f = fixture()
    const db = new Database(f.databasePath)
    db.prepare(`INSERT INTO character_avatar_unresolved(
      record_id,disposition,source_reference,source_relative_path,preserved_relative_path,
      content_hash,mime,byte_size,candidate_character_ids_json
    ) VALUES('missing-1','reference-only','missing.png','missing.png',NULL,NULL,NULL,NULL,'[]')`).run()
    db.close()
    await exportPortableProject(input(f))
    const unpacked = await extract(f)
    expect(unpacked.manifest.entries.some(entry => entry.disposition === 'avatar-asset')).toBe(false)
    const freeze = JSON.parse(fs.readFileSync(path.join(unpacked.stagingPath, 'portable-runtime-freeze.json'), 'utf8'))
    expect(freeze.avatarReferenceProjections).toEqual([expect.objectContaining({
      kind: 'unresolved-reference', recordId: 'missing-1', nonReplayable: true,
    })])
  })

  it.each([
    ['unknown table', (db: InstanceType<typeof Database>) => db.exec('CREATE TABLE future_secret(id TEXT)')],
    ['unknown field', (db: InstanceType<typeof Database>) => db.exec('ALTER TABLE contents ADD COLUMN future_secret TEXT')],
  ])('blocks %s before publishing', async (_label, mutate) => {
    const f = fixture()
    const db = new Database(f.databasePath)
    mutate(db)
    db.close()
    await expect(exportPortableProject(input(f))).rejects.toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('rejects an unsafe portable DB path and a missing avatar before publication', async () => {
    const f = fixture()
    seedProject(f)
    const db = new Database(f.databasePath)
    db.prepare("UPDATE finalization_outbox_all SET target_file_name='C:\\outside\\chapter.md'").run()
    db.close()
    await expect(exportPortableProject(input(f))).rejects.toThrow('PORTABLE_PATH_UNSAFE')
    expect(fs.existsSync(f.target)).toBe(false)

    const missing = fixture()
    const characterId = randomUUID()
    const missingDb = new Database(missing.databasePath)
    missingDb.prepare("INSERT INTO characters(character_id,name,static_provenance) VALUES(?,?,'{}')")
      .run(characterId, '缺图角色')
    missingDb.prepare(`INSERT INTO character_avatar_assets(
      character_id,asset_revision,relative_path,content_hash,mime,byte_size,source_reference
    ) VALUES(?,1,'avatars/missing.png',?,'image/png',32,'missing.png')`).run(characterId, 'a'.repeat(64))
    missingDb.close()
    await expect(exportPortableProject(input(missing))).rejects.toThrow('PORTABLE_ASSET_MISSING')
    expect(fs.existsSync(missing.target)).toBe(false)
  })

  it('blocks unsafe required R projection instead of silently dropping it', async () => {
    const f = fixture()
    const db = new Database(f.databasePath)
    db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run('正文')
    db.prepare(`INSERT INTO drafts_all(id,chapter_number,version,content_id,source_dependencies)
      VALUES(1,1,1,1,?)`).run(JSON.stringify([{ draftId: 1, contentHash: hash('正文'), secretRef: 'forbidden' }]))
    db.close()
    await expect(exportPortableProject(input(f))).rejects.toThrow('PORTABLE_UNSAFE_PROJECTION')
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('rejects a bad relative path and leaves the source and target unchanged', async () => {
    const f = fixture()
    const before = fs.readFileSync(f.databasePath)
    await expect(exportPortableProject(input(f, provider([{ ...providedFile('safe.txt', 'x', 'author-content'), archivePath: '../escape.txt' }]))))
      .rejects.toThrow('PORTABLE_PATH_UNSAFE')
    expect(fs.readFileSync(f.databasePath)).toEqual(before)
    expect(fs.existsSync(f.target)).toBe(false)
  })

  // 依据维护者 2026-11-19 原话：「目标是生成的内容可以被正确导出就可以了」。
  it.each(['afterPortableDatabaseCreated', 'afterArchiveBuilt'] as const)(
    '导出期间（%s）写库：导出照常成功，存档里的库是快照那一刻的', async (hook) => {
      const f = fixture()
      const seeded = seedProject(f)
      const writeDuringExport = () => {
        const writer = new Database(f.databasePath)
        try { writer.prepare("INSERT INTO contents(body) VALUES('导出期间写入')").run() } finally { writer.close() }
      }

      await exportPortableProject(input(f, createPortableProjectAssetProvider(), { __testHooks: { [hook]: writeDuringExport } }))

      const unpacked = await extract(f)
      const portable = new Database(path.join(unpacked.stagingPath, 'project.db'), { readonly: true })
      try {
        expect(portable.prepare('SELECT body FROM contents').pluck().all()).toEqual([seeded.body])
      } finally { portable.close() }
    })

  it('rechecks the current session after staging and rejects a stale capability', async () => {
    const f = fixture()
    let calls = 0
    await expect(exportPortableProject(input(f, provider(), {
      assertCurrentContext: () => ++calls < 2,
    }))).rejects.toThrow('PORTABLE_CONTEXT_INVALID')
    expect(calls).toBe(2)
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('preserves unknown attempt contents instead of recursively deleting them', async () => {
    const f = fixture()
    let attemptRoot = ''
    let calls = 0
    await expect(exportPortableProject(input(f, provider(), {
      assertCurrentContext: () => ++calls < 3,
      __testHooks: { afterPortableDatabaseCreated: root => {
        attemptRoot = root
        fs.writeFileSync(path.join(root, 'keep.txt'), 'not-owned')
      } },
    }))).rejects.toThrow('PORTABLE_CONTEXT_INVALID')
    expect(fs.readFileSync(path.join(attemptRoot, 'keep.txt'), 'utf8')).toBe('not-owned')
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('preserves a replacement attempt root whose identity no longer matches', async () => {
    const f = fixture()
    let replacementRoot = ''
    await expect(exportPortableProject(input(f, provider(), {
      __testHooks: { afterPortableDatabaseCreated: root => {
        fs.renameSync(root, `${root}-original`)
        fs.mkdirSync(root)
        fs.writeFileSync(path.join(root, 'keep.txt'), 'replacement')
        replacementRoot = root
      } },
    }))).rejects.toThrow('PORTABLE_ASSET_MISSING')
    expect(fs.readFileSync(path.join(replacementRoot, 'keep.txt'), 'utf8')).toBe('replacement')
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('does not overwrite an existing target and never places attempts inside the source project', async () => {
    const f = fixture()
    fs.writeFileSync(f.target, 'keep')
    await expect(exportPortableProject(input(f))).rejects.toThrow('PORTABLE_ARCHIVE_TARGET_EXISTS')
    expect(fs.readFileSync(f.target, 'utf8')).toBe('keep')
    await expect(exportPortableProject(input(f, provider(), {
      targetArchivePath: path.join(f.root, 'forbidden.ainovel'),
    }))).rejects.toThrow('PORTABLE_TARGET_INSIDE_SOURCE')
  })
})

describe('写稿时冻结的线索任务跟着便携副本走（#623 后续）', () => {
  const SECRET = 'sk-写稿凭据-绝不外带'
  const ENDPOINT = 'https://私有端点.example/v1'
  const MACHINE_PATH = 'C:\\Users\\writer\\密钥.txt'
  const task = { planId: 8, title: '旧信', authorIntent: '交代旧信的寄信人。', schedule: { kind: 'overdue', chaptersOverdue: 2 } }

  function seedWrittenDraft(f: Fixture, draftId: number, chapterNumber: number, threadTasks: unknown, manifestExtras: Record<string, unknown> = {}): void {
    const db = new Database(f.databasePath)
    db.pragma('foreign_keys = ON')
    try {
      const body = `第${chapterNumber}章正文，写完未审。`
      db.prepare("INSERT OR IGNORE INTO project_core(id,project_name,writing_language) VALUES('main','铜钥匙','zh-CN')").run()
      db.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(draftId, body)
      db.prepare("INSERT INTO drafts_all(id,chapter_number,version,status,source,content_id,word_count) VALUES(?,?,1,'draft','write',?,?)")
        .run(draftId, chapterNumber, draftId, body.length)
      const root = `root-draft-${draftId}`, run = `run-draft-${draftId}`, attempt = `attempt-draft-${draftId}`
      db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
        .run(root, `key-${root}`, JSON.stringify({ projectId: f.projectId, epoch: 'epoch-1', operation: 'chapter-draft',
          uiActionNonce: 'nonce', frozenInputHash: hash('input'), rootActionId: root, status: 'sealed', secretRef: SECRET }),
        JSON.stringify({ maxPhysicalRequests: 2, maxTokenLiability: 1000, maxOutputPerRequest: 500, maxActiveElapsedMs: 1000 }))
      db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run(run, root, JSON.stringify({
        projectId: f.projectId, epoch: 'epoch-1', fingerprint: {}, contextSnapshotId: 'context-1',
        sourceManifest: { ...manifestExtras, operation: 'chapter-draft', chapterNumber, secretRef: SECRET, endpoint: ENDPOINT, authorInputs: [
          { id: 'draft:chapter-info', text: JSON.stringify({ chapterNumber, title: '雨夜', keyEvents: MACHINE_PATH, threadTasks }) },
          { id: 'draft:target-units', text: '900' }] }, sourceRefs: [] }), 'completed', 1, `open-${run}`)
      db.prepare('INSERT INTO generation_attempts VALUES(?,?,?,?,?,?,?)').run(attempt, `reservation-${attempt}`, run, root,
        JSON.stringify({ attemptId: attempt, reservationId: `reservation-${attempt}`, rootActionId: root, status: 'settled',
          reservedTokens: 500, requestedOutputTokens: 400 }),
        JSON.stringify({ purpose: 'chapter-draft', apiKey: SECRET, endpoint: ENDPOINT, path: MACHINE_PATH,
          draftCommit: { success: true, id: draftId, version: 1, content: body, contentHash: hash(body), chapterNumber,
            handle: { projectId: f.projectId, epoch: 'epoch-1', runId: run } } }), `invocation-${attempt}`)
    } finally { db.close() }
  }

  function reviewGoals(databasePath: string, draftId: number): ReturnType<typeof captureReviewRevisionContext>['frozenGoals'] {
    const db = new Database(databasePath)
    try {
      const draft = db.prepare('SELECT d.chapter_number AS chapterNumber,d.version,d.status,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?')
        .get(draftId) as { chapterNumber: number; version: number; status: 'draft'; body: string }
      return captureReviewRevisionContext(db, { operation: 'review-chapter', draftId, authorInputs: [], uiLocale: 'zh-CN',
        expectedDraft: { chapterNumber: draft.chapterNumber, version: draft.version, status: draft.status, contentHash: textHash(draft.body) } },
      'project').frozenGoals
    } finally { db.close() }
  }

  async function roundtrip(f: Fixture, name: string): Promise<string> {
    await exportPortableProject(input(f))
    const targetRoot = path.join(f.base, name)
    await restorePortableProject({ archivePath: f.target, targetProjectRoot: targetRoot })
    return path.join(targetRoot, '.ai-novel', 'project.db')
  }

  it('线索的延后和指定跟着副本走，plan_id 还指向同一条线索', async () => {
    const f = fixture()
    const seed = new Database(f.databasePath)
    seed.pragma('foreign_keys = ON')
    try {
      seed.prepare("INSERT INTO narrative_thread_plans(id,title,type,target_start_chapter,target_end_chapter,author_intent) VALUES(8,'旧信','伏笔',1,5,'交代寄信人')").run()
      seed.prepare("INSERT INTO narrative_thread_assignments(plan_id,chapter_number,kind,note) VALUES(8,6,'resolve','写第 5 章时延后'),(8,4,'advance','写第 4 章前指定本章推进')").run()
    } finally { seed.close() }
    const restored = new Database(await roundtrip(f, 'restored-thread-assignments'), { readonly: true })
    try {
      expect(restored.prepare(`SELECT p.title,a.chapter_number AS chapterNumber,a.kind,a.note FROM narrative_thread_assignments a
        JOIN narrative_thread_plans p ON p.id=a.plan_id ORDER BY a.chapter_number`).all()).toEqual([
        { title: '旧信', chapterNumber: 4, kind: 'advance', note: '写第 4 章前指定本章推进' },
        { title: '旧信', chapterNumber: 6, kind: 'resolve', note: '写第 5 章时延后' },
      ])
    } finally { restored.close() }
  })

  it('导出再恢复后，未审稿件的审稿目标仍含写稿时冻结的线索任务', async () => {
    const f = fixture()
    seedWrittenDraft(f, 5, 1, [task])
    const before = reviewGoals(f.databasePath, 5)
    expect(before.items.map(item => item.id)).toEqual(['ch1:thread:8'])
    const restored = await roundtrip(f, 'restored-thread-tasks')
    expect(reviewGoals(restored, 5)).toEqual(before)
  })

  it('副本里不带写稿收据的凭据、端点和机器路径，只留找到草稿的编号和任务', async () => {
    const f = fixture()
    seedWrittenDraft(f, 5, 1, [task])
    const restored = await roundtrip(f, 'restored-thread-secrets')
    const bytes = fs.readFileSync(f.target)
    expect(bytes.includes(Buffer.from(SECRET, 'utf8'))).toBe(false)
    expect(bytes.includes(Buffer.from('私有端点', 'utf8'))).toBe(false)
    expect(bytes.includes(Buffer.from('密钥.txt', 'utf8'))).toBe(false)
    const db = new Database(restored, { readonly: true })
    try {
      expect(JSON.parse(db.prepare("SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id='attempt-draft-5'").pluck().get() as string))
        .toEqual({ draftCommit: { id: 5, chapterNumber: 1 } })
      expect(JSON.parse(db.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-draft-5'").pluck().get() as string))
        .toEqual({ sourceManifest: { authorInputs: [{ id: 'draft:chapter-info', text: JSON.stringify({ threadTasks: [task] }) }] } })
    } finally { db.close() }
  })

  it('写稿收据里的材料额度不进副本，恢复后这份稿按没有收据的旧稿读', async () => {
    const f = fixture()
    seedWrittenDraft(f, 5, 1, [task], { materialDecision: { version: 1, verdict: 'admitted', included: [], omitted: [],
      budget: { inputTokens: 27_680, contextWindowTokens: 32_768, contextWindowSource: 'default', reservedOutputTokens: 4_576, safetyMarginTokens: 512 } } })
    const before = reviewGoals(f.databasePath, 5)
    const restored = await roundtrip(f, 'restored-material-budget')
    const db = new Database(restored, { readonly: true })
    try {
      expect(JSON.parse(db.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-draft-5'").pluck().get() as string).sourceManifest)
        .not.toHaveProperty('materialDecision')
    } finally { db.close() }
    expect(reviewGoals(restored, 5)).toEqual(before)
  })

  it('恢复出的副本再导出一次，线索任务仍在', async () => {
    const f = fixture()
    seedWrittenDraft(f, 5, 1, [task])
    const before = reviewGoals(f.databasePath, 5)
    await exportPortableProject(input(f))
    const onceRoot = path.join(f.base, 'restored-once')
    const once = await restorePortableProject({ archivePath: f.target, targetProjectRoot: onceRoot })
    const secondArchive = path.join(f.base, '再导出.ainovel')
    await exportPortableProject(input(f, provider(), { sourceProjectRoot: onceRoot, targetArchivePath: secondArchive,
      projectSession: { projectId: once.targetProjectId, projectPath: onceRoot, leaseId: f.session.leaseId } }))
    const twiceRoot = path.join(f.base, 'restored-twice')
    await restorePortableProject({ archivePath: secondArchive, targetProjectRoot: twiceRoot })
    expect(reviewGoals(path.join(twiceRoot, '.ai-novel', 'project.db'), 5)).toEqual(before)
  })

  it('没有冻结任务的旧稿，导出后的收据与审稿目标都和原来一样', async () => {
    const f = fixture()
    seedWrittenDraft(f, 5, 1, undefined)
    const before = reviewGoals(f.databasePath, 5)
    const restored = await roundtrip(f, 'restored-old-draft')
    expect(reviewGoals(restored, 5)).toEqual(before)
    const db = new Database(restored, { readonly: true })
    try {
      expect(db.prepare("SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id='attempt-draft-5'").pluck().get()).toBeNull()
      expect(db.prepare("SELECT binding_json FROM generation_runs WHERE run_id='run-draft-5'").pluck().get()).toBe('{}')
    } finally { db.close() }
  })

  it('一份稿的线索任务段写坏，只这份稿退回无线索目标并记一行日志，导出恢复照常', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const f = fixture()
      seedWrittenDraft(f, 5, 1, [task])
      seedWrittenDraft(f, 6, 2, [{ planId: '坏', title: '旧信' }])
      const restored = await roundtrip(f, 'restored-corrupt-task')
      expect(reviewGoals(restored, 5).items.map(item => item.id)).toEqual(['ch1:thread:8'])
      expect(reviewGoals(restored, 6).items).toEqual([])
      expect(warn.mock.calls.filter(([message]) => String(message).startsWith('[portable-export]'))).toHaveLength(1)
    } finally { warn.mockRestore() }
  })

  it('收据里的草稿编号不是整数时不带走任务，也不改写成别的草稿编号', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const f = fixture()
      seedWrittenDraft(f, 5, 1, [task])
      const db = new Database(f.databasePath)
      try { db.exec("UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.draftCommit.id',json('true'))") }
      finally { db.close() }
      const restored = await roundtrip(f, 'restored-boolean-draft-id')
      const portable = new Database(restored, { readonly: true })
      try {
        expect(portable.prepare("SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id='attempt-draft-5'").pluck().get()).toBeNull()
      } finally { portable.close() }
      expect(warn.mock.calls.filter(([message]) => String(message).startsWith('[portable-export]'))).toHaveLength(1)
    } finally { warn.mockRestore() }
  })
})

describe('portable redaction registry', () => {
  it('classifies every redacted-projection field and never collapses a field that a unique key distinguishes', () => {
    const split = (key: string) => key.split('.') as [string, string]
    const redacted = listPortableFieldPolicyKeys().filter(key => getPortableFieldPolicy(...split(key)).disposition === 'redacted-projection')
    expect(redacted.filter(key => !portableRedactionFor(...split(key)))).toEqual([])

    const f = fixture()
    const db = new Database(f.databasePath, { readonly: true })
    const collapsed: string[] = []
    try {
      const tables = db.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%'")
        .pluck().all() as string[]
      for (const physical of tables) {
        const table = logicalTableName(physical)
        if (PORTABLE_CLEARED_TABLES.includes(table)) continue
        const keyed = new Set((db.prepare(`PRAGMA table_info("${physical}")`).all() as Array<{ name: string; pk: number }>)
          .filter(column => column.pk > 0).map(column => column.name))
        for (const index of db.prepare(`PRAGMA index_list("${physical}")`).all() as Array<{ name: string; unique: number }>) {
          if (!index.unique) continue
          for (const column of db.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<{ name: string }>) keyed.add(column.name)
        }
        for (const field of keyed) {
          const { disposition } = getPortableFieldPolicy(table, field)
          const redaction = disposition === 'exclude-machine-authority' ? 'blank'
            : disposition === 'redacted-projection' ? portableRedactionFor(table, field) : 'kept'
          if (redaction === 'blank' || redaction === 'json-neutral') collapsed.push(`${table}.${field}`)
        }
      }
    } finally { db.close() }
    expect(collapsed.sort()).toEqual([])
  })
})

it('portable export and restore preserve author annotation history snapshots', async () => {
  const f = fixture()
  seedProject(f)
  const source = new Database(f.databasePath)
  try {
    source.prepare('INSERT INTO annotation_history(draft_id,before_text,after_text,annotations_json) VALUES(?,?,?,?)')
      .run(1, '春雨落下', '秋雨落下', JSON.stringify([{ selectedText: '春', instruction: '改成秋' }]))
  } finally { source.close() }
  await exportPortableProject(input(f))
  const destination = path.join(f.base, 'annotation-restored')
  await restorePortableProject({ archivePath: f.target, targetProjectRoot: destination })
  const restored = new Database(path.join(destination, '.ai-novel', 'project.db'), { readonly: true })
  try {
    expect(restored.prepare('SELECT before_text,after_text,annotations_json FROM annotation_history').get()).toEqual({
      before_text: '春雨落下', after_text: '秋雨落下', annotations_json: JSON.stringify([{ selectedText: '春', instruction: '改成秋' }]),
    })
  } finally { restored.close() }
})

describe('存档导入仍跑全书审修循环校验（#702）', () => {
  const REVIEW_PROOF = "json_extract(usage_receipt_json,'$.reviewRevisionEffect.kind')='review'"

  /** 改了包里的库就要重签转移凭据，否则导入在 M03 之前就因凭据不符被拒。 */
  async function rewriteArchiveDatabase(f: Fixture, change: (db: import('better-sqlite3').Database) => void): Promise<string> {
    const unpackParent = path.join(f.base, `variant-${randomUUID()}`)
    fs.mkdirSync(unpackParent)
    const unpacked = await extractPortableProjectArchive({ archivePath: f.target, stagingParentPath: unpackParent })
    const file = (entryPath: string) => path.join(unpacked.stagingPath, ...entryPath.split('/'))
    const databasePath = file(CANONICAL_PROJECT_DATABASE)
    const db = new Database(databasePath)
    try { change(db) } finally { db.close() }
    const portableDatabaseSha256 = hash(fs.readFileSync(databasePath))
    const previous = parsePortableTransferAuthority(JSON.parse(fs.readFileSync(file(PORTABLE_TRANSFER_AUTHORITY_PATH), 'utf8')))
    const reader = new Database(databasePath, { readonly: true, fileMustExist: true })
    let authority
    try {
      authority = createPortableTransferAuthority({ database: reader, originProjectId: previous.originProjectId,
        snapshotGeneration: previous.snapshotGeneration, portableDatabaseSha256 })
    } finally { reader.close() }
    const authorityBytes = serializePortableTransferAuthority(authority)
    fs.writeFileSync(file(PORTABLE_TRANSFER_AUTHORITY_PATH), authorityBytes)
    const entries = unpacked.manifest.entries.map(entry => entry.path === CANONICAL_PROJECT_DATABASE
      ? { ...entry, byteSize: fs.statSync(databasePath).size, sha256: portableDatabaseSha256 }
      : entry.path === PORTABLE_TRANSFER_AUTHORITY_PATH ? { ...entry, byteSize: authorityBytes.length, sha256: hash(authorityBytes) } : entry)
    const total = entries.reduce((sum, entry) => sum + entry.byteSize, 0)
    const target = path.join(f.base, `rewritten-${randomUUID()}.ainovel`)
    await writePortableProjectArchive({
      manifest: { ...unpacked.manifest, entries, declaredUncompressedBytes: total, declaredCompressedBytes: total,
        transferReceiptIds: unpacked.manifest.transferReceiptIds.map(id => id === previous.receiptId ? authority.receiptId : id) },
      sources: entries.map(entry => ({ entry, sourcePath: file(entry.path) })),
      targetPath: target,
    })
    return target
  }

  it('包里有一条过不了 M03 证明的审修循环，导入被拒绝；同样重签但没改坏的包照常导入', async () => {
    const f = fixture()
    seedMergedCycle(f)
    await exportPortableProject(input(f))
    let original = ''
    const intact = await rewriteArchiveDatabase(f, db => {
      original = db.prepare(`SELECT usage_receipt_json FROM generation_attempts WHERE ${REVIEW_PROOF}`).pluck().get() as string
      db.prepare(`UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.reviewRevisionEffect.contentHash',?)
        WHERE ${REVIEW_PROOF}`).run(hash('另一份审稿'))
      db.prepare(`UPDATE generation_attempts SET usage_receipt_json=? WHERE ${REVIEW_PROOF}`).run(original)
    })
    await restorePortableProject({ archivePath: intact, targetProjectRoot: path.join(f.base, 'restored-intact') })

    const broken = await rewriteArchiveDatabase(f, db => {
      const changed = db.prepare(`UPDATE generation_attempts
        SET usage_receipt_json=json_set(usage_receipt_json,'$.reviewRevisionEffect.contentHash',?) WHERE ${REVIEW_PROOF}`)
        .run(hash('另一份审稿')).changes
      expect(changed).toBe(1)
      db.pragma('foreign_keys = ON')
      expect(verifyM03ReviewCycle(db)).toBe(false)
    })
    const targetProjectRoot = path.join(f.base, 'restored-broken')
    await expect(restorePortableProject({ archivePath: broken, targetProjectRoot })).rejects.toThrow('MIGRATION_VERIFICATION_FAILED')
    expect(fs.existsSync(path.join(targetProjectRoot, '.ai-novel', CANONICAL_PROJECT_DATABASE))).toBe(false)
  })
})

describe('修稿续写过一次的审修循环照样能导出（#702）', () => {
  const prose = '林岚走进北塔，灯火照亮了石阶。'.repeat(20)
  const prefixText = '林岚走进北塔，月光照亮了石阶。'.repeat(10)
  const terminalText = '她停在门前，月光照亮了石阶。'.repeat(10)
  const report = JSON.stringify({ summary: '检查完成', items: [{ category: '表达', severity: 'warning', description: '补充动作细节', quote: '林岚走进北塔' }] })
  const materialDecision = (prompt: string, included: NonNullable<BeginGenerationRequest['materialDecision']>['included'] = []) => ({
    version: 1 as const, verdict: 'admitted' as const, promptHash: textHash(prompt),
    capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1' as const, admittedUnits: included.reduce((sum, item) => sum + item.units, 0) },
    coverage: { required: included.length, included: included.length, complete: true }, included, omitted: [],
  })

  // 走真实的审修 owner，保证续写分段的落库形态与线上一致。
  // failedFirst：修稿首个请求失败且没有结束原因，作者重试；返回修稿各段的尝试编号。
  async function seedOwnerCycle(f: Fixture, segments: 1 | 2, failedFirst = false): Promise<{ attemptIds: string[]; revised: string }> {
    initProjectDatabase(f.root)
    const db = getProjectDb()!
    db.prepare("INSERT INTO project_core(id,project_name,words_per_chapter) VALUES('main','北塔',100)").run()
    db.prepare("INSERT INTO blueprints(chapter_number,title) VALUES(1,'北塔')").run()
    db.prepare('INSERT INTO contents(id,body) VALUES(1,?)').run(prose)
    db.prepare("INSERT INTO drafts_all(id,chapter_number,version,status,content_id,word_count) VALUES(1,1,1,'draft',1,280)").run()
    const revised = composeVisibleContinuation(prefixText, terminalText)
    const outputs: Array<readonly [string, 'stop' | 'length'] | 'fail'> = [[report, 'stop'], ...(failedFirst ? ['fail' as const] : []),
      ...(segments === 2 ? [[prefixText, 'length'], [terminalText, 'stop']] as const : [[revised, 'stop']] as const)]
    const model: ModelProfile = { id: 'synthetic', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
      apiKey: 'synthetic-key', baseUrl: 'https://api.openai.com/v1', temperature: 0.7, maxTokens: 2048, purposes: ['generation'],
      capabilities: { contextWindowTokens: 32768, maxOutputTokens: 2048, reasoning: false, structuredOutput: true, usage: true } }
    const loadModel = (id: string) => id === model.id ? model : null
    const deps = { db, projectStorageRoot: f.storage, globalDataRoot: f.base, readBuiltinPrompt: () => '冻结的合成提示词' }
    const owner = createMainGenerationOwner({ database: db, projectId: f.projectId, epoch: 'epoch-1', assertCurrent: () => {},
      leases: new ModelExecutionLeaseRegistry({ loadModel }), loadModel,
      dispatch: async (_request, options) => {
        const next = outputs.shift()!
        if (next === 'fail') throw new Error('NETWORK_ERROR')
        const [text, finishReason] = next
        options.onVisible({ kind: 'delta', text })
        return { finishReason, usage: null }
      },
      buildBinding: (selection, modelReceipt, policy) => buildGenerationSourceBinding(deps, { ...selection, projectId: f.projectId,
        epoch: 'epoch-1', modelReceipt, policy, outputContract: generationOutputContract(selection) }).binding,
      rebuildBinding: (previous, modelReceipt) => rebuildGenerationSourceBinding(deps, previous, 'epoch-1', modelReceipt,
        readMainGenerationPolicy(previous.sourceManifest.policy)).binding })
    const expectedDraft = { chapterNumber: 1, version: 1, status: 'draft' as const, contentHash: textHash(prose) }
    const begin = (prepared: ReturnType<typeof owner.prepareReviewRevision>, nonce: string) => {
      const review = prepared.context.operation === 'review-chapter'
      return owner.begin({ operation: prepared.context.operation, uiActionNonce: nonce, modelId: model.id, chapterNumber: 1,
        selectedDraftIds: [1], selectedFinalizedDraftIds: [], promptKeys: [review ? 'consistency_check' : 'refine_from_review'],
        skillStages: [review ? 'review' : 'refinement'], output: review ? 'structured-data' : 'visible-text',
        reviewRevisionContextId: prepared.contextId, authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(prepared.context) }],
        ...(prepared.parentRootActionId ? { parentRootActionId: prepared.parentRootActionId } : {}) })
    }
    try {
      const reviewPrepared = owner.prepareReviewRevision({ operation: 'review-chapter', draftId: 1, expectedDraft, authorInputs: [], uiLocale: 'zh-CN' })
      const reviewView = begin(reviewPrepared, 'review')
      owner.bindMaterialDecision(reviewView.handle, materialDecision('检查冻结正文'))
      const reviewRun = await owner.execute({ handle: reviewView.handle, invocationNonce: 'review-run',
        task: { purpose: 'review-chapter', output: 'structured-data', messages: [{ role: 'user', content: '检查冻结正文' }] } })
      const reviewArtifact = reviewRun.run.artifacts.at(-1)!
      const savedReview = owner.commitReview({ contextId: reviewPrepared.contextId, handle: reviewView.handle,
        artifact: { artifactId: reviewArtifact.artifactId, revision: reviewArtifact.revision, textHash: reviewArtifact.textHash } })
      const snapshot = createHumanConfirmedReviewSnapshot({ sourceReviewId: savedReview.id, sourceDraft: savedReview.source,
        summary: '作者确认', authorGuidance: '', items: [{ category: '表达', severity: 'warning', description: '补充动作', decision: 'apply', origin: 'ai' }] })!
      const confirmationContent = serializeHumanConfirmedReviewSnapshot(snapshot)
      const confirmation = ReviewRepository.create({ baseDraftId: 1, content: confirmationContent, expectedSource: savedReview.source }, db)
      const prepared = owner.prepareReviewRevision({ operation: 'refine-from-review', draftId: 1, expectedDraft, authorInputs: [],
        uiLocale: 'zh-CN', reviewSourceId: confirmation.id, confirmedReviewContent: confirmationContent })
      const view = begin(prepared, 'revision')
      const brief = renderHumanConfirmedReviewBrief(snapshot, prepared.context.writingLanguage)
      owner.bindMaterialDecision(view.handle, materialDecision('按确认修改', [{ sourceId: `review:confirmed:${confirmation.id}`,
        revision: confirmation.id, contentHash: textHash(brief), category: 'author', required: true, units: Buffer.byteLength(brief) }]))
      if (failedFirst) {
        await owner.execute({ handle: view.handle, invocationNonce: 'revision-run-failed', task: { purpose: 'refine-from-review',
          output: 'visible-text', messages: [{ role: 'user', content: '按确认修改' }] } }).catch(() => undefined)
      }
      for (let index = 0; index < segments; index++) {
        await owner.execute({ handle: view.handle, invocationNonce: `revision-run-${index}`, task: {
          purpose: index === 0 ? 'refine-from-review' : 'refine-from-review-continuation', output: 'visible-text',
          messages: [{ role: 'user', content: index === 0 ? '按确认修改' : '从结尾接着写完' }] } })
      }
      const candidates = owner.read(view.handle).candidates!
      expect(candidates).toHaveLength(segments + Number(failedFirst))
      const artifactIds = candidates.slice(-segments).map(candidate => candidate.artifactId)
      const composition = owner.composeVisible(view.handle, artifactIds, textHash(revised), 'visible-append-v1')
      const savedRevision = owner.commitRevision({ contextId: prepared.contextId, handle: view.handle, expectedCompositionHash: composition.textHash })
      RevisionRepository.mergeIntoDraft({ revisionId: savedRevision.id, targetDraftId: 1, expectedDraftContent: prose,
        mergedContent: revised, wordCount: countDraftUnits(revised) }, db)
      expect(inspectM03ReviewCycles(db)).toEqual({ structureOk: true, unprovable: [] })
      const attemptIds = artifactIds.map(id => db.prepare('SELECT attempt_id FROM generation_artifacts WHERE artifact_id=?').pluck().get(id) as string)
      if (failedFirst) {
        expect(db.prepare(`SELECT COUNT(*) FROM generation_attempts WHERE run_id=?
          AND json_extract(usage_receipt_json,'$.result.finishReason') IS NULL`).pluck().get(view.handle.runId)).toBe(1)
      }
      return { attemptIds, revised }
    } finally {
      owner.suspendForProjectClose()
      closeProjectDatabase()
    }
  }

  it.each([[1, false], [2, false], [2, true]] as const)('%i 段修稿的循环导出成功，恢复出的副本从严校验没有验不过的循环（修稿先失败一次：%s）', async (segments, failedFirst) => {
    const f = fixture()
    const seeded = await seedOwnerCycle(f, segments, failedFirst)
    const receipt = await exportPortableProject(input(f))
    expect(receipt.omittedReviewCycles ?? []).toEqual([])
    const targetRoot = path.join(f.base, 'restored-segments')
    await restorePortableProject({ archivePath: f.target, targetProjectRoot: targetRoot })
    const restored = new Database(path.join(targetRoot, '.ai-novel', 'project.db'), { readonly: true })
    try {
      restored.pragma('foreign_keys = ON')
      expect(inspectM03ReviewCycles(restored)).toEqual({ structureOk: true, unprovable: [] })
      expect(restored.prepare('SELECT body FROM review_cycle_merges').pluck().get()).toBe(seeded.revised)
    } finally { restored.close() }
  })

  it('没被组合用到的失败尝试收据读不全：不挡导出，这条收据照旧不进副本', async () => {
    const f = fixture()
    await seedOwnerCycle(f, 2, true)
    const failed = "json_extract(usage_receipt_json,'$.artifactIdentity') IS NOT NULL AND json_extract(usage_receipt_json,'$.result.finishReason') IS NULL"
    const db = new Database(f.databasePath)
    try {
      expect(db.prepare(`UPDATE generation_attempts SET usage_receipt_json=json_remove(usage_receipt_json,'$.artifactIdentity.epoch') WHERE ${failed}`).run().changes).toBe(1)
      db.pragma('foreign_keys = ON')
      expect(inspectM03ReviewCycles(db)).toEqual({ structureOk: true, unprovable: [] })
    } finally { db.close() }
    await exportPortableProject(input(f))
    const targetRoot = path.join(f.base, 'restored-unused-receipt')
    await restorePortableProject({ archivePath: f.target, targetProjectRoot: targetRoot })
    const restored = new Database(path.join(targetRoot, '.ai-novel', 'project.db'), { readonly: true })
    try {
      restored.pragma('foreign_keys = ON')
      expect(inspectM03ReviewCycles(restored)).toEqual({ structureOk: true, unprovable: [] })
      expect(restored.prepare(`SELECT COUNT(*) FROM generation_attempts WHERE usage_receipt_json IS NULL`).pluck().get()).toBe(1)
    } finally { restored.close() }
  })

  it('便携副本里续写前那一段的收据还在：保留到上限的结束原因和产物身份，不带别的', async () => {
    const f = fixture()
    const { attemptIds: [prefixAttempt] } = await seedOwnerCycle(f, 2)
    const source = new Database(f.databasePath, { readonly: true })
    const original = JSON.parse(source.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(prefixAttempt) as string)
    source.close()
    expect(original.reviewRevisionEffect).toBeUndefined()
    const copy = path.join(f.base, 'portable-copy.db')
    fs.copyFileSync(f.databasePath, copy)
    sanitizePortableDatabase(copy)
    const portable = new Database(copy, { readonly: true })
    try {
      const projected = portable.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(prefixAttempt) as string | null
      expect(projected).not.toBeNull()
      expect(JSON.parse(projected!)).toEqual({ artifactIdentity: original.artifactIdentity, result: { finishReason: 'length' } })
    } finally { portable.close() }
  })
})
