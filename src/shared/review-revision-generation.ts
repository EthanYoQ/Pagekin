import type { MainGenerationRunHandle, MainGenerationSnapshot } from '../services/generation/generation-runtime'
import type { GenerationAuthorInput, VisibleCompositionReceipt } from './generation-owner-contract'
import type { ExpectedDraftSource, NovelConfig } from './ipc-channels'
import type { DraftStatus } from './draft-status'
import type { Locale } from '../i18n/types'
import type { WritingLanguage } from './writing-language'
import type { FrozenChapterGoals } from './chapter-goal-review'
import type { BlueprintForPreflight, ConsistencyFinding } from './consistency-preflight'
import type { FinalizedContinuityProjection, FinalizedSourceIdentity } from './finalized-continuity'
import type { HumanConfirmedReviewSnapshot } from './human-confirmed-review'
import type { ReviewCycleRecheckContext } from './review-cycle'
import { renderHumanConfirmedReviewBrief } from './human-confirmed-review'
import { writingLanguageText } from './writing-language'

export type ReviewRevisionOperation = 'review-chapter' | 'refine-draft' | 'refine-from-review'
export interface PrepareReviewRevisionRequest {
  operation: ReviewRevisionOperation
  draftId: number
  expectedDraft: { chapterNumber: number; version: number; status: DraftStatus; contentHash: string }
  reviewSourceId?: number
  confirmedReviewContent?: string
  reviewCycleId?: string
  expectedMergedHash?: string
  authorInputs: GenerationAuthorInput[]
  uiLocale: Locale
}
export interface ReviewMaterialIdentity {
  projectId: string
  sourceId: string
  revision: number
  contentHash: string
  provenance: 'finalized' | 'legacy' | 'author' | 'derived' | 'generated' | 'unknown'
}
export interface ReviewFinalizedMaterial {
  draftId: number
  chapterNumber: number
  chapterTitle: string
  content: string
  source?: FinalizedSourceIdentity
  projection?: FinalizedContinuityProjection
  identity?: ReviewMaterialIdentity
}
export interface ReviewRevisionMaterials {
  operation: ReviewRevisionOperation
  source: ExpectedDraftSource
  sourceHash: string
  config: NovelConfig
  writingLanguage: WritingLanguage
  uiLocale: Locale
  authorInputs: GenerationAuthorInput[]
  characterStates: string
  worldbuilding: string
  history: ReviewFinalizedMaterial[]
  predecessor?: ReviewFinalizedMaterial
  blueprints: BlueprintForPreflight[]
  frozenGoals: FrozenChapterGoals
  preflightFindings: ConsistencyFinding[]
  confirmation?: { reviewSourceId: number; content: string; originalReviewContentHash: string; snapshot: HumanConfirmedReviewSnapshot }
  recheck?: ReviewCycleRecheckContext
}
export type ReviewRevisionContextV1 = { version: 1 } & ReviewRevisionMaterials
export type ReviewRevisionContextV2 = { version: 2 } & Pick<ReviewRevisionMaterials, 'operation' | 'source' | 'sourceHash'
  | 'writingLanguage' | 'uiLocale' | 'authorInputs' | 'frozenGoals' | 'preflightFindings' | 'confirmation' | 'recheck'>
  & { wordsPerChapter: number; inputHash: string }
export type ReviewRevisionContext = ReviewRevisionContextV1 | ReviewRevisionContextV2
export const reviewWordsPerChapter = (context: ReviewRevisionContext): number =>
  context.version === 1 ? context.config.wordsPerChapter : context.wordsPerChapter
export function freezeReviewRevisionContext(materials: ReviewRevisionMaterials, version: 1 | 2,
  sha256: (text: string) => string): ReviewRevisionContext {
  return version === 1 ? { version: 1, ...materials } : reviewRevisionContextV2(materials, sha256(JSON.stringify(materials)))
}
export function reviewRevisionContextV2(materials: ReviewRevisionMaterials, inputHash: string): ReviewRevisionContextV2 {
  const { operation, source, sourceHash, writingLanguage, uiLocale, authorInputs, frozenGoals, preflightFindings, confirmation, recheck } = materials
  return { version: 2, operation, source, sourceHash, writingLanguage, uiLocale, authorInputs, frozenGoals, preflightFindings,
    wordsPerChapter: materials.config.wordsPerChapter, ...(confirmation ? { confirmation } : {}), ...(recheck ? { recheck } : {}), inputHash }
}

export function reviewRevisionAiBrief(context: Pick<ReviewRevisionMaterials, 'confirmation' | 'writingLanguage'>): string {
  const snapshot = context.confirmation?.snapshot
  return snapshot ? renderHumanConfirmedReviewBrief({ ...snapshot, authorGuidance: '',
    items: snapshot.items.filter(item => item.origin === 'ai') }, context.writingLanguage) : ''
}

export function reviewRevisionAuthorMaterial(context: ReviewRevisionMaterials): string {
  const text = (zh: string, en: string) => writingLanguageText(context.writingLanguage, zh, en)
  const snapshot = context.confirmation?.snapshot
  const sources: [string, string | undefined][] = [
    ['config.worldSetting', context.config.worldSetting],
    ['config.coreOutline', context.config.coreOutline],
    ['worldbuilding', context.worldbuilding],
  ]
  sources.sort((a, b) => (b[1]?.length ?? 0) - (a[1]?.length ?? 0))
  const authorText = (source: string, value: string | undefined) => {
    const original = value && sources.find(([, candidate]) => candidate?.startsWith(value))
    return original && original[0] !== source
      ? text(`（本来源原文与 ${original[0]} 的完整前缀相同，见该来源原文。）`,
        `(This source exactly matches a complete prefix of ${original[0]}; see that original text.)`)
      : value
  }
  return [
    text('【作者确认项目配置｜约束而非已发生事实】', '[Author-confirmed project configuration | constraints, not established history]'),
    JSON.stringify({ ...context.config, ...(context.operation === 'refine-draft' ? { writingStyle: undefined } : {}), globalGuidance: undefined,
      coreOutline: authorText('config.coreOutline', context.config.coreOutline),
      worldSetting: authorText('config.worldSetting', context.config.worldSetting) }, null, 2),
    text('【作者全局创作指导｜约束而非已发生事实】', '[Author global creative guidance | constraints, not established history]'),
    context.config.globalGuidance,
    text('【世界观设定】', '[Worldbuilding]'), authorText('worldbuilding', context.worldbuilding),
    text('【作者角色状态｜以标注时点为准】', '[Author character state | scoped to its annotated time]'), context.characterStates,
    text('【本章作者指导｜约束】', '[Current chapter author guidance | constraints]'),
    JSON.stringify(context.blueprints.filter(blueprint => blueprint.chapterNumber === context.source.chapterNumber), null, 2),
    text('【后续蓝图/计划｜非既定历史】', '[Future blueprints/plans | not established history]'),
    JSON.stringify(context.blueprints.filter(blueprint => blueprint.chapterNumber !== context.source.chapterNumber), null, 2),
    text('【本章冻结目标｜须由正文证明】', '[Frozen chapter goals | require manuscript evidence]'),
    JSON.stringify(context.frozenGoals),
    ...context.authorInputs.map(input => input.text),
    ...(snapshot ? [renderHumanConfirmedReviewBrief({ ...snapshot,
      items: snapshot.items.filter(item => item.origin === 'author') }, context.writingLanguage)] : []),
  ].filter(Boolean).join('\n\n')
}
export interface PreparedReviewRevisionContext {
  contextId: string
  context: ReviewRevisionContext
  materials: ReviewRevisionMaterials
  parentRootActionId?: string
  modelId?: string
}
export interface ReviewGenerationCommitRequest {
  contextId: string
  handle: MainGenerationRunHandle
  artifact: { artifactId: string; revision: number; textHash: string }
}
export interface RevisionGenerationCommitRequest {
  contextId: string
  handle: MainGenerationRunHandle
  expectedCompositionHash: string
}
export interface ReviewRevisionCommitReceipt {
  success: true
  kind: 'review' | 'revision'
  id: number
  index: number
  content: string
  contentHash: string
  source: ExpectedDraftSource
  revisionStatus?: 'pending' | 'merged' | 'discarded'
  reviewCycle?: { cycleId: string; revisionStatus: 'merge-committed'; recheckCount: 0 | 1;
    disposition: 'required' | 'not-required' | 'completed' }
}
export interface ReviewRevisionRecovery {
  handle: MainGenerationRunHandle
  context: ReviewRevisionContext
  materials?: ReviewRevisionMaterials
  modelId: string
  sourceStatus: 'current' | 'conflict'
  canResume: boolean
  contextId?: string
  saved?: ReviewRevisionCommitReceipt
  composition?: VisibleCompositionReceipt
  lastCompositionFinishReason?: string | null
  latestArtifact?: MainGenerationSnapshot
  latestArtifactFinishReason?: string | null
  attemptedPurposes: string[]
}
export interface ReviewRevisionGenerationInvokeChannels {
  'review-revision:prepare': { args: [request: PrepareReviewRevisionRequest]; return: PreparedReviewRevisionContext }
  'review-revision:commit-review': { args: [request: ReviewGenerationCommitRequest]; return: ReviewRevisionCommitReceipt }
  'review-revision:commit-revision': { args: [request: RevisionGenerationCommitRequest]; return: ReviewRevisionCommitReceipt }
  'review-revision:read-recovery': { args: [request: { handle: MainGenerationRunHandle }]; return: ReviewRevisionRecovery }
}
