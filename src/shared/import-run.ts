import type { Failure } from './failure'
export type ImportRunLocale = 'zh-CN' | 'en-US'
export type ImportPurpose = 'reference' | 'author-manuscript'
/** 反推结果怎样写进项目设定、文风与蓝图；运行创建时冻结。 */
export type ImportCoreWriteMode = 'replace' | 'fill-empty'
export type ImportTarget = 'new-project' | 'current-project'

/** 只有参考小说导入对话框新建的项目才整体写入；落到已有项目一律只补空白。 */
export function importCoreWriteModeFor(purpose: ImportPurpose, target: ImportTarget | undefined): ImportCoreWriteMode {
  return purpose === 'reference' && target === 'new-project' ? 'replace' : 'fill-empty'
}
export const AUTHOR_IMPORT_PREVIEW_STALE = 'AUTHOR_IMPORT_PREVIEW_STALE' as const

export class AuthorImportPreviewStaleError extends Error {
  readonly code = AUTHOR_IMPORT_PREVIEW_STALE

  constructor(message = 'Author manuscript authority changed after preview confirmation') {
    super(message)
    this.name = 'AuthorImportPreviewStaleError'
  }
}

export type ImportRunStage =
  | 'parsing'
  | 'prepared'
  | 'knowledge'
  | 'global'
  | 'style'
  | 'blueprints'
  | 'author-commit'
  | 'author-publish'
  | 'author-postprocess'
  | 'refresh'
  | 'completed'

export type ImportRunStatus = 'ready' | 'running' | 'failed' | 'cancelled' | 'completed'

const IMPORT_STAGE_PLANS = {
  reference: ['knowledge', 'global', 'style', 'blueprints', 'refresh', 'completed'],
  author: ['author-commit', 'author-publish', 'author-postprocess', 'refresh', 'completed'],
  authorWithInference: [
    'author-commit', 'author-publish', 'author-postprocess', 'global', 'style', 'blueprints', 'refresh', 'completed',
  ],
} as const satisfies Record<string, readonly ImportRunStage[]>

export function importStagesFor(run: { purpose: ImportPurpose; authorInference?: boolean }): readonly ImportRunStage[] {
  if (run.purpose === 'reference') return IMPORT_STAGE_PLANS.reference
  return run.authorInference ? IMPORT_STAGE_PLANS.authorWithInference : IMPORT_STAGE_PLANS.author
}

export type ImportRunDirectCheckpointStage =
  | 'knowledge'
  | 'author-publish'
  | 'author-postprocess'
  | 'refresh'
export type ImportRunEffectKind =
  | 'project-global-facts'
  | 'project-writing-style'
  | 'chapter-blueprint-range'
  | 'author-finalized-batch'

export type ImportRunEffectReceiptState = 'prepared' | 'committed'
export const IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION = 1 as const
export const IMPORT_RUN_KNOWLEDGE_BATCH_SIZE = 10
export const IMPORT_RUN_BLUEPRINT_BATCH_SIZE = 5

export function isImportRunDirectCheckpointStage(stage: unknown): stage is ImportRunDirectCheckpointStage {
  return stage === 'knowledge'
    || stage === 'author-publish'
    || stage === 'author-postprocess'
    || stage === 'refresh'
}

export interface ImportRunExecutionAuthority {
  owner: string
  epoch: number
}

export interface ImportRunExecutionLease extends ImportRunExecutionAuthority {
  expiresAt: number
}

export interface ImportRunStartResult {
  run: ImportRunSnapshot
  execution: ImportRunExecutionLease
}

export interface ImportRunEffectReceipt {
  schemaVersion: typeof IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION
  runId: string
  effectNamespace: string
  effectKey: string
  stage: ImportRunStage
  batchId: string
  kind: ImportRunEffectKind
  payloadHash: string
  state: ImportRunEffectReceiptState
  payload: unknown
  effectReceipt?: unknown
  createdAt: string
  updatedAt: string
}

export interface ImportRunChapterBatchCheckpoint {
  startChapter: number
  endChapter: number
  contentFingerprintPrefixes: string[]
}

const IMPORT_RUN_CONTENT_FINGERPRINT = /^[a-f0-9]{64}$/u
const IMPORT_RUN_CHAPTER_BATCH_CHECKPOINT = /^([1-9]\d*)-([1-9]\d*)-([a-f0-9]{8}(?:\.[a-f0-9]{8})*)$/u

// i18n-exempt: 内部不变量与收据完整性校验：只有代码缺陷或作品库被外部改坏才会触发
export function createImportRunChapterBatchCheckpointId(
  chapters: readonly Pick<ImportRunChapterInput, 'number' | 'contentFingerprint'>[],
): string {
  if (chapters.length === 0) throw new Error('导入章节批次不能为空')
  for (const [index, chapter] of chapters.entries()) {
    if (!Number.isSafeInteger(chapter.number) || chapter.number < 1) throw new Error('导入章节批次章号无效')
    if (!IMPORT_RUN_CONTENT_FINGERPRINT.test(chapter.contentFingerprint)) throw new Error('导入章节批次内容指纹无效')
    if (index > 0 && chapter.number !== chapters[index - 1]!.number + 1) {
      throw new Error('导入章节批次必须连续')
    }
  }
  return `${chapters[0]!.number}-${chapters.at(-1)!.number}-${chapters
    .map(chapter => chapter.contentFingerprint.slice(0, 8))
    .join('.')}`
}

export function parseImportRunChapterBatchCheckpointId(
  checkpointId: string,
): ImportRunChapterBatchCheckpoint | null {
  const match = IMPORT_RUN_CHAPTER_BATCH_CHECKPOINT.exec(checkpointId)
  if (!match) return null
  const startChapter = Number(match[1])
  const endChapter = Number(match[2])
  const contentFingerprintPrefixes = match[3]!.split('.')
  if (
    !Number.isSafeInteger(startChapter)
    || !Number.isSafeInteger(endChapter)
    || endChapter < startChapter
    || contentFingerprintPrefixes.length !== endChapter - startChapter + 1
  ) return null
  return { startChapter, endChapter, contentFingerprintPrefixes }
}

export function expectedImportRunEffectKey(
  kind: ImportRunEffectKind,
  stage: ImportRunStage,
  batchId: string,
): string | null {
  if (kind === 'project-global-facts' && stage === 'global' && batchId === 'done') return 'global-facts'
  if (kind === 'project-writing-style' && stage === 'style' && batchId === 'done') return 'writing-style'
  if (
    kind === 'chapter-blueprint-range'
    && stage === 'blueprints'
    && parseImportRunChapterBatchCheckpointId(batchId)
  ) {
    return `blueprints:${batchId}`
  }
  if (kind === 'author-finalized-batch' && stage === 'author-commit' && batchId === 'done') {
    return 'author-finalized-batch'
  }
  return null
}

// i18n-exempt: 内部不变量与收据完整性校验：只有代码缺陷或作品库被外部改坏才会触发
export function assertImportRunEffectReceiptMetadata(
  receipt: ImportRunEffectReceipt,
  run: ImportRunSnapshot,
): void {
  const expectedNamespace = `import:${run.purpose}:${run.id}`
  const expectedKey = expectedImportRunEffectKey(receipt.kind, receipt.stage, receipt.batchId)
  if (
    receipt.schemaVersion !== IMPORT_RUN_EFFECT_RECEIPT_SCHEMA_VERSION
    || receipt.runId !== run.id
    || run.effectNamespace !== expectedNamespace
    || receipt.effectNamespace !== expectedNamespace
    || !expectedKey
    || receipt.effectKey !== expectedKey
  ) throw new Error('导入 effect receipt 元数据损坏')
}

export interface ImportRunPrepareEffectReceiptRequest {
  runId: string
  stage: ImportRunStage
  batchId: string
  effectKey: string
  kind: ImportRunEffectKind
  payload: unknown
}

export interface ImportRunEffectCommitResult {
  receipt: ImportRunEffectReceipt
  run: ImportRunSnapshot
  cancelApplied: boolean
}

export interface ImportSourceDisplayMetadata {
  displayName: string
  mediaType: string
  size: number
}

export interface ImportSourceFileIdentity {
  canonicalLocation: string
  fileIdentity?: string
}

export interface ImportRunChapterInput {
  number: number
  sourceIndex?: number
  sourceChapterNumber?: number
  title: string
  contentFingerprint: string
  contentSize: number
  content: string
}

export interface ImportRunChapterSnapshot {
  number: number
  title: string
  contentFingerprint: string
  contentSize: number
  content: string
}

export interface ImportRunPrepareRequest {
  runId: string
  purpose: ImportPurpose
  sourceFingerprint: string
  sourceIds?: string[]
  sourceFingerprints?: string[]
  sourceDisplay: ImportSourceDisplayMetadata[]
  locale: ImportRunLocale
  authorityFingerprint?: string
  expectedManifestFingerprint?: string
  authorInference?: boolean
  coreWriteMode?: ImportCoreWriteMode
  chapters: ImportRunChapterInput[]
}

export interface ImportRunBeginParsingRequest {
  runId: string
  purpose: ImportPurpose
  sourceFingerprint: string
  sourceIds: string[]
  sourceFingerprints?: string[]
  legacySourceFingerprints?: string[]
  legacyCollectionFingerprint?: string
  sourceDisplay: ImportSourceDisplayMetadata[]
  locale: ImportRunLocale
  coreWriteMode?: ImportCoreWriteMode
}

export type ImportChapterTargetStatus = 'new' | 'duplicate' | 'conflict'

export interface ImportChapterPreview {
  number: number
  title: string
  wordCount: number
  targetStatus?: ImportChapterTargetStatus
}

export interface ImportInspectionSummary {
  inspectionId: string
  purpose: ImportPurpose
  sourceCount: number
  sourceDisplayNames: string[]
  chapterCount: number
  totalWords: number
  totalBytes: number
  preview: ImportChapterPreview[]
  previewRemaining?: number
}

export interface ImportRunPreparationInspection extends ImportInspectionSummary {
  preview: Array<ImportChapterPreview & { targetStatus: ImportChapterTargetStatus }>
  previewRemaining: number
}

export type ImportRunPrepareFromInspectionRequest = {
  inspectionId: string
  runId: string
  purpose: 'reference'
  locale: ImportRunLocale
  target: ImportTarget
} | {
  inspectionId: string
  runId: string
  purpose: 'author-manuscript'
  locale: ImportRunLocale
  authorityFingerprint: string
  manifestFingerprint: string
  authorInference: boolean
}

export interface ImportNovelFileSelectionRequest {
  runId: string
  purpose: ImportPurpose
  locale: ImportRunLocale
  target: ImportTarget
  expectedProjectPath: string
}

export interface ImportRunSnapshot {
  id: string
  purpose: ImportPurpose
  rootRunId: string
  effectNamespace: string
  manifestFingerprint?: string
  authorityFingerprint?: string
  authorInference?: boolean
  coreWriteMode: ImportCoreWriteMode
  sourceDisplay: ImportSourceDisplayMetadata[]
  unfinishedSourceDisplay?: ImportSourceDisplayMetadata[]
  locale: ImportRunLocale
  stage: ImportRunStage
  status: ImportRunStatus
  completedBatches: Partial<Record<ImportRunStage, string[]>>
  lastError: string
  resumable: boolean
  cancelRequested: boolean
  totalChapters: number
  totalContentSize: number
  manifestChapterCount: number
  manifestContentSize: number
  manifestWordCount: number
  completedChapters: number
  completedSources?: number
  totalSources?: number
  progressCompleted?: number
  progressTotal?: number
  baseRunId?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export type ImportRunClassification = 'exact-duplicate' | 'new' | 'conflict' | 'resumable'

export interface ImportRunPreparationResult {
  classification: ImportRunClassification
  run?: ImportRunSnapshot
  newChapterNumbers: number[]
  conflictChapterNumbers: number[]
  duplicateChapterNumbers: number[]
  inspection?: ImportRunPreparationInspection
}

export type ImportRunPrepareFromInspectionResult = {
  success: true
  preparation: ImportRunPreparationResult
} | {
  success: false
  failure?: Failure
}
