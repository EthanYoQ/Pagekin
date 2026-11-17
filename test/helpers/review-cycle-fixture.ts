import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import { buildReviewGenerationReport } from '../../src/shared/review-generation-report'
import type { FrozenChapterGoals } from '../../src/shared/chapter-goal-review'
import type { ConsistencyFinding } from '../../src/shared/consistency-preflight'
import { initializeLegacyBaselineSchema } from '../../electron/migrations/baseline-schema'
import { M01_GENERATION_SQL } from '../../electron/migrations/m01-generation-runs'
import { applyM03ReviewCycle, applyM06ReviewCycleMerge } from '../../electron/migrations/m03-review-cycle'
import { RevisionRepository } from '../../electron/repositories/revision-repository'
import {
  ReviewCycleRepository,
  type AttachGeneratedRevisionInput,
  type CreateReviewCycleInput,
} from '../../electron/repositories/review-cycle-repository'
import { createLiveRowViews } from './live-row-views'

type Database = BetterSqlite3.Database
const BetterSqlite = createRequire(import.meta.url)('better-sqlite3') as typeof BetterSqlite3
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export function reviewCycleDatabase(): Database {
  const db = new BetterSqlite(':memory:')
  db.pragma('foreign_keys=ON')
  db.transaction(() => {
    initializeLegacyBaselineSchema(db); db.exec(M01_GENERATION_SQL)
    applyM03ReviewCycle(db); applyM06ReviewCycleMerge(db); createLiveRowViews(db)
  })()
  return db
}

export const defaultGoals: FrozenChapterGoals = { chapterNumber: 1, coverage: 'complete',
  items: [{ id: 'goal-pass', text: '完成开场' }] }
export const defaultModel = { summary: '审稿完成', items: [{ category: '文风', severity: 'pass', description: '通过' }],
  goalReviews: [{ id: 'goal-pass', status: 'completed', description: '已经完成', evidence: [{ quote: '开场' }] }] }

export interface SeedOptions {
  key?: string
  source?: string
  sourceStatus?: 'draft' | 'revised'
  existingDraftId?: number
  model?: Record<string, unknown>
  frozenGoals?: FrozenChapterGoals
  preflight?: readonly ConsistencyFinding[]
  corruptBody?: string
  effect?: 'valid' | 'none' | 'wrong-effect' | 'wrong-artifact'
  chapterNumber?: number
}

export function seed(db: Database, options: SeedOptions = {}): {
  call: CreateReviewCycleInput
  reviewId: number
  source: string
  sourceStatus: 'draft' | 'revised'
  draftId: number
  chapterNumber: number
  reviewBody: string
  frozenGoals: FrozenChapterGoals
  preflight: readonly ConsistencyFinding[]
} {
  const key = options.key ?? 'review'
  const chapterNumber = options.chapterNumber ?? 1
  const source = options.source ?? '开场😀目标完成，预检证据，重复，重复。'
  const sourceStatus = options.sourceStatus ?? 'draft'
  const frozenGoals = options.frozenGoals ?? defaultGoals
  const preflight = options.preflight ?? []
  const modelContent = JSON.stringify(options.model ?? defaultModel)
  const generatedBody = JSON.stringify(buildReviewGenerationReport({ content: modelContent, sourceContent: source,
    frozenGoals, writingLanguage: 'zh-CN', uiLocale: 'zh-CN', preflightFindings: preflight }), null, 2)
  const body = options.corruptBody ?? generatedBody
  const sourceContentId = options.existingDraftId === undefined
    ? Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(source).lastInsertRowid) : null
  const draftId = options.existingDraftId ?? Number(db.prepare(`INSERT INTO drafts_all(chapter_number,version,status,content_id)
    VALUES(?,1,'draft',?)`).run(chapterNumber, sourceContentId).lastInsertRowid)
  const reviewContentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(body).lastInsertRowid)
  const reviewIndex = Number(db.prepare('SELECT COALESCE(MAX(review_index),0)+1 FROM reviews WHERE base_draft_id=?')
    .pluck().get(draftId))
  const reviewId = Number(db.prepare(`INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,
    source_draft_version,source_draft_status,source_content,content_id) VALUES(?,?,?,1,?,?,?)`)
    .run(draftId, reviewIndex, chapterNumber, sourceStatus, source, reviewContentId).lastInsertRowid)
  const rootActionId = `root-${key}`
  const action = { rootActionId, projectId: 'project', epoch: 'epoch', operation: 'review-chapter',
    uiActionNonce: `nonce-${key}`, frozenInputHash: hash(`frozen-${key}`), status: 'active' }
  db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
    .run(rootActionId, `root-key-${key}`, JSON.stringify(action), '{}')

  if (options.effect !== 'none') {
    const attemptId = `attempt-${key}`
    const runId = `run-${key}`
    const artifactId = `artifact-${key}`
    const context = { version: 1, operation: 'review-chapter', sourceHash: hash(source),
      source: { id: draftId, chapterNumber, version: 1, status: sourceStatus, content: source }, config: {},
      writingLanguage: 'zh-CN', uiLocale: 'zh-CN', authorInputs: [], characterStates: '（暂无）', worldbuilding: '',
      history: [], blueprints: [], frozenGoals, preflightFindings: preflight }
    const contextHash = hash(JSON.stringify(context))
    const fingerprint = Object.fromEntries(['chapterBriefHash', 'authorGuidanceHash', 'dependencyHash', 'contextSnapshotHash',
      'templateHash', 'skillSnapshotHash', 'modelLeaseRevision', 'policyHash', 'outputContractHash']
      .map((name, index) => [name, hash(`fingerprint:${key}:${index}`)]))
    const binding = { projectId: 'project', epoch: 'epoch', fingerprint, contextSnapshotId: `context-${key}`,
      sourceManifest: { operation: 'review-chapter', reviewRevisionContext: context,
        reviewRevisionContextHash: contextHash,
        authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(context) }] }, sourceRefs: [] }
    db.prepare('INSERT INTO generation_runs(run_id,root_action_id,binding_json,status,created_at_ms,open_key) VALUES(?,?,?,?,?,?)')
      .run(runId, rootActionId, JSON.stringify(binding), 'completed', 1, `open-${key}`)
    const artifact = { artifactId, attemptId, rootActionId, projectId: 'project', epoch: 'epoch', fingerprint,
      revision: 1, text: modelContent, textHash: options.effect === 'wrong-artifact' ? hash('wrong') : hash(modelContent) }
    const artifactRef = { artifactId, revision: 1, textHash: artifact.textHash }
    const usage = { artifactIdentity: { artifactId, epoch: 'epoch', fingerprint }, result: { usage: null, finishReason: 'stop' },
      reviewRevisionEffect: { kind: 'review', id: reviewId, index: reviewIndex,
        contentHash: options.effect === 'wrong-effect' ? hash('wrong') : hash(body), contextHash, artifact: artifactRef } }
    db.prepare(`INSERT INTO generation_attempts(attempt_id,reservation_id,run_id,root_action_id,attempt_json,
      usage_receipt_json,invocation_nonce) VALUES(?,?,?,?,?,?,?)`).run(attemptId, `reservation-${key}`, runId, rootActionId,
      JSON.stringify({ attemptId, reservationId: `reservation-${key}`, rootActionId, status: 'settled', reservedTokens: 100,
        requestedOutputTokens: 100, actualTokens: 1 }), JSON.stringify(usage), `invocation-${key}`)
    db.prepare('INSERT INTO generation_artifacts(artifact_id,attempt_id,run_id,artifact_json,revision,status) VALUES(?,?,?,?,?,?)')
      .run(artifactId, attemptId, runId, JSON.stringify(artifact), 1, 'partial')
  }

  return { reviewId, source, sourceStatus, draftId, chapterNumber, reviewBody: body, frozenGoals, preflight,
    call: { rootActionId, reviewId, reviewContentHash: hash(body), source: {
    projectId: 'project', epoch: 'epoch', sourceId: `draft:${draftId}`, revision: 1, contentHash: hash(source),
  } } }
}

export function create(db: Database, input: CreateReviewCycleInput) {
  return db.transaction(() => ReviewCycleRepository.create(input, db))()
}

export function seedRevision(db: Database, base: ReturnType<typeof seed>, options: {
  key?: string
  revisionContent?: string
  effect?: 'valid' | 'wrong-composition' | 'different-root'
  replacePending?: boolean
  snapshot?: Record<string, unknown>
} = {}): { attach: AttachGeneratedRevisionInput; confirmationId: number; revisionId: number } {
  const key = options.key ?? 'revision'
  const revisionContent = options.revisionContent ?? `${base.source}\n修稿补充。`
  const snapshot = options.snapshot ?? { kind: 'human-confirmed-review', schemaVersion: 1, sourceReviewId: base.reviewId,
    sourceDraft: { id: base.draftId, chapterNumber: base.chapterNumber, version: 1, status: base.sourceStatus, content: base.source },
    summary: '作者确认', authorGuidance: '', items: [{ category: '连续性', severity: 'warning',
      description: '本次忽略', decision: 'ignore', origin: 'ai' }] }
  const confirmationBody = JSON.stringify(snapshot, null, 2)
  const confirmationContentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(confirmationBody).lastInsertRowid)
  const confirmationIndex = Number(db.prepare('SELECT COALESCE(MAX(review_index),0)+1 FROM reviews WHERE base_draft_id=?')
    .pluck().get(base.draftId))
  const confirmationId = Number(db.prepare(`INSERT INTO reviews(base_draft_id,review_index,source_draft_chapter_number,
    source_draft_version,source_draft_status,source_content,content_id) VALUES(?,?,?,1,?,?,?)`)
    .run(base.draftId, confirmationIndex, base.chapterNumber, base.sourceStatus, base.source, confirmationContentId).lastInsertRowid)
  const revision = options.replacePending === false ? (() => {
    const revisionIndex = Number(db.prepare('SELECT COALESCE(MAX(revision_index),0)+1 FROM revisions WHERE base_draft_id=?')
      .pluck().get(base.draftId))
    const contentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(revisionContent).lastInsertRowid)
    const id = Number(db.prepare(`INSERT INTO revisions(base_draft_id,revision_index,revision_type,status,user_prompt,
      review_source_id,source_draft_chapter_number,source_draft_version,source_draft_status,source_content,content_id,word_count)
      VALUES(?,?,'review-fix','pending','',?,?,1,?,?,?,?)`)
      .run(base.draftId, revisionIndex, confirmationId, base.chapterNumber, base.sourceStatus, base.source, contentId, revisionContent.length).lastInsertRowid)
    return { id, revisionIndex }
  })() : RevisionRepository.replacePending({ baseDraftId: base.draftId, revisionType: 'review-fix',
    reviewSourceId: confirmationId, content: revisionContent, wordCount: revisionContent.length,
    expectedSource: { id: base.draftId, chapterNumber: base.chapterNumber, version: 1, status: base.sourceStatus, content: base.source } }, db)

  const rootActionId = options.effect === 'different-root' ? `${base.call.rootActionId}-other-${key}` : base.call.rootActionId
  if (rootActionId !== base.call.rootActionId) {
    db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)')
      .run(rootActionId, `other-root-key-${key}`, JSON.stringify({ rootActionId, projectId: 'project', epoch: 'epoch',
        operation: 'refine-from-review', uiActionNonce: `other-${key}`, frozenInputHash: hash(`other-${key}`), status: 'active' }), '{}')
  }
  const attemptId = `attempt-${key}`
  const runId = `run-${key}`
  const artifactId = `artifact-${key}`
  const context = { version: 1, operation: 'refine-from-review', sourceHash: hash(base.source),
    source: { id: base.draftId, chapterNumber: base.chapterNumber, version: 1, status: base.sourceStatus, content: base.source }, config: {},
    writingLanguage: 'zh-CN', uiLocale: 'zh-CN', authorInputs: [], characterStates: '（暂无）', worldbuilding: '',
    history: [], blueprints: [], frozenGoals: base.frozenGoals, preflightFindings: base.preflight,
    confirmation: { reviewSourceId: confirmationId, content: confirmationBody,
      originalReviewContentHash: hash(base.reviewBody), snapshot } }
  const contextHash = hash(JSON.stringify(context))
  const fingerprint = Object.fromEntries(['chapterBriefHash', 'authorGuidanceHash', 'dependencyHash', 'contextSnapshotHash',
    'templateHash', 'skillSnapshotHash', 'modelLeaseRevision', 'policyHash', 'outputContractHash']
    .map((name, index) => [name, hash(`revision-fingerprint:${key}:${index}`)]))
  const binding = { projectId: 'project', epoch: 'epoch', fingerprint, contextSnapshotId: `revision-context-${key}`,
    sourceManifest: { operation: 'refine-from-review', reviewRevisionContext: context,
      reviewRevisionContextHash: contextHash,
      authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(context) }] }, sourceRefs: [] }
  db.prepare('INSERT INTO generation_runs(run_id,root_action_id,binding_json,status,created_at_ms,open_key) VALUES(?,?,?,?,?,?)')
    .run(runId, rootActionId, JSON.stringify(binding), 'completed', 2, `open-${key}`)
  const contentHash = hash(revisionContent)
  const artifact = { artifactId, attemptId, rootActionId, projectId: 'project', epoch: 'epoch', fingerprint,
    revision: 1, text: revisionContent, textHash: contentHash }
  const artifactRef = { artifactId, revision: 1, textHash: contentHash }
  const visibleComposition = { algorithm: 'visible-append-v1',
    textHash: options.effect === 'wrong-composition' ? hash('wrong-composition') : contentHash,
    artifactIds: [artifactId], sources: [artifactRef] }
  const usage = { artifactIdentity: { artifactId, epoch: 'epoch', fingerprint }, result: { usage: null, finishReason: 'stop' },
    visibleComposition, reviewRevisionEffect: { kind: 'revision', id: revision.id, index: revision.revisionIndex,
      contentHash, compositionHash: contentHash, contextHash, artifact: artifactRef } }
  db.prepare(`INSERT INTO generation_attempts(attempt_id,reservation_id,run_id,root_action_id,attempt_json,
    usage_receipt_json,invocation_nonce) VALUES(?,?,?,?,?,?,?)`).run(attemptId, `reservation-${key}`, runId, rootActionId,
    JSON.stringify({ attemptId, reservationId: `reservation-${key}`, rootActionId, status: 'settled', reservedTokens: 100,
      requestedOutputTokens: 100, actualTokens: 1 }), JSON.stringify(usage), `invocation-${key}`)
  db.prepare('INSERT INTO generation_artifacts(artifact_id,attempt_id,run_id,artifact_json,revision,status) VALUES(?,?,?,?,?,?)')
    .run(artifactId, attemptId, runId, JSON.stringify(artifact), 1, 'partial')
  return { confirmationId, revisionId: revision.id, attach: { cycleId: '', rootActionId: base.call.rootActionId,
    confirmationReviewId: confirmationId, confirmationContentHash: hash(confirmationBody), revisionId: revision.id,
    revisionContentHash: contentHash } }
}

export function generatedCycle(db: Database, key: string, sameDraft?: ReturnType<typeof seed>,
  options: SeedOptions = {}) {
  const seeded = seed(db, { ...options, key: `review-${key}`, ...(sameDraft
    ? { source: sameDraft.source, existingDraftId: sameDraft.draftId } : {}) })
  const cycle = create(db, seeded.call)
  const revision = seedRevision(db, seeded, { key: `revision-${key}`, replacePending: !sameDraft })
  revision.attach.cycleId = cycle.cycleId
  db.transaction(() => ReviewCycleRepository.attachGeneratedRevision(revision.attach, db))()
  return { seeded, cycle, revision }
}

export function mergeRows(db: Database, item: ReturnType<typeof generatedCycle>, mergedContent: string): string {
  const contentId = db.prepare('SELECT content_id FROM drafts WHERE id=?').pluck().get(item.seeded.draftId) as number
  db.prepare('UPDATE contents SET body=? WHERE id=?').run(mergedContent, contentId)
  db.prepare("UPDATE drafts_all SET status='revised',word_count=? WHERE id=?")
    .run(mergedContent.length, item.seeded.draftId)
  db.prepare("UPDATE revisions SET status='merged',merged_to_draft_id=? WHERE id=?")
    .run(item.seeded.draftId, item.revision.revisionId)
  return hash(mergedContent)
}

export function seedReviewedBook(db: Database, chapters: number, { firstChapter = 1 } = {}) {
  return Array.from({ length: chapters }, (_, index) => {
    const chapterNumber = firstChapter + index
    const item = generatedCycle(db, `ch${chapterNumber}`, undefined, {
      chapterNumber, source: `第${chapterNumber}章开场，目标完成。`,
      frozenGoals: { ...defaultGoals, chapterNumber },
    })
    const mergedHash = mergeRows(db, item, `${item.seeded.source}\n第${chapterNumber}章合并。`)
    db.transaction(() => ReviewCycleRepository.commitMergedRevision({ revisionId: item.revision.revisionId, mergedHash }, db))()
    return item
  })
}

export interface StatementLedger {
  /** 键是 SQL 原文（pragma 记为 `PRAGMA ...`），值是执行次数。 */
  readonly counts: ReadonlyMap<string, number>
  total(): number
  reset(): void
  detach(): void
}

/**
 * 计 prepare 出的语句每次 run/get/all/iterate、每次 exec（整段算一条）、每次 pragma。
 * 不计 db.transaction 自己发的 BEGIN/COMMIT/SAVEPOINT，它们不经过实例方法。
 * 只看得到挂上之后 prepare 的语句。
 */
export function attachStatementLedger(db: Database): StatementLedger {
  const counts = new Map<string, number>()
  const record = (sql: string) => { counts.set(sql, (counts.get(sql) ?? 0) + 1) }
  const prepare = db.prepare
  const exec = db.exec
  const pragma = db.pragma
  db.prepare = function (this: Database, sql: string) {
    const statement = prepare.call(this, sql)
    const methods = statement as unknown as Record<'run' | 'get' | 'all' | 'iterate', (...args: unknown[]) => unknown>
    for (const name of ['run', 'get', 'all', 'iterate'] as const) {
      const original = methods[name]
      methods[name] = function (this: unknown, ...args: unknown[]) {
        record(statement.source)
        return original.apply(this, args)
      }
    }
    return statement
  } as Database['prepare']
  db.exec = function (this: Database, sql: string) {
    record(sql)
    return exec.call(this, sql)
  }
  db.pragma = function (this: Database, source: string, options?: BetterSqlite3.PragmaOptions) {
    record(`PRAGMA ${source}`)
    return pragma.call(this, source, options)
  } as Database['pragma']
  return {
    counts,
    total: () => [...counts.values()].reduce((sum, count) => sum + count, 0),
    reset: () => counts.clear(),
    detach: () => {
      const own = db as unknown as Record<string, unknown>
      delete own.prepare; delete own.exec; delete own.pragma
    },
  }
}

/** 仓库入口自己的检查看不到、只有 M03 证明才发现的损坏：审稿尝试回执指向别的审稿内容。 */
export function breakReviewProof(db: Database, item: { seeded: { reviewId: number; call: CreateReviewCycleInput } }): void {
  const changed = db.prepare(`UPDATE generation_attempts
    SET usage_receipt_json=json_set(usage_receipt_json,'$.reviewRevisionEffect.contentHash',?)
    WHERE root_action_id=? AND json_extract(usage_receipt_json,'$.reviewRevisionEffect.kind')='review'
      AND json_extract(usage_receipt_json,'$.reviewRevisionEffect.id')=?`)
    .run(hash('另一份审稿'), item.seeded.call.rootActionId, item.seeded.reviewId).changes
  if (changed !== 1) throw new Error(`breakReviewProof 改了 ${changed} 行`)
}
