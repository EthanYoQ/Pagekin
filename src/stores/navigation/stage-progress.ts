import { configText } from '../../shared/novel-config-ai-sources'
import type { DraftMeta } from '../../services/draft-index'
import type { NovelConfig } from '../../shared/ipc-channels'
import type { ReviewCycleProjection } from '../../shared/review-cycle'
import type { EditorTab } from '../editor-store'
import type { WorkflowRun, WorkflowStep } from '../workflow-store'
import type { ResourcePage, WorkStage } from './navigation-intents'
import type { StageWork } from './stage-store'

export type SetupField = 'coreOutline' | 'genre' | 'length' | 'targetAudience'
export const SETUP_FIELDS: readonly SetupField[] = ['coreOutline', 'genre', 'length', 'targetAudience']

export const ARCHITECTURE_SECTIONS = ['premise', 'characters', 'worldbuilding', 'synopsis'] as const

export type StageProgress =
  | { state: 'done' }
  | { state: 'active'; ratio: number }
  | { state: 'todo' }

export type StageStatus =
  | { stage: 'setup'; progress: StageProgress; missing: readonly SetupField[] }
  | { stage: 'architecture'; progress: StageProgress; filled: number; total: number }
  | { stage: 'blueprint'; progress: StageProgress; planned: number; total: number }
  | { stage: 'manuscript'; progress: StageProgress; finalized: number; total: number }

export type ChapterPhase = 'todo' | 'draft' | 'reviewed' | 'merge' | 'revised' | 'final'

export interface ChapterFacts {
  mergeable: readonly number[]
  stale: readonly { id: number; reason: 'edited' | 'unsourced' }[]
  latestReview: { createdAt: string; cycleStatus: ReviewCycleProjection['revisionStatus'] | null } | null
  lastMergedAt: string | null
}

export function chapterPhase(status: Exclude<DraftMeta['status'], 'archived' | 'superseded'>, facts: ChapterFacts | undefined): ChapterPhase {
  if (status === 'finalized') return 'final'
  if (!facts) return status === 'revised' ? 'revised' : 'draft'
  const { mergeable, latestReview: review, lastMergedAt } = facts
  if (mergeable.length > 0) return 'merge'
  if (status !== 'revised') return review ? 'reviewed' : 'draft'
  if (!review?.cycleStatus || review.cycleStatus === 'merge-committed') return 'revised'
  return lastMergedAt === null || review.createdAt > lastMergedAt ? 'reviewed' : 'revised'
}

export interface ChapterRow {
  number: number
  title: string
  phase: ChapterPhase
  running: boolean
  draft: DraftMeta | null
  hasFinal: boolean
}

export interface WorkFacts {
  config: Pick<NovelConfig, 'coreOutline' | 'genre' | 'targetAudience' | 'totalChapters' | 'wordsPerChapter'>
  architecture: StageWork['architecture']
  blueprints: StageWork['blueprints']
  drafts: Readonly<Record<number, readonly DraftMeta[]>>
  runningChapters: ReadonlySet<number>
  chapterFacts?: Readonly<Record<number, ChapterFacts>>
}

const DONE: StageProgress = { state: 'done' }
const TODO: StageProgress = { state: 'todo' }

function fraction(done: number, total: number): StageProgress {
  if (total <= 0 || done <= 0) return TODO
  return done >= total ? DONE : { state: 'active', ratio: done / total }
}

export function missingSetup(config: WorkFacts['config']): SetupField[] {
  const blank = (value: unknown) => !configText(value).trim()
  const count = (value: number) => Number.isSafeInteger(value) && value > 0
  return SETUP_FIELDS.filter(field => field === 'length'
    ? !(count(config.totalChapters) && count(config.wordsPerChapter))
    : blank(config[field]))
}

const begun = (row: ChapterRow) => row.hasFinal || (row.phase !== 'todo' && row.draft?.wordCount !== 0)

export function deriveStages(facts: WorkFacts, chapters: readonly ChapterRow[] = deriveChapters(facts)): StageStatus[] {
  const missing = missingSetup(facts.config)
  const filled = ARCHITECTURE_SECTIONS.filter(section => facts.architecture[section]).length
  const total = Math.max(0, facts.config.totalChapters || 0)
  const planned = facts.blueprints.length
  const finalized = chapters.filter(row => row.phase === 'final').length
  const started = chapters.some(begun)
  return [
    { stage: 'setup', missing,
      progress: missing.length === 0 ? DONE : { state: 'active', ratio: (SETUP_FIELDS.length - missing.length) / SETUP_FIELDS.length } },
    { stage: 'architecture', filled, total: ARCHITECTURE_SECTIONS.length, progress: fraction(filled, ARCHITECTURE_SECTIONS.length) },
    { stage: 'blueprint', planned, total, progress: planned > 0 ? DONE : TODO },
    { stage: 'manuscript', finalized, total,
      progress: total > 0 && finalized >= total ? DONE : started ? { state: 'active', ratio: total > 0 ? finalized / total : 0 } : TODO },
  ]
}

type WorkingDraft = DraftMeta & { status: 'draft' | 'reviewed' | 'revised' }
const isWorking = (draft: DraftMeta): draft is WorkingDraft => draft.status === 'draft' || draft.status === 'reviewed' || draft.status === 'revised'

function createdAfterFinal(draft: DraftMeta, final: DraftMeta): boolean {
  const finalizedAt = final.updatedAt
  if (!finalizedAt || draft.createdAt === finalizedAt) return draft.version > final.version
  return draft.createdAt > finalizedAt
}

export function deriveChapters(facts: Pick<WorkFacts, 'blueprints' | 'drafts' | 'runningChapters' | 'chapterFacts'>): ChapterRow[] {
  const titles = new Map(facts.blueprints.map(blueprint => [blueprint.chapterNumber, blueprint.title]))
  const numbers = new Set([...titles.keys(), ...Object.keys(facts.drafts).map(Number)])
  return [...numbers].sort((a, b) => a - b).map(number => {
    const drafts = facts.drafts[number] ?? []
    const final = drafts.find(draft => draft.status === 'finalized') ?? null
    const latest = drafts.filter(isWorking).sort((a, b) => b.version - a.version)[0] ?? null
    const working = latest && (!final || createdAfterFinal(latest, final)) ? latest : null
    return {
      number,
      title: titles.get(number) || final?.chapterTitle || '',
      phase: working ? chapterPhase(working.status, facts.chapterFacts?.[working.id]) : final ? 'final' : 'todo',
      running: facts.runningChapters.has(number),
      draft: working ?? final,
      hasFinal: final !== null,
    }
  })
}

export function focusChapter(rows: readonly ChapterRow[]): ChapterRow | null {
  return rows.filter(row => begun(row) && row.phase !== 'final').at(-1)
    ?? rows.find(row => !begun(row))
    ?? rows.at(-1)
    ?? null
}

export function landingStage(stages: readonly StageStatus[]): WorkStage {
  const first = stages.find(status => status.progress.state !== 'done')?.stage ?? 'manuscript'
  const begun = stages.some(status => (status.stage === 'blueprint' || status.stage === 'manuscript') && status.progress.state !== 'todo')
  return begun && first !== 'setup' ? 'manuscript' : first
}

export type StageLocation =
  | { kind: 'stage'; stage: WorkStage; chapter?: number }
  | { kind: 'resource'; page: ResourcePage }

const TAB_LOCATION: Record<EditorTab['type'], StageLocation> = {
  config: { kind: 'stage', stage: 'setup' },
  'world-building': { kind: 'stage', stage: 'architecture' },
  'arch-file': { kind: 'stage', stage: 'architecture' },
  character: { kind: 'stage', stage: 'architecture' },
  outline: { kind: 'stage', stage: 'architecture' },
  'chapter-card': { kind: 'stage', stage: 'blueprint' },
  chapter: { kind: 'stage', stage: 'manuscript' },
  'review-report': { kind: 'stage', stage: 'manuscript' },
  diff: { kind: 'stage', stage: 'manuscript' },
  'narrative-thread': { kind: 'resource', page: 'plot' },
  knowledge: { kind: 'resource', page: 'knowledge' },
  'version-history': { kind: 'resource', page: 'history' },
}

export function locate(tab: Pick<EditorTab, 'type' | 'chapterNumber'> | undefined): StageLocation | null {
  if (!tab) return null
  const location = TAB_LOCATION[tab.type]
  return location.kind === 'stage' && location.stage === 'manuscript' && tab.chapterNumber !== undefined
    ? { ...location, chapter: tab.chapterNumber }
    : location
}

export function runningChapters(runs: readonly Pick<WorkflowRun, 'resourceKeys' | 'type' | 'currentStepIndex' | 'status'>[]): Set<number> {
  const numbers = new Set<number>()
  for (const run of runs) {
    if (run.status === 'paused') continue
    const chapters = (run.resourceKeys ?? []).flatMap(key => {
      const match = /^chapter:(\d+)$/.exec(key)
      return match ? [Number(match[1])] : []
    })
    const writing = run.type === 'batch_generate' ? chapters.slice(run.currentStepIndex, run.currentStepIndex + 1) : chapters
    for (const number of writing) numbers.add(number)
  }
  return numbers
}

export function runProgress(run: Pick<WorkflowRun, 'steps' | 'currentStepIndex'>): number {
  if (run.steps.length === 0) return 0
  const completed = run.steps.filter(step => step.status === 'completed' || step.status === 'skipped').length
  const current = run.steps[run.currentStepIndex]
  const partial = current && current.status === 'running' ? (current.progress ?? 0) / 100 : 0
  return Math.min(1, (completed + partial) / run.steps.length)
}

const STEP_WAIT_AFTER_MS = 15_000

export interface StepWait { waitedMs: number; on: 'model' | 'step' }

export function stepWait(step: WorkflowStep | undefined, runStatus: WorkflowRun['status'], now: number): StepWait | null {
  if (runStatus !== 'running' || step?.status !== 'running' || !step.lastProgressAt) return null
  const waitedMs = now - Date.parse(step.lastProgressAt)
  if (waitedMs < STEP_WAIT_AFTER_MS) return null
  const activity = step.generationActivity
  return { waitedMs, on: activity && !activity.diagnostics?.endReason ? 'model' : 'step' }
}
