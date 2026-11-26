import type { GenerationTask } from '../services/generation/generation-harness'
import type { MainGenerationExecuteReceipt, MainGenerationRunHandle, MainGenerationRunSummary, MainGenerationRunView, MainGenerationSnapshot, MainGenerationReasoningEvent } from '../services/generation/generation-runtime'
import type { WritingSkillStage } from './writing-skills'
import type { GenerationKnowledgeSnapshot } from './generation-knowledge'
import type { ImportGenerationSlot } from './import-generation'
import type { ImportRunExecutionAuthority } from './import-run'

export interface GenerationAuthorInput { id: string; text: string }
export type ArchitecturePlanningIntent = Readonly<{
  version: 'architecture-action-v1'
  priorSteps: readonly ('premise' | 'characters' | 'worldbuilding')[]
  synopsisRange: Readonly<{ from: number; to: number }> | null
}>
export type PlanningGenerationScope =
  | Readonly<{ kind: 'architecture'; intent: ArchitecturePlanningIntent; outlineProtocol: 'legacy-range-v1' }>
  | Readonly<{ kind: 'architecture'; intent: ArchitecturePlanningIntent; outlineProtocol: typeof import('./plot-outline-contract').PLOT_OUTLINE_PROTOCOL; outlineContent: typeof import('./plot-outline-contract').PLOT_OUTLINE_CONTENT }>
  | Readonly<{ kind: 'directory'; requestedRange: Readonly<{ mode: 'full' | 'append'; startChapter: number; endChapter: number }> }>
export interface DirectoryGenerationProgress {
  operationId: string
  payloadHash: string
  sourceHandle: MainGenerationRunHandle
  requestedRange: { startChapter: number; endChapter: number }
  committedRange: { startChapter: number; endChapter: number }
  remainingRange: { startChapter: number; endChapter: number } | null
  continuationHandle?: MainGenerationRunHandle
  authorInputs?: readonly GenerationAuthorInput[]
}
export interface BlueprintRecoveryDiagnostic {
  runId: string
  kind: 'retired' | 'invalid'
  code: 'GENERATION_BLUEPRINTS_CLEARED' | 'GENERATION_DIRECTORY_PROGRESS_INVALID' | 'GENERATION_BLUEPRINT_AUTHOR_RECEIPT_INVALID'
}
export interface DirectoryGenerationCatalog {
  progress: DirectoryGenerationProgress[]
  diagnostics: BlueprintRecoveryDiagnostic[]
}
export interface VisibleCompositionReceipt {
  algorithm: VisibleCompositionAlgorithm
  text: string
  textHash: string
  artifactIds: string[]
  sources: { artifactId: string; revision: number; textHash: string }[]
  chapters?: { chapterNumber: number; artifactIds: string[]; textHash: string }[]
  authorInputs?: GenerationAuthorInput[]
}
export type VisibleCompositionAlgorithm = 'visible-append-v1' | typeof import('./plot-outline-contract').PLOT_OUTLINE_PROTOCOL | import('./draft-visible-text').DraftVisibleTextVersion
export const MATERIAL_DECISION_RECEIPT_VERSION = 1
export const MATERIAL_DECISION_UNIT_METHOD_VERSION = 'utf8-bytes-v1' as const
export const MATERIAL_DECISION_MAX_INPUT_UNITS = 8 * 1024 * 1024
export const MATERIAL_DECISION_CATEGORIES = [
  'author', 'finalized-history', 'future-plan', 'derived-locator', 'reference',
] as const
export type MaterialDecisionCategory = typeof MATERIAL_DECISION_CATEGORIES[number]
export const MATERIAL_DECISION_OMISSION_REASONS = [
  'unknown-provenance', 'locator-statement-not-evidence', 'candidate-not-admitted',
  'invalid-source-ref', 'plot-tree-not-manuscript', 'duplicate-content',
  'duplicate-source-ref', 'budget',
  'source-invalid', 'evidence-not-locatable', 'no-relevant-passage',
  'deduplicated-against-finalized',
] as const
export type MaterialDecisionOmissionReason = typeof MATERIAL_DECISION_OMISSION_REASONS[number]

export const MATERIAL_DECISION_SOURCE_ID = /^(?:author:required|(?:finalized|candidate|review:confirmed):[1-9]\d*|reference:(?:0|[1-9]\d*))$/u

export const MATERIAL_BYTES_PER_TOKEN = 3
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768
export const MATERIAL_BUDGET_WINDOW_SOURCES = ['manual', 'learned', 'endpoint', 'preset', 'default'] as const
export type MaterialBudgetWindowSource = typeof MATERIAL_BUDGET_WINDOW_SOURCES[number]
export interface MaterialBudget {
  inputTokens: number
  contextWindowTokens: number
  contextWindowSource: MaterialBudgetWindowSource
  reservedOutputTokens: number
  safetyMarginTokens: number
}
export function materialBudgetFrom(input: Omit<MaterialBudget, 'inputTokens'>): MaterialBudget {
  return { ...input, inputTokens: Math.max(0, input.contextWindowTokens - input.reservedOutputTokens - input.safetyMarginTokens) }
}
export function tightenMaterialBudget(budget: MaterialBudget, contextWindowTokens: number): MaterialBudget {
  return contextWindowTokens < budget.contextWindowTokens
    ? materialBudgetFrom({ ...budget, contextWindowTokens, contextWindowSource: 'learned' }) : budget
}
export function estimateMaterialTokens(units: number): number {
  return Math.ceil(units / MATERIAL_BYTES_PER_TOKEN)
}
export type MaterialAdmission =
  | { kind: 'budget'; budget: MaterialBudget }
  | { kind: 'frozen'; optionalContentHashes: string[] }

export const DEFAULT_MATERIAL_ADMISSION: Extract<MaterialAdmission, { kind: 'budget' }> = { kind: 'budget', budget: materialBudgetFrom({
  contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS, contextWindowSource: 'default', reservedOutputTokens: 0, safetyMarginTokens: 0 }) }

export interface MaterialDecisionIncludedSource {
  sourceId: string
  revision: number
  contentHash: string
  category: MaterialDecisionCategory
  required: boolean
  units: number
}
export interface MaterialDecisionOmittedSource {
  sourceId: string
  revision: number
  contentHash: string
  reason: MaterialDecisionOmissionReason
  category: MaterialDecisionCategory
  required: boolean
}
export interface MaterialDecisionReceipt {
  version: typeof MATERIAL_DECISION_RECEIPT_VERSION
  verdict: 'admitted'
  promptHash: string
  reconciliationPromptHash?: string
  shortOutlinePromptHash?: string
  capacity: { maxInputUnits: number; methodVersion: typeof MATERIAL_DECISION_UNIT_METHOD_VERSION; admittedUnits: number }
  budget?: MaterialBudget
  coverage: { required: number; included: number; complete: boolean }
  included: MaterialDecisionIncludedSource[]
  omitted: MaterialDecisionOmittedSource[]
}
export type MaterialDecisionDraft = Omit<MaterialDecisionReceipt, 'promptHash'>
export interface GenerationDraftCommitReceipt {
  success: true
  id: number
  version: number
  contentHash: string
  content: string
}
export type GenerationDraftSaveState =
  | { kind: 'absent' }
  | { kind: 'current'; receipt: GenerationDraftCommitReceipt }
  | { kind: 'changed' }
export interface GenerationDraftCommitRequest {
  handle: MainGenerationRunHandle
  expectedCompositionHash: string
  chapterNumber: number
  source: 'write'
  batchId?: string
}
export type ShortOutlineRetry = { kind: 'available'; failedAttemptId: string } | { kind: 'unavailable' }
export interface PlanningDraftStanding {
  requestedRange: { from: number; to: number }
  createdAtMs: number
  standing: 'open' | 'superseded' | 'dismissed'
}
export interface GenerationRecoveryContext {
  planningContinuation?: PlanningContinuation
  planningDraft?: PlanningDraftStanding
  blueprintRecovery?: BlueprintRecovery
  plotOutlineRecovery?: import('./plot-outline-contract').PlotOutlineRecovery
  plotOutline?: import('./plot-outline-contract').PlotOutlineProgress
  modelId: string
  handle: MainGenerationRunHandle
  operation: string
  chapterNumber?: number
  authorInputs: GenerationAuthorInput[]
  selectedDraftIds: number[]
  selectedFinalizedDraftIds: number[]
  selectedBlueprintChapterNumbers: number[]
  composition: VisibleCompositionReceipt | null
  lastCompositionFinishReason: string | null
  attemptedPurposes: string[]
  draftSave: GenerationDraftSaveState
  batchId?: string
  knowledgeSnapshot?: GenerationKnowledgeSnapshot
  draftReconciliation?: { artifactIds: string[]; completedOutput: string | null }
  draftShortOutline?: { artifactIds: string[]; completedOutput: string | null; promptHash: string; initialDraftTask?: GenerationTask; retry: ShortOutlineRetry }
  selectedDrafts?: PreparedDraftContext['selectedDrafts']
  materialAdmission?: MaterialAdmission
}
export interface PlanningContinuationReceipt {
  kind: 'planning-continuation'
  sourceHandle: MainGenerationRunHandle
  nextHandle: MainGenerationRunHandle
  requestHash: string
}
export interface BlueprintAuthorEditReceipt {
  kind: 'blueprint-author-edit'
  operationId: string
  sourceHandle: MainGenerationRunHandle
  requestedRange: { from: number; to: number }
  committedRange: { from: number; to: number }
  remainingRange: { from: number; to: number } | null
  payloadHash: string
}
export type BlueprintRecovery = {
  sourceHandle: MainGenerationRunHandle
  leaseEpoch: string
  draft: string
} & ({
  editRange: { from: number; to: number } | null
  writeState: 'ready' | 'in-flight' | 'source-changed' | 'author-saved' | 'continued' | 'complete'
  saved: BlueprintAuthorEditReceipt | null
  diagnostic?: never
} | {
  writeState: 'unavailable'
  editRange: null
  saved: null
  diagnostic: BlueprintRecoveryDiagnostic
})
export interface PlanningContinuation {
  sourceHandle: MainGenerationRunHandle
  remainingRange: { from: number; to: number } | null
  targetUnits: number
  state: 'ready' | 'in-flight' | 'source-changed' | 'source-invalid' | 'save-prefix' | 'complete' | 'continued'
  nextHandle?: MainGenerationRunHandle
}
export interface PrepareDraftContextRequest {
  chapterNumber: number
  modelId: string
  promptKeys: string[]
  skillStages: WritingSkillStage[]
  authorInputs: GenerationAuthorInput[]
  query: string
  selectedDraftIds: number[]
  batchId?: string
  contextWindowRetryOf?: MainGenerationRunHandle
  characterRosterRevision?: number
}
export interface PreparedDraftContext {
  preparationId: string
  knowledgeSnapshot: GenerationKnowledgeSnapshot
  selectedDrafts: { draftId: number; chapterNumber: number; version: number; contentHash: string; content: string; required?: boolean }[]
  materialBudget: MaterialBudget
}
export const MIN_BATCH_CHAPTERS = 1
export const MAX_BATCH_CHAPTERS = 10
export interface GenerationBatchIntent {
  mode: 'draft_review' | 'auto_finalize'
  range: { startChapter: number; endChapter: number }
  targetUnits: number
}
export interface BeginGenerationBatchRequest extends GenerationBatchIntent {
  uiActionNonce: string
  modelId: string
  authorInputs: GenerationAuthorInput[]
  promptKeys: string[]
  skillStages: WritingSkillStage[]
}
export interface GenerationBatchProgress extends GenerationBatchIntent {
  modelId: string
  batchId: string
  rootHandle: MainGenerationRunHandle
  completedChapters: { chapterNumber: number; draftId: number; version: number; contentHash: string;
    sourceRunHandle: MainGenerationRunHandle; finalizationId?: string; pendingFinalizationId?: string; postProcessComplete?: boolean }[]
  currentChapterRunHandle?: MainGenerationRunHandle
  nextChapterNumber: number | null
  authorInputs: GenerationAuthorInput[]
}
export interface GenerationBatchHistory extends GenerationBatchProgress {
  sourceCurrent: boolean
}
export interface GenerationRecoveryList {
  planning: GenerationRecoveryContext[]
  editors: import('./editor-inline-generation').EditorInlineRecovery[]
  reviews: { view: MainGenerationRunView; recovery: import('./review-revision-generation').ReviewRevisionRecovery }[]
  batches: GenerationBatchHistory[]
  drafts: { view: MainGenerationRunView; recovery: GenerationRecoveryContext }[]
  partial: boolean
}

export interface BeginGenerationRequest {
  importSlot?: ImportGenerationSlot
  importExecution?: ImportRunExecutionAuthority
  operation: string
  uiActionNonce: string
  modelId: string
  chapterNumber?: number
  selectedDraftIds: number[]
  selectedFinalizedDraftIds: number[]
  selectedBlueprintChapterNumbers?: number[]
  promptKeys: string[]
  skillStages: WritingSkillStage[]
  authorInputs?: GenerationAuthorInput[]
  output: 'visible-text' | 'structured-data'
  outputOverrides?: { purpose: string; output: 'visible-text' | 'structured-data' }[]
  parentRootActionId?: string
  continueDirectoryOperationId?: string
  batchId?: string
  batchIntent?: GenerationBatchIntent
  preparationId?: string
  finalizedCharacterContextId?: string
  reviewRevisionContextId?: string
  agentWorkflowRegistrationId?: string
  materialDecision?: MaterialDecisionReceipt
}
export interface ExecuteGenerationRequest {
  handle: MainGenerationRunHandle
  invocationNonce: string
  task: GenerationTask
}
export interface GenerationOwnerChannels {
  'generation:prepare-draft-context': { args: [PrepareDraftContextRequest]; return: PreparedDraftContext }
  'generation:commit-draft': { args: [GenerationDraftCommitRequest]; return: GenerationDraftCommitReceipt }
  'generation:read-context': { args: [{ handle: MainGenerationRunHandle }]; return: GenerationRecoveryContext }
  'generation:retry-draft-short-outline': { args: [{ handle: MainGenerationRunHandle; failedAttemptId: string }]; return: MainGenerationExecuteReceipt }
  'generation:begin-batch': { args: [BeginGenerationBatchRequest]; return: GenerationBatchProgress }
  'generation:read-batch': { args: [{ batchId: string }]; return: GenerationBatchProgress }
  'generation:list-batches': { args: []; return: GenerationBatchHistory[] }
  'generation:list-recovery': { args: []; return: GenerationRecoveryList }
  'generation:find-blueprint-recovery': { args: []; return: GenerationRecoveryContext | null }
  'generation:set-recovery-abandoned': { args: [{ handle: MainGenerationRunHandle; abandoned: boolean }]; return: void }
  'generation:confirm-batch-finalization': { args: [{ batchId: string; chapterNumber: number; finalizationId: string }]; return: GenerationBatchProgress }
  'generation:list-directory-progress': { args: []; return: DirectoryGenerationCatalog }
  'generation:compose-visible': { args: [MainGenerationRunHandle, string[], string | undefined, VisibleCompositionAlgorithm?]; return: VisibleCompositionReceipt }
  'generation:read-visible-composition': { args: [MainGenerationRunHandle]; return: VisibleCompositionReceipt | null }
  'generation:begin': { args: [BeginGenerationRequest]; return: MainGenerationRunView }
  'generation:bind-material-decision': { args: [{ handle: MainGenerationRunHandle; materialDecision: MaterialDecisionReceipt }]; return: MainGenerationRunView }
  'generation:execute': { args: [ExecuteGenerationRequest]; return: MainGenerationExecuteReceipt }
  'generation:read': { args: [MainGenerationRunHandle]; return: MainGenerationRunView }
  'generation:list': { args: [operations: readonly string[]]; return: MainGenerationRunSummary[] }
  'generation:cancel': { args: [MainGenerationRunHandle]; return: MainGenerationRunView }
  'generation:pause': { args: [MainGenerationRunHandle]; return: MainGenerationRunView }
  'generation:resume': { args: [MainGenerationRunHandle]; return: MainGenerationRunView }
  'generation:restart': { args: [MainGenerationRunHandle, BeginGenerationRequest]; return: MainGenerationRunView }
  'generation:discard-candidate': { args: [MainGenerationRunHandle, string]; return: MainGenerationRunView }
}
export interface GenerationOwnerEvents {
  'generation:snapshot': MainGenerationSnapshot
  'generation:reasoning': MainGenerationReasoningEvent
}

export function generationOutputContract(selection: BeginGenerationRequest): string | Readonly<Record<string, unknown>> {
  const overrides = selection.outputOverrides
  if (!['visible-text', 'structured-data'].includes(selection.output)
    || overrides !== undefined && (!Array.isArray(overrides) || overrides.length === 0 || overrides.length > 8
      || overrides.some(item => !item || Object.keys(item).some(key => !['purpose', 'output'].includes(key))
        || !/^[a-z0-9][a-z0-9:_-]{0,127}$/u.test(item.purpose)
        || !['visible-text', 'structured-data'].includes(item.output))
      || new Set(overrides.map(item => item.purpose)).size !== overrides.length))
    throw new Error('GENERATION_OUTPUT_CONTRACT_INVALID')
  return overrides ? { primary: selection.output, overrides: structuredClone(overrides) } : selection.output
}
