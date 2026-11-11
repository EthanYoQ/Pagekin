import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { GraphGenerationContext, GraphGenerationInput } from '../../src/shared/graph-generation'
import { resolveWritingLanguage } from '../../src/shared/writing-language'
import { buildPlotTreeTask } from '../../src/shared/plot-tree-generation-pure'
import { buildNarrativeThreadEventTask, buildNarrativeThreadPlanTask } from '../../src/shared/narrative-thread-generation-pure'
import { narrativeThreadView } from '../../src/shared/narrative-thread'
import { buildBlueprintContinuityCheckTask, selectContinuityCheckScope } from '../../src/shared/blueprint-continuity-check'
import { buildBlueprintContinuitySuggestTask } from '../../src/shared/blueprint-continuity-suggest'
import { PlotTreeRepository } from '../repositories/plot-tree-repository'
import { NarrativeThreadRepository } from '../repositories/narrative-thread-repository'
import { BlueprintRepository } from '../repositories/blueprint-repository'
import { SummaryRepository } from '../repositories/summary-repository'
import { textHash, type DurableGenerationRun } from '../repositories/generation-run-repository'

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
export const graphGenerationOperations = { plot: 'plot-tree-snapshot', plan: 'narrative-thread-plan-candidate', event: 'narrative-thread-event-candidate', continuity: 'blueprint-continuity-check',
  'continuity-suggest': 'blueprint-continuity-suggest' } as const

export function validateGraphGenerationInput(input: GraphGenerationInput): GraphGenerationInput {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(graphGenerationOperations, input.kind)) throw new Error('GENERATION_GRAPH_INPUT_INVALID')
  const keys = input.kind === 'plot' || input.kind === 'continuity' ? ['kind'] : input.kind === 'plan' ? ['kind', 'chapterNumber']
    : input.kind === 'continuity-suggest' ? ['kind', 'finalizationId'] : ['kind', 'planId', 'draftId']
  if (Object.keys(input).some(key => !keys.includes(key))
    || input.kind === 'plan' && !positive(input.chapterNumber)
    || input.kind === 'continuity-suggest' && (!nonempty(input.finalizationId) || input.finalizationId.length > 256)
    || input.kind === 'event' && (!positive(input.planId) || !positive(input.draftId))) throw new Error('GENERATION_GRAPH_INPUT_INVALID')
  return structuredClone(input)
}

/** The ignored IDs are supplied only by the main effect owner after validating its ACKs. */
export function captureGraphGenerationContext(db: Database.Database, input: GraphGenerationInput,
  scope: { projectId: string; epoch: string }, key: string, previous?: GraphGenerationContext,
  ignoredOwnEventIds: readonly number[] = [], continuityInputTokens = Infinity): GraphGenerationContext {
  const valid = validateGraphGenerationInput(input)
  if (!nonempty(scope.projectId) || !nonempty(scope.epoch) || !nonempty(key)
    || ignoredOwnEventIds.some(id => !positive(id)) || new Set(ignoredOwnEventIds).size !== ignoredOwnEventIds.length
    || previous && (previous.projectId !== scope.projectId || previous.key !== key || !nonempty(previous.originEpoch) || !nonempty(previous.createdAt)
      || previous.kind !== valid.kind || !isDeepStrictEqual(previous.input, valid))) throw new Error('GENERATION_GRAPH_CONTEXT_INVALID')
  const core = db.prepare("SELECT writing_language,total_chapters,plot_tree_snapshot FROM project_core WHERE id='main'").get() as {
    writing_language: string; total_chapters: number; plot_tree_snapshot: string
  } | undefined
  if (!core) throw new Error('GENERATION_GRAPH_PROJECT_REQUIRED')
  const base = { projectId: scope.projectId, originEpoch: previous?.originEpoch ?? scope.epoch, key,
    createdAt: previous?.createdAt ?? new Date().toISOString(), input: valid, writingLanguage: resolveWritingLanguage(core.writing_language) }
  if (valid.kind === 'plot') {
    const sources = PlotTreeRepository.read(db)
    sources.snapshot = null
    delete sources.storedSnapshotInvalid
    return { ...base, kind: 'plot', sources, targetBaselineHash: textHash(core.plot_tree_snapshot) }
  }
  if (valid.kind === 'plan') {
    const blueprint = BlueprintRepository.getAll(db).find(row => row.chapterNumber === valid.chapterNumber)
    if (!blueprint || !positive(core.total_chapters) || valid.chapterNumber > core.total_chapters) throw new Error('GENERATION_GRAPH_BLUEPRINT_REQUIRED')
    return { ...base, kind: 'plan', blueprint, totalChapters: core.total_chapters }
  }
  if (valid.kind === 'continuity' || valid.kind === 'continuity-suggest') {
    const after = valid.kind === 'continuity' ? 0 : replacedChapter(db, valid.finalizationId)
    const finalized = new Set(db.prepare("SELECT DISTINCT chapter_number FROM drafts WHERE status='finalized'").pluck().all())
    const frozen = previous?.kind === valid.kind ? new Set(previous.chapters.map(chapter => chapter.chapterNumber)) : null
    const blueprints = BlueprintRepository.getAll(db).filter(row => frozen ? frozen.has(row.chapterNumber) : row.chapterNumber > after && !finalized.has(row.chapterNumber))
    const nodes = SummaryRepository.readContinuityNodesForPreflight(db)
    if (nodes.length === 0) throw new Error('GENERATION_GRAPH_CONTINUITY_TIMELINE_REQUIRED')
    if (blueprints.length === 0) throw new Error('GENERATION_GRAPH_BLUEPRINT_REQUIRED')
    const scope = selectContinuityCheckScope(blueprints, nodes, frozen ? Infinity : continuityInputTokens)
    if (scope.nodes.length === 0) throw new Error('GENERATION_GRAPH_CONTINUITY_TIMELINE_NOT_IN_FORCE')
    return { ...base, kind: valid.kind, ...scope }
  }
  let plan = NarrativeThreadRepository.list(db).find(row => row.id === valid.planId)
  if (!plan) throw new Error('GENERATION_GRAPH_PLAN_REQUIRED')
  const row = db.prepare(`SELECT d.chapter_number AS chapterNumber,d.status,c.body AS content,
    f.finalization_id AS finalizationId,f.content_hash AS contentHash,f.content_snapshot AS snapshot,
    f.chapter_number AS finalizedChapterNumber,f.content_revision AS contentRevision,
    m.generation AS projectionGeneration
    FROM drafts d JOIN contents c ON c.id=d.content_id JOIN finalization_outbox f ON f.draft_id=d.id
    JOIN continuity_projection_meta m ON m.id='main' WHERE d.id=?`).get(valid.draftId) as {
      chapterNumber: number; finalizedChapterNumber: number; contentRevision: number; status: string; content: string; finalizationId: string; contentHash: string; snapshot: string; projectionGeneration: number
    } | undefined
  const latest = row && db.prepare("SELECT id FROM drafts WHERE chapter_number=? AND status='finalized' ORDER BY version DESC,id DESC LIMIT 1").pluck().get(row.chapterNumber)
  if (!row || row.status !== 'finalized' || latest !== valid.draftId || !nonempty(row.finalizationId)
    || row.finalizedChapterNumber !== row.chapterNumber || !Number.isSafeInteger(row.contentRevision) || row.contentRevision < 0
    || row.content !== row.snapshot || textHash(row.snapshot) !== row.contentHash
    || !Number.isSafeInteger(row.projectionGeneration) || row.projectionGeneration < 0) throw new Error('GENERATION_GRAPH_FINALIZED_SOURCE_INVALID')
  if (ignoredOwnEventIds.length) {
    const currentChapter = db.prepare("SELECT COALESCE(MAX(chapter_number),0) FROM drafts WHERE status='finalized'").pluck().get() as number
    plan = narrativeThreadView(plan, plan.events.filter(event => !ignoredOwnEventIds.includes(event.id)), currentChapter)
  }
  return { ...base, kind: 'event', plan, source: { draftId: valid.draftId, chapterNumber: row.chapterNumber,
    finalizationId: row.finalizationId, contentHash: row.contentHash }, content: row.content, contentRevision: row.contentRevision, projectionGeneration: row.projectionGeneration }
}

/** 只认这一章现在的定稿；后处理还在把新章的人物状态记进时间线时不能检查，失败或没有记录时照样能查（界面说明可能不全）。 */
function replacedChapter(db: Database.Database, finalizationId: string): number {
  const chapter = db.prepare(`SELECT d.chapter_number FROM finalization_outbox o JOIN drafts d ON d.id=o.draft_id
    WHERE o.finalization_id=? AND d.status='finalized' AND d.id=(SELECT id FROM drafts WHERE chapter_number=d.chapter_number AND status='finalized' ORDER BY version DESC,id DESC LIMIT 1)`)
    .pluck().get(finalizationId) as number | undefined
  if (chapter === undefined) throw new Error('GENERATION_GRAPH_FINALIZATION_REQUIRED')
  const running = db.prepare(`SELECT COUNT(*) FROM post_process_steps WHERE ok=0 AND COALESCE(attempt_count,0)=0 AND COALESCE(error_msg,'')=''
    AND COALESCE(last_attempt_at,'')='' AND COALESCE(completed_at,'')='' AND step_key IN ('chapter_notes','character_cards') AND run_id=(SELECT id FROM post_process_runs
    WHERE trigger_source_type='chapter_finalize' AND trigger_source_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1)`).pluck().get(`finalization:${finalizationId}`)
  if (running !== 0) throw new Error('GENERATION_GRAPH_POSTPROCESS_PENDING')
  return chapter
}

export function graphGenerationTask(context: GraphGenerationContext) {
  if (context.kind === 'plot') return buildPlotTreeTask(context.sources)
  if (context.kind === 'continuity-suggest') return buildBlueprintContinuitySuggestTask({ writingLanguage: context.writingLanguage, chapters: context.chapters, nodes: context.nodes })
  if (context.kind === 'continuity') return buildBlueprintContinuityCheckTask({ writingLanguage: context.writingLanguage, chapters: context.chapters, nodes: context.nodes })
  if (context.kind === 'plan') return buildNarrativeThreadPlanTask({ writingLanguage: context.writingLanguage, blueprint: context.blueprint, totalChapters: context.totalChapters })
  return buildNarrativeThreadEventTask({ writingLanguage: context.writingLanguage, plan: context.plan,
    draftId: context.source.draftId, chapterNumber: context.source.chapterNumber, finalizedContent: context.content })
}

export function readGraphGenerationContext(run: DurableGenerationRun): GraphGenerationContext {
  const manifest = run.binding.sourceManifest, context = manifest.graphGenerationContext as GraphGenerationContext | undefined
  if (!context || !context.input || !Object.hasOwn(graphGenerationOperations, context.kind) || context.input.kind !== context.kind
    || manifest.operation !== graphGenerationOperations[context.kind] || textHash(JSON.stringify(context)) !== manifest.graphGenerationContextHash
    || context.projectId !== run.binding.projectId || !nonempty(context.originEpoch) || manifest.graphGenerationOriginEpoch !== context.originEpoch
    || !nonempty(context.key) || !nonempty(context.createdAt) || manifest.graphGenerationKey !== context.key
    || !isDeepStrictEqual(manifest.graphGenerationInput, context.input)) throw new Error('GENERATION_GRAPH_CONTEXT_INVALID')
  validateGraphGenerationInput(context.input)
  if (context.kind === 'plan' && (context.input.kind !== 'plan' || context.blueprint?.chapterNumber !== context.input.chapterNumber || !positive(context.totalChapters))
    || (context.kind === 'continuity' || context.kind === 'continuity-suggest') && (!context.chapters?.length || !context.nodes?.length)
    || context.kind === 'plot' && (!context.sources || context.sources.snapshot !== null || context.sources.writingLanguage !== context.writingLanguage || !/^[a-f0-9]{64}$/.test(context.targetBaselineHash))
    || context.kind === 'event' && (context.input.kind !== 'event' || context.plan?.id !== context.input.planId || context.source?.draftId !== context.input.draftId
      || !positive(context.source.chapterNumber) || !nonempty(context.source.finalizationId) || typeof context.content !== 'string'
      || !Number.isSafeInteger(context.contentRevision) || context.contentRevision < 0
      || textHash(context.content) !== context.source.contentHash || !Number.isSafeInteger(context.projectionGeneration) || context.projectionGeneration < 0)) throw new Error('GENERATION_GRAPH_CONTEXT_INVALID')
  if (!manifest.graphGenerationTask || textHash(JSON.stringify(manifest.graphGenerationTask)) !== manifest.graphGenerationTaskHash
    || !isDeepStrictEqual(manifest.graphGenerationTask, graphGenerationTask(context))) throw new Error('GENERATION_GRAPH_TASK_INVALID')
  return structuredClone(context)
}
