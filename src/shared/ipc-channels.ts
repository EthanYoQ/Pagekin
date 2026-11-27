import type { GenerationOwnerChannels, GenerationOwnerEvents } from './generation-owner-contract'
import type { AiSources } from './novel-config-ai-sources'
import type { DamagedReviewCycle } from './damaged-review-cycle'
import type { CharacterProposalChannels } from './character-proposal'
import type { CharacterContinuityTimeline, ContinuityNode } from './character-continuity'
import type { FinalizedCharacterGenerationChannels } from './finalized-character-generation'
import type { ReviewRevisionGenerationInvokeChannels } from './review-revision-generation'
import type { AgentGenerationChannels } from './agent-generation'
import type { ImportGenerationChannels } from './import-generation'
import type { EditorInlineGenerationChannels } from './editor-inline-generation'
import type { FinalizationGenerationChannels } from './finalization-generation'
import type { GraphGenerationChannels } from './graph-generation'
import type { LegacyRosterGenerationChannels } from './legacy-roster-generation'
import type { CharacterAvatarChannels } from './character-avatar'
import type { CloudBackupChannels } from './cloud-backup'
import type { ProjectOverview } from './project-overview'
import type { ModelStage, StageModelIds } from './model-stage-routing'
import type { KnowledgeSearchHit } from './knowledge-ranking'
import type { Failure } from './failure'
import type { InterfaceLocale } from '../i18n/types'
import type { StartupChannels } from './startup-contract'
import type {
  CreativeStrategy,
  GenerationReasoningStage,
  ReasoningOverride,
  VerifiedReasoningMapping,
} from './reasoning-types'
import type { EmbeddingOptions } from './embedding-options'
import type { ModelCapabilities } from './provider-presets'
import type { ModelProviderResourceId } from './model-provider-resources'
import type { WritingLanguage } from './writing-language'
import type { DraftStatus } from './draft-status'
import type { ReviewCycleProjection } from './review-cycle'
import type {
  RecoveryCandidate,
  RecoveryCandidateRecordInput,
} from './recovery-candidate'
import type {
  FinalizedContinuityProjection,
  FinalizedSourceReadResult,
  SaveFinalizedCharacterStateCandidatesRequest,
  SaveFinalizedContinuityRequest,
} from './finalized-continuity'
import type { DraftSourceDependency } from './draft-source-dependency'
import type { BlueprintForPreflight, ConsistencyExemption } from './consistency-preflight'
import type {
  NarrativeThreadAssignmentInput,
  NarrativeThreadEvent,
  NarrativeThreadEventInput,
  NarrativeThreadChapterContext,
  NarrativeThreadPlanInput,
  NarrativeThreadPlanRecord,
  NarrativeThreadView,
} from './narrative-thread'
import type { NarrativeThreadReviewCandidate } from './narrative-thread-review-candidates'
import type { PlotTreeSourceBundle } from './plot-tree'
import type {
  UpdateActionResponse,
  UpdateCheckResponse,
  UpdatePreferences,
  UpdateReminderDelay,
  UpdateState,
} from './update-types'
import type {
  ChapterDeletionOperation,
  ChapterDeletionResult,
  ChapterTrashListResult,
  DeleteFinalizedChapterRequest,
  PurgeTrashRequest,
  PurgeTrashResult,
  RestoreTrashedChapterRequest,
  RestoreTrashedChapterResult,
} from './chapter-deletion'
import type { FinalizationRepairOnOpen } from './finalization-repair'
import type { ReopenChapterRequest, ReopenChapterResult, ReplacementImpact } from './chapter-reopen'
import type {
  ImportRunChapterSnapshot,
  ImportRunEffectCommitResult,
  ImportRunEffectReceipt,
  ImportRunExecutionAuthority,
  ImportRunExecutionLease,
  ImportInspectionSummary,
  ImportPurpose,
  ImportNovelFileSelectionRequest,
  ImportRunPreparationResult,
  ImportRunPrepareFromInspectionResult,
  ImportRunPrepareFromInspectionRequest,
  ImportRunPrepareEffectReceiptRequest,
  ImportRunSnapshot,
  ImportRunStartResult,
  ImportRunStage,
} from './import-run'

export interface ConfigChannels {
  'config:get': {
    args: []
    return: GlobalConfig
  }
  'config:set': {
    args: [config: Partial<Omit<GlobalConfig, 'stageModelIds'>>]
    return: { success: boolean; failure?: Failure }
  }
}

export interface UpdateChannels {
  'update:get-state': {
    args: []
    return: UpdateState
  }
  'update:check': {
    args: []
    return: UpdateCheckResponse
  }
  'update:download': {
    args: []
    return: UpdateActionResponse
  }
  'update:open-release': {
    args: []
    return: UpdateActionResponse
  }
  'update:defer-reminder': {
    args: [days: UpdateReminderDelay]
    return: UpdateActionResponse
  }
  'update:quit-and-install': {
    args: []
    return: UpdateActionResponse
  }
}

export interface UpdateStateEvents {
  'update:state': UpdateState
}

export interface WindowChannels {
  'window:minimize': {
    args: []
    return: { success: boolean }
  }
  'window:toggle-maximize': {
    args: []
    return: { success: boolean; maximized?: boolean }
  }
  'window:close': {
    args: []
    return: { success: boolean }
  }
  'window:resolve-close': {
    args: [requestId: string, decision: 'proceed' | 'cancel']
    return: { success: boolean }
  }
  'window:notify-stage': {
    args: [notice: StageNotice]
    return: { shown: boolean }
  }
}

export interface StageNotice { title: string; body: string }

export interface WindowEvents {
  'window:close-requested': { requestId: string }
}

export interface OfficialHomepageChannels {
  'official-homepage:open': {
    args: []
    return: { success: boolean; failure?: Failure }
  }
}

export interface ModelProviderResourceChannels {
  'model-provider-resource:open': {
    args: [resource: ModelProviderResourceId]
    return: { success: boolean; failure?: Failure }
  }
}

export type DialogDirectoryKind =
  | 'writing-skill'
  | 'character-avatar'
  | 'export-directory'
  | 'import-source'
  | 'knowledge-files'
  | 'knowledge-folder'
  | 'project-archive'
  | 'project-restore-target'
  | 'legacy-project'
  | 'project-create'
  | 'project-open'

export interface GlobalConfig {
  theme: string
  outlineTargetUnits?: number
  blueprintTargetUnits?: number
  locale?: InterfaceLocale
  defaultModelId: string | null
  defaultEmbeddingModelId?: string | null
  defaultRerankModelId?: string | null
  stageModelIds?: StageModelIds
  autoOpenNextChapterAfterFinalize?: boolean
  backgroundStageNotifications?: boolean
  editorFontSize: number
  editorFontFamily: string
  autoSaveInterval: number
  updatePreferences?: UpdatePreferences
  dialogDirectories?: Partial<Record<DialogDirectoryKind, string>>
  proxy?: {
    enabled: boolean
    type: 'http' | 'socks5'
    host: string
    port: number
  }
}

export type AppErrorCode =
  | 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE'
  | 'LEGACY_VECTOR_MIGRATION_BLOCKED'
  | 'PROJECT_NOT_OPEN'
  | 'EMBEDDING_MODEL_NOT_CONFIGURED'
  | 'PROJECT_STORAGE_PATH_UNSUPPORTED'
  | 'PROJECT_ROOT_REQUIRED'
  | 'PROJECT_LEGACY_IMPORT_REQUIRED'
  | 'PROJECT_OPEN_FILES_BUSY'
  | 'PROJECT_OPEN_IO_FAILED'
  | 'PROJECT_OPEN_DAMAGED'
  | 'PROJECT_OPEN_FILES_LOCKED'
  | 'PROJECT_OPEN_ACCESS_DENIED'

export interface AppFailure {
  success: false
  errorCode: AppErrorCode
  error?: string
  failure?: Failure
}

export type AppResult<T> = T | AppFailure

export interface ProjectSessionContext {
  projectId: string
  leaseId: string
  projectPath: string
}

export interface ExpectedDraftSource {
  id: number
  chapterNumber: number
  version: number
  status: DraftStatus
  content: string
}

export type SourceDraftGuardErrorCode = 'SOURCE_DRAFT_CHANGED'

export interface CreateProjectConfig {
  name: string
  parentGrantId: string
  genre: string
  targetAudience: string
  writingLanguage?: WritingLanguage
}

export interface ProjectDirectoryGrant {
  grantId: string
  displayName: string
}

export type ProjectOpenTarget = string | ProjectDirectoryGrant

export interface PortableProjectExportRequest {
  targetArchiveGrantId: string
  projectSession: ProjectSessionContext
  exportId?: string
}

export type PortableExportPhase = 'snapshot' | 'check' | 'tidy' | 'package'

export interface PortableExportEvents {
  'portable-export:progress': { exportId?: string; phase: PortableExportPhase; round: number }
}

export interface PortableProjectExportReceipt {
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
  omittedReviewCycles?: readonly DamagedReviewCycle[]
}

export interface PortableProjectRestoreRequest {
  archiveGrantId: string
  targetGrantId: string
}

export interface PortableProjectRestoreReceipt {
  originProjectId: string
  targetProjectId: string
  targetProjectRoot: string
  snapshotGeneration: string
  portableDatabaseSha256: string
  requiresRuntimeFreezeGuard: true
}

export type PortableProjectOperationErrorCode =
  | 'PORTABLE_ARCHIVE_INVALID'
  | 'PORTABLE_ARCHIVE_LIMIT_EXCEEDED'
  | 'PORTABLE_ARCHIVE_SOURCE_CHANGED'
  | 'PORTABLE_ARCHIVE_SOURCE_UNSAFE'
  | 'PORTABLE_ARCHIVE_PUBLISH_UNSUPPORTED'
  | 'PORTABLE_ARCHIVE_TARGET_EXISTS'
  | 'PORTABLE_ARCHIVE_TARGET_UNWRITABLE'
  | 'PORTABLE_ASSET_MISSING'
  | 'PORTABLE_ASSET_UNSAFE'
  | 'PORTABLE_CONTEXT_INVALID'
  | 'PORTABLE_EXPORT_AVATAR_DAMAGED'
  | 'PORTABLE_EXPORT_UNRESOLVED_AVATAR_DAMAGED'
  | 'PORTABLE_EXPORT_INTERRUPTED'
  | 'PORTABLE_EXPORT_SOURCE_CHANGED'
  | 'PORTABLE_EXPORT_SOURCE_UNREADABLE'
  | 'PORTABLE_GRANT_INVALID'
  | 'PORTABLE_SCHEMA_UNSUPPORTED'
  | 'PORTABLE_TARGET_INSIDE_SOURCE'
  | 'PORTABLE_UNSAFE_PROJECTION'
  | 'PORTABLE_RESTORE_CANCELLED'
  | 'PORTABLE_RESTORE_INVALID'
  | 'PORTABLE_RESTORE_TARGET_EXISTS'
  | 'PORTABLE_RESTORE_UNSAFE_TARGET'
  | 'PORTABLE_RESTORE_ARCHIVE_MISSING'
  | 'PORTABLE_RESTORE_ARCHIVE_UNREADABLE'

export type PortableProjectOperationFailure = {
  success: false
  error: string
  failure?: Failure
  errorCode?: PortableProjectOperationErrorCode
  damagedReviewCycle?: DamagedReviewCycle
}

export interface ProjectChannels {
  'dialog:select-legacy-project': {
    args: []
    return: ProjectDirectoryGrant | null
  }
  'project:import-legacy-copy': {
    args: [sourceGrantId: string, targetGrantId: string]
    return: { state: 'ready'; projectId: string; targetRoot: string; warning?: string }
      | { state: 'cancelled' }
      | { state: 'blocked'; code: string }
  }
  'project:get-runtime-context': {
    args: []
    return: {
      activeProjectPath: string | null
      dbReady: boolean
    }
  }
  'project:create': {
    args: [
      config: CreateProjectConfig,
      requestToken: string,
      rendererProjectPath: string | null,
    ]
    return: {
      success: boolean
      projectId: string
      projectPath?: string
      requestToken: string
      activeProjectPath: string | null
      databaseRestored: boolean
      dbReady: boolean
      stale?: boolean
      error?: string
      failure?: Failure
      errorCode?: AppErrorCode
    }
  }
  'project:open': {
    args: [target: ProjectOpenTarget, requestToken: string, rendererProjectPath: string | null]
    return: {
      success: boolean
      project: ProjectData | null
      requestToken: string
      activeProjectPath: string | null
      databaseRestored: boolean
      dbReady: boolean
      stale?: boolean
      error?: string
      failure?: Failure
      legacyImportSource?: ProjectDirectoryGrant
      errorCode?: AppErrorCode
      finalizationRepair?: FinalizationRepairOnOpen
      sealedGenerationCount?: number
    }
  }
  'project:save': {
    args: [projectId: string, data: Partial<ProjectData>, expectedProjectPath: string]
    return: { success: boolean; error?: string; failure?: Failure }
  }
  'project:update-config': {
    args: [projectId: string, data: Partial<ProjectData>, expectedProjectPath: string]
    return: { success: boolean; error?: string; failure?: Failure }
  }
  'project:recent-list': {
    args: []
    return: Array<{
      name: string
      path: string
      updatedAt: string
      previewCapabilityId?: string
      projectId?: string
    }>
  }
  'project:peek-overview': {
    args: [capabilityId: string]
    return: ProjectOverview
  }
  'project:overview-current': {
    args: []
    return: ProjectOverview
  }
  'project:recent-remove': {
    args: [projectPath: string]
    return: { success: boolean; error?: string; failure?: Failure }
  }
  'project:archive-export': {
    args: [request: PortableProjectExportRequest]
    return: { success: true; receipt: PortableProjectExportReceipt } | PortableProjectOperationFailure
  }
  'project:archive-restore': {
    args: [request: PortableProjectRestoreRequest]
    return: {
      success: true
      receipt: PortableProjectRestoreReceipt
      recentProjectUpdated: boolean
      warning?: string
    } | PortableProjectOperationFailure
  }
  'dialog:select-project-archive-export': {
    args: [suggestedName: string]
    return: ExternalFileGrant | null
  }
  'dialog:select-project-archive': {
    args: []
    return: ExternalFileGrant | null
  }
  'dialog:select-project-restore-target': {
    args: [suggestedName: string]
    return: ExternalFileGrant | null
  }
  'project:delete': {
    args: [projectPath: string, projectId: string, sessionLease: string]
    return: {
      success: boolean
      directoryDeleted: boolean
      databaseRestored: boolean
      error?: string
      failure?: Failure
      warning?: string
    }
  }
  'project:smoke-open-request': {
    args: []
    return: { projectPath: string; markerPath: string } | null
  }
  'project:smoke-open-confirm': {
    args: [projectPath: string]
    return: { success: boolean }
  }
  'dialog:select-folder': {
    args: [purpose: 'project-create' | 'project-open']
    return: ProjectDirectoryGrant | null
  }
}

export type FileWriteCommitState = 'not_committed' | 'committed' | 'unknown'

export interface FileChannels {
  'fs:read-file': {
    args: [filePath: string, expectedProjectPath: string]
    return: { success: boolean; content: string; failure?: Failure }
  }
  'fs:write-file': {
    args: [filePath: string, content: string, expectedProjectPath: string]
    return: { success: boolean; commitState: FileWriteCommitState; failure?: Failure }
  }
  'fs:list-dir': {
    args: [dirPath: string, expectedProjectPath: string]
    return: FileNode[]
  }
  'fs:mkdir': {
    args: [dirPath: string, expectedProjectPath: string]
    return: { success: boolean; failure?: Failure }
  }
  'fs:check-exists': {
    args: [filePath: string, expectedProjectPath: string]
    return: boolean
  }
  'fs:read-json': {
    args: [filePath: string, expectedProjectPath: string]
    return: { success: boolean; data: unknown; failure?: Failure }
  }
  'fs:write-json': {
    args: [filePath: string, data: unknown, expectedProjectPath: string]
    return: { success: boolean; failure?: Failure }
  }
  'fs:grant-read-file': {
    args: [grantId: string, relativePath?: string]
    return: { success: boolean; content: string; failure?: Failure }
  }
  'fs:grant-write-file': {
    args: [grantId: string, relativePath: string, content: string]
    return:
      | { success: true }
      | { success: false; commitState: Exclude<FileWriteCommitState, 'committed'>; failure?: Failure }
  }
  'fs:grant-mkdir': {
    args: [grantId: string, relativePath: string]
    return: { success: boolean; failure?: Failure }
  }
  'dialog:select-export-directory': {
    args: []
    return: ExternalDirectoryGrant | null
  }
}

export interface DiscoveredModel {
  id: string
  name: string
  value: string
  capabilities?: Partial<ModelCapabilities>
}

export type ModelDiscoveryErrorCode =
  | 'auth'
  | 'unsupported'
  | 'network'
  | 'proxy'
  | 'invalid_response'
  | 'no_models'
  | 'no_suitable_models'

export type ModelDiscoveryResult =
  | { success: true; models: DiscoveredModel[] }
  | { success: false; errorCode: ModelDiscoveryErrorCode }

export type ModelDiscoveryRequest = Pick<
  ModelProfile,
  'provider' | 'protocol' | 'baseUrl' | 'apiKey' | 'purposes'
>

export type LocalContextWindowRequest = Pick<
  ModelProfile,
  'provider' | 'protocol' | 'baseUrl' | 'apiKey' | 'modelName'
>

export interface LLMChannels {
  'llm:discover-local-context-window': {
    args: [request: LocalContextWindowRequest]
    return: number | null
  }
  'llm:list-models': {
    args: []
    return: ModelProfile[]
  }
  'llm:discover-models': {
    args: [request: ModelDiscoveryRequest]
    return: ModelDiscoveryResult
  }
  'llm:save-model': {
    args: [model: ModelProfile]
    return: { success: boolean }
  }
  'llm:delete-model': {
    args: [modelId: string]
    return: {
      success: boolean
      error?: string
      defaultModelId?: string | null
      defaultEmbeddingModelId?: string | null
      defaultRerankModelId?: string | null
      stageModelIds?: StageModelIds
    }
  }
  'llm:get-stage-models': {
    args: []
    return: StageModelIds
  }
  'llm:set-stage-model': {
    args: [request: { stage: ModelStage; modelId: string | null }]
    return: { success: true; stageModelIds: StageModelIds } | { success: false; error: string }
  }
  'llm:set-default-model': {
    args: [modelId: string | null]
    return: { success: boolean; error?: string }
  }
  'llm:get-default-model': {
    args: []
    return: string | null
  }
  'llm:set-default-embedding-model': {
    args: [modelId: string | null]
    return: { success: boolean; error?: string }
  }
  'llm:get-default-embedding-model': {
    args: []
    return: string | null
  }
  'llm:set-default-rerank-model': {
    args: [modelId: string | null]
    return: { success: boolean; error?: string }
  }
  'llm:get-default-rerank-model': {
    args: []
    return: string | null
  }
  'llm:test-connection': {
    args: [model: ModelProfile, creativeStrategy?: CreativeStrategy]
    return: { success: boolean; error?: string }
  }
}

export interface ProjectData {
  id: string
  name: string
  path: string
  sessionLease?: string
  novelConfig: NovelConfig
  aiSources?: AiSources
  characterStates: string
  createdAt: string
  updatedAt: string
}

export interface NovelConfig {
  writingLanguage?: WritingLanguage
  creativeStrategy?: CreativeStrategy
  narrativeThreadDormantChapterThreshold?: number
  genre: string
  subGenre: string
  targetAudience: string
  totalChapters: number
  wordsPerChapter: number
  plotStructure: 'three_act' | 'heros_journey' | 'save_the_cat' | 'kishotenketsu' | 'multi_thread' | 'freeform'
  narrativePOV: 'third_limited' | 'first_person' | 'third_omniscient' | 'multi_pov'
  coreOutline: string
  worldSetting: string
  goldenFinger: string
  protagonistProfile: string
  globalGuidance: string
  writingStyle?: string
  referenceWorks?: string
}

export interface FileNode {
  name: string
  path: string
  isDir: boolean
  children?: FileNode[]
}

export interface ExternalFileGrant {
  grantId: string
  displayName: string
}

export type ExternalDirectoryGrant = ExternalFileGrant

export interface AppPromptTemplate {
  key: string
  writingLanguage?: WritingLanguage
  [key: string]: unknown
}

export interface PromptLoadDiagnostic {
  key?: string
  writingLanguage?: WritingLanguage
  path: string
  error: string
}

export interface AppPromptLoadReceipt {
  templates: AppPromptTemplate[]
  diagnostics: PromptLoadDiagnostic[]
}

export interface AppDataChannels {
  'prompt:load-global': { args: []; return: AppPromptLoadReceipt }
  'prompt:save-global': { args: [template: AppPromptTemplate]; return: { success: boolean; error?: string } }
  'prompt:delete-global': { args: [key: string, writingLanguage: WritingLanguage]; return: { success: boolean; error?: string } }
  'skills:list-user': {
    args: []
    return: Array<{ name: string; content: string; baseDir: string; filePath: string; bundle: import('./writing-skills').InstalledWritingSkillBundle }>
  }
  'skills:inspect-github': {
    args: [sourceUrl: string]
    return: { success: boolean; inspection?: import('./writing-skills').RemoteWritingSkillInspection; error?: string }
  }
  'skills:install-github': {
    args: [sourceUrl: string]
    return: { success: boolean; skill?: import('./writing-skills').InstalledWritingSkill; error?: string }
  }
  'skills:pick-local': {
    args: [kind: import('./writing-skills').LocalWritingSkillSourceKind]
    return: { success: boolean; cancelled?: boolean; inspection?: import('./writing-skills').LocalWritingSkillInspection; error?: string }
  }
  'skills:install-local': {
    args: [candidateId: string]
    return: { success: boolean; skill?: import('./writing-skills').InstalledWritingSkill; error?: string }
  }
  'skills:uninstall-user': {
    args: [name: string]
    return: { success: boolean; error?: string }
  }
}

export interface LLMRequest {
  modelId: string
  modelExecutionLeaseId?: string
  purpose?: string
  creativeStrategy?: CreativeStrategy
  reasoningStage?: GenerationReasoningStage
  projectSession?: ProjectSessionContext
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  maxTokens?: number
  stream?: boolean
  responseFormat?: { type: 'json_object' | 'text' }
}

export type ModelExecutionCapabilityEvidenceSource =
  | 'verified-provider-preset'
  | 'user-operational-cap'
  | 'legacy-profile'
  | 'unknown'

export interface ModelExecutionCapabilityEvidence {
  source: {
    contextWindowTokens: ModelExecutionCapabilityEvidenceSource
    maxOutputTokens: ModelExecutionCapabilityEvidenceSource
    featureFlags: ModelExecutionCapabilityEvidenceSource
  }
  subjectFingerprint: string
  contextWindowTokens: number | null
  maxOutputTokens: number
  reasoning: boolean | null
  structuredOutput: boolean | null
  usage: boolean | null
}

export interface ModelExecutionLeaseReceipt {
  leaseId: string
  modelId: string
  provider: ModelProfile['provider']
  protocol: ModelProfile['protocol']
  modelName: string
  modelRevision: string
  endpointFingerprint: string
  capabilityEvidence: ModelExecutionCapabilityEvidence
  createdAt: number
  expiresAt: number
}

interface LLMResponseBase {
  content: string
  usage?: TokenUsage
  error?: string
  httpFailure?: { status: number; body: string }
}

export type LLMResponse =
  | (LLMResponseBase & { success: true; finishReason: 'stop' })
  | (LLMResponseBase & {
      success: false
      finishReason: Exclude<LLMFinishReason, 'stop'>
    })

export type LLMFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'cancelled'
  | 'error'
  | 'unknown'

export interface TokenUsage {
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
}

export interface ModelProfile {
  id: string
  name: string
  provider: 'openai' | 'gemini' | 'deepseek' | 'ollama' | 'bigmodel' | 'bigmodel-anthropic' | 'novelai' | 'xai' | 'siliconflow' | 'custom'
  protocol: 'openai' | 'gemini' | 'anthropic'
  modelName: string
  apiKey: string
  baseUrl: string
  temperature: number
  capabilities?: ModelCapabilities
  capabilitySources?: Partial<Record<keyof ModelCapabilities, 'endpoint' | 'preset' | 'manual' | 'unknown'>>
  learnedContextWindow?: Pick<ModelProfile, 'provider' | 'protocol' | 'baseUrl' | 'modelName'> & { tokens: number }
  maxTokens: number
  purposes: Array<'generation' | 'refinement' | 'summary' | 'embedding' | 'rerank'>
  reasoningOverride?: ReasoningOverride
  reasoningMapping?: VerifiedReasoningMapping
  embeddingOptions?: EmbeddingOptions
}

export interface ProjectClearOptions {
  creativeFields?: boolean
  blueprints?: boolean
  generatedText?: boolean
}

export type ProjectClearScope = 'creativeFields' | 'blueprints' | 'generatedText'

import type {
  ProjectCoreData,
  ProjectCoreSynopsisCommitRequest,
} from '../../electron/repositories/project-core-repository'
import type {
  BlueprintCharacterSyncOperation,
  BlueprintData,
  BlueprintRangeCommitReceipt,
  BlueprintRangeCommitRequest,
} from '../../electron/repositories/blueprint-repository'
import type {
  CharacterData,
} from '../../electron/repositories/character-repository'
import type { DraftMeta, DraftFull } from '../../electron/repositories/draft-repository'
import type {
  FinalizedDraftExportAuthorityReceipt,
  FinalizedDraftExportSnapshot,
} from '../../electron/repositories/finalization-repository'
import type { RevisionMeta, RevisionFull } from '../../electron/repositories/revision-repository'
import type { ReviewMeta, ReviewFull } from '../../electron/repositories/review-repository'
import type { PostProcessRunData, PostProcessStepData } from '../../electron/repositories/post-process-repository'
import type {
  CharacterRosterCommitReceipt,
  CharacterRosterCommitRequest,
  CharacterRosterSnapshot,
} from './character-roster'
import type {
  FinalizedDraftImportReceipt,
  FinalizedDraftImportRequest,
} from './finalized-draft-import'
import type { AuthorManuscriptImportPreview } from './author-manuscript-import'
import type { AuthoritativeChapterSequence } from './chapter-sequence'
import type {
  ImportGlobalFactsReceipt,
  ImportGlobalFactsRequest,
} from './import-global-facts'

export interface DatabaseChannels {
  'db:close': { args: [expectedProjectPath: string]; return: { success: boolean } }

  'db:project-core-get': {
    args: [expectedProjectPath: string]
    return: ProjectCoreData | null
  }
  'db:project-core-update': {
    args: [data: Partial<ProjectCoreData>, expectedProjectPath: string]
    return: { success: boolean; error?: string }
  }
  'db:project-core-commit-generated': {
    args: [request: { data: Partial<ProjectCoreData>; aiSources?: AiSources; generationRunHandle: import('../services/generation/generation-runtime').MainGenerationRunHandle }, expectedProjectPath: string]
    return: { success: boolean; error?: string }
  }
  'db:project-core-synopsis-commit': {
    args: [request: ProjectCoreSynopsisCommitRequest, expectedProjectPath: string]
    return: { success: boolean; receipt?: import('./plot-outline-contract').PlotOutlineAuthorEditReceipt; error?: string }
  }
  'db:import-global-facts-commit': {
    args: [request: ImportGlobalFactsRequest, expectedProjectPath: string]
    return: { success: boolean; receipt?: ImportGlobalFactsReceipt; error?: string }
  }
  'db:project-clear-generated-data': { args: [options: ProjectClearOptions, expectedProjectPath: string]; return: { success: boolean; cleared?: ProjectClearScope[]; physicalFilesDeleted?: number; error?: string } }
  'db:import-run-prepare-inspection': {
    args: [request: ImportRunPrepareFromInspectionRequest, expectedProjectPath: string]
    return: ImportRunPrepareFromInspectionResult
  }
  'db:import-run-author-preview': {
    args: [inspectionId: string, expectedProjectPath: string]
    return: AuthorManuscriptImportPreview
  }
  'db:import-run-finalize-parsing': {
    args: [runId: string, expectedProjectPath: string]
    return: { success: boolean; preparation?: ImportRunPreparationResult; error?: string }
  }
  'db:import-run-get': { args: [runId: string, expectedProjectPath: string]; return: ImportRunSnapshot | null }
  'db:import-run-list-resumable': { args: [expectedProjectPath: string]; return: ImportRunSnapshot[] }
  'db:import-run-list-chapters': {
    args: [runId: string, afterChapterNumber: number, limit: number, expectedProjectPath: string]
    return: ImportRunChapterSnapshot[]
  }
  'db:import-run-effect-receipt-get': {
    args: [runId: string, stage: ImportRunStage, batchId: string, expectedProjectPath: string]
    return: ImportRunEffectReceipt | null
  }
  'db:import-run-effect-receipt-prepare': {
    args: [request: ImportRunPrepareEffectReceiptRequest, execution: ImportRunExecutionLease, expectedProjectPath: string]
    return: { success: boolean; receipt?: ImportRunEffectReceipt; error?: string }
  }
  'db:import-run-effect-receipt-commit': {
    args: [runId: string, stage: ImportRunStage, batchId: string, execution: ImportRunExecutionLease, expectedProjectPath: string]
    return: { success: boolean; result?: ImportRunEffectCommitResult; error?: string }
  }
  'db:import-run-start-resume': { args: [runId: string, owner: string, expectedProjectPath: string]; return: { success: boolean; start?: ImportRunStartResult; error?: string } }
  'db:import-run-renew-execution': { args: [runId: string, execution: ImportRunExecutionLease, expectedProjectPath: string]; return: { success: boolean; execution?: ImportRunExecutionLease; error?: string } }
  'db:import-run-restart': { args: [runId: string, nextRunId: string, expectedProjectPath: string]; return: { success: boolean; run?: ImportRunSnapshot; error?: string } }
  'db:import-run-request-cancel': { args: [runId: string, execution: ImportRunExecutionLease, expectedProjectPath: string]; return: { success: boolean; run?: ImportRunSnapshot; error?: string } }
  'db:import-run-cancel-at-boundary': { args: [runId: string, execution: ImportRunExecutionLease, expectedProjectPath: string]; return: { success: boolean; run?: ImportRunSnapshot; error?: string } }
  'db:import-run-complete-batch': {
    args: [runId: string, stage: ImportRunStage, batchId: string, execution: ImportRunExecutionLease, expectedProjectPath: string]
    return: { success: boolean; newlyCompleted?: boolean; cancelApplied?: boolean; run?: ImportRunSnapshot; error?: string }
  }
  'db:import-run-advance-stage': {
    args: [runId: string, completedStage: ImportRunStage, nextStage: ImportRunStage, execution: ImportRunExecutionLease, expectedProjectPath: string]
    return: { success: boolean; run?: ImportRunSnapshot; error?: string }
  }
  'db:import-run-fail': {
    args: [runId: string, stage: ImportRunStage, errorMessage: string, execution: ImportRunExecutionLease, expectedProjectPath: string]
    return: { success: boolean; run?: ImportRunSnapshot; error?: string }
  }
  'db:import-run-complete': { args: [runId: string, execution: ImportRunExecutionLease, expectedProjectPath: string]; return: { success: boolean; run?: ImportRunSnapshot; error?: string } }

  'db:blueprint-get-all': { args: [expectedProjectPath: string]; return: BlueprintData[] }
  'db:blueprint-get': { args: [chapterNumber: number, expectedProjectPath: string]; return: BlueprintData | null }
  'db:blueprint-upsert': { args: [data: BlueprintData, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:blueprint-upsert-many': { args: [items: BlueprintData[], expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:blueprint-commit-range': {
    args: [request: BlueprintRangeCommitRequest, expectedProjectPath: string]
    return: { success: boolean; receipt?: BlueprintRangeCommitReceipt; error?: string }
  }
  'db:blueprint-character-sync-list-pending': {
    args: [expectedProjectPath: string]
    return: BlueprintCharacterSyncOperation[]
  }
  'db:blueprint-character-sync-get': {
    args: [operationId: string, expectedProjectPath: string]
    return: BlueprintCharacterSyncOperation | null
  }
  'db:blueprint-character-sync-complete': {
    args: [
      operationId: string,
      expectedProjectPath: string,
    ]
    return: { success: boolean; operation?: BlueprintCharacterSyncOperation; error?: string }
  }
  'db:blueprint-update-notes': { args: [chapterNumber: number, notes: string, expectedProjectPath: string]; return: { success: boolean; updated?: boolean; error?: string } }
  'db:blueprint-delete': { args: [chapterNumber: number, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:blueprint-clear-all': { args: [expectedProjectPath: string]; return: { success: boolean; error?: string } }

  'db:character-get-all': { args: [expectedProjectPath: string]; return: CharacterData[] }
  'db:character-roster-read': {
    args: [expectedProjectPath: string]
    return: CharacterRosterSnapshot
  }
  'db:character-continuity-nodes': { args: [characterIds: string[], expectedProjectPath: string]; return: ContinuityNode[] }
  'db:character-continuity-timeline': { args: [characterId: string, expectedProjectPath: string]; return: CharacterContinuityTimeline }
  'db:character-roster-commit': {
    args: [request: CharacterRosterCommitRequest, expectedProjectPath: string]
    return: { success: boolean; receipt?: CharacterRosterCommitReceipt; error?: string }
  }

  'db:draft-import-finalized-batch': {
    args: [request: FinalizedDraftImportRequest, expectedProjectPath: string]
    return: { success: boolean; receipt?: FinalizedDraftImportReceipt; error?: string }
  }
  'db:draft-create': { args: [params: { chapterNumber: number; version: number; source: 'write' | 'rewrite'; content: string; wordCount: number; sourceDependencies?: DraftSourceDependency[] }, expectedProjectPath: string]; return: { success: boolean; id?: number; error?: string } }
  'db:draft-list': { args: [chapterNumber: number, expectedProjectPath: string]; return: DraftMeta[] }
  'db:draft-list-all': { args: [expectedProjectPath: string]; return: DraftMeta[] }
  'db:draft-get-meta': { args: [id: number, expectedProjectPath: string]; return: DraftMeta | null }
  'db:draft-get-full': { args: [id: number, expectedProjectPath: string]; return: DraftFull | null }
  'db:draft-get-latest': { args: [chapterNumber: number, expectedProjectPath: string]; return: DraftMeta | null }
  'db:draft-get-finalized': { args: [chapterNumber: number, expectedProjectPath: string]; return: DraftMeta | null }
  'db:draft-get-max-finalized-chapter': { args: [expectedProjectPath: string]; return: number }
  'db:draft-authority-sequence': { args: [expectedProjectPath: string]; return: AuthoritativeChapterSequence }
  'db:draft-export-snapshot': { args: [expectedProjectPath: string]; return: FinalizedDraftExportSnapshot[] }
  'db:draft-export-authority-current': {
    args: [receipt: FinalizedDraftExportAuthorityReceipt, expectedProjectPath: string]
    return: boolean
  }
  'db:continuity-save-finalized': {
    args: [request: SaveFinalizedContinuityRequest, expectedProjectPath: string]
    return: { success: boolean; error?: string }
  }
  'db:continuity-save-character-state-candidates': {
    args: [request: SaveFinalizedCharacterStateCandidatesRequest, expectedProjectPath: string]
    return: { success: boolean; error?: string }
  }
  'db:continuity-list-before': {
    args: [chapterNumber: number, expectedProjectPath: string]
    return: FinalizedContinuityProjection[]
  }
  'db:continuity-read-source': {
    args: [draftId: number, expectedProjectPath: string]
    return: FinalizedSourceReadResult
  }
  'db:consistency-exemption-list': { args: [expectedProjectPath: string]; return: ConsistencyExemption[] }
  'db:blueprint-relationship-hints': { args: [blueprints: BlueprintForPreflight[], expectedProjectPath: string]; return: Record<number, unknown> }
  'db:character-continuity-preflight-nodes': { args: [expectedProjectPath: string]; return: ContinuityNode[] }
  'db:consistency-exemption-save': {
    args: [stableFactKey: string, reason: string, chapterNumber: number | null, expectedProjectPath: string]
    return: { success: boolean; error?: string }
  }
  'db:consistency-exemption-revoke': {
    args: [stableFactKey: string, chapterNumber: number | null, expectedProjectPath: string]
    return: { success: boolean; error?: string }
  }
  'db:narrative-thread-list': {
    args: [expectedProjectPath: string]
    return: NarrativeThreadView[]
  }
  'db:narrative-thread-list-relevant': {
    args: [context: NarrativeThreadChapterContext, expectedProjectPath: string]
    return: NarrativeThreadView[]
  }
  'db:narrative-thread-review-candidates': {
    args: [expectedProjectPath: string]
    return: NarrativeThreadReviewCandidate[]
  }
  'db:narrative-thread-plan-create': {
    args: [input: NarrativeThreadPlanInput, expectedProjectPath: string]
    return: { success: boolean; plan?: NarrativeThreadPlanRecord; failure?: Failure }
  }
  'db:narrative-thread-plan-update': {
    args: [id: number, input: NarrativeThreadPlanInput, expectedProjectPath: string]
    return: { success: boolean; plan?: NarrativeThreadPlanRecord; failure?: Failure }
  }
  'db:narrative-thread-plan-delete': {
    args: [id: number, expectedProjectPath: string]
    return: { success: boolean; failure?: Failure }
  }
  'db:narrative-thread-event-confirm': {
    args: [input: NarrativeThreadEventInput, expectedProjectPath: string]
    return: { success: boolean; event?: NarrativeThreadEvent; failure?: Failure }
  }
  'db:narrative-thread-assignment-set': {
    args: [input: NarrativeThreadAssignmentInput, expectedProjectPath: string]
    return: { success: boolean; threads?: NarrativeThreadView[]; failure?: Failure }
  }
  'db:narrative-thread-assignment-remove': {
    args: [planId: number, chapterNumber: number, restoreEndChapter: number | null, expectedProjectPath: string]
    return: { success: boolean; threads?: NarrativeThreadView[]; failure?: Failure }
  }
  'db:plot-tree-read': {
    args: [expectedProjectPath: string]
    return: PlotTreeSourceBundle
  }
  'db:plot-tree-clear': {
    args: [expectedProjectPath: string]
    return: { success: boolean; failure?: Failure }
  }
  'db:draft-next-version': { args: [chapterNumber: number, expectedProjectPath: string]; return: number }
  'db:draft-update-status': { args: [id: number, status: string, wordCount: number | undefined, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:annotation-history-list': { args: [draftId: number, expectedProjectPath: string]; return: { id: number; version: number; before: string; after: string; annotations: import('./editor-inline-generation').EditorInlineAnnotation[]; createdAt: string }[] }
  'db:annotation-commit': { args: [input: { draftId: number; expectedSaved: string; before: string; after: string; annotations: import('./editor-inline-generation').EditorInlineAnnotation[] }, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:draft-update-content': { args: [id: number, content: string, wordCount: number, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:draft-delete': {
    args: [id: number, expectedProjectPath: string]
    return: {
      success: boolean
      errorCode?: 'FINALIZED_DRAFT_DELETE_REQUIRED'
      error?: string
    }
  }
  'db:recovery-candidate-record': {
    args: [request: RecoveryCandidateRecordInput, expectedProjectPath: string]
    return: { success: boolean; candidate?: RecoveryCandidate; failure?: Failure }
  }
  'db:recovery-candidate-list': {
    args: [expectedProjectPath: string]
    return: RecoveryCandidate[]
  }
  'db:recovery-candidate-update': {
    args: [candidateId: string, visibleText: string, expectedProjectPath: string]
    return: { success: boolean; candidate?: RecoveryCandidate; failure?: Failure }
  }
  'db:recovery-candidate-resolve': {
    args: [candidateId: string, status: 'continued' | 'discarded', expectedProjectPath: string]
    return: { success: boolean; failure?: Failure }
  }
  'db:finalization-link-knowledge-document': {
    args: [draftId: number, documentId: string, expectedProjectPath: string]
    return: { success: boolean; finalization?: { knowledgeDocumentId: string }; error?: string }
  }

  'db:revision-create': { args: [params: { baseDraftId: number; revisionType: 'refine' | 'review-fix'; userPrompt?: string; reviewSourceId?: number; content: string; wordCount: number; expectedSource?: ExpectedDraftSource }, expectedProjectPath: string]; return: { success: boolean; id?: number; revisionIndex?: number; errorCode?: SourceDraftGuardErrorCode; error?: string } }
  'db:revision-replace-pending': { args: [params: { baseDraftId: number; revisionType: 'refine' | 'review-fix'; userPrompt?: string; reviewSourceId?: number; content: string; wordCount: number; expectedSource?: ExpectedDraftSource }, expectedProjectPath: string]; return: { success: boolean; id?: number; revisionIndex?: number; errorCode?: SourceDraftGuardErrorCode; error?: string } }
  'db:revision-list': { args: [baseDraftId: number, expectedProjectPath: string]; return: RevisionMeta[] }
  'db:revision-get-pending': { args: [baseDraftId: number, expectedProjectPath: string]; return: RevisionMeta[] }
  'db:revision-get-full': { args: [id: number, expectedProjectPath: string]; return: RevisionFull | null }
  'db:revision-next-index': { args: [baseDraftId: number, expectedProjectPath: string]; return: number }
  'db:revision-merge': {
    args: [request: {
      revisionId: number
      targetDraftId: number
      expectedDraftContent: string
      mergedContent: string
      wordCount: number
    }, expectedProjectPath: string]
    return: {
      success: boolean
      receipt?: {
        revisionId: number
        targetDraftId: number
        status: 'revised'
        wordCount: number
        idempotent: boolean
        chapterNumber: number
        version: number
        reviewCycle?: {
          cycleId: string
          mergedHash: string
          disposition: 'required' | 'not-required' | 'completed'
        }
      }
      error?: string
    }
  }
  'db:revision-mark-merged': { args: [id: number, mergedToDraftId: number, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:revision-mark-discarded': { args: [id: number, expectedProjectPath: string]; return: { success: boolean; error?: string } }

  'db:review-create': { args: [params: { baseDraftId: number; reviewIndex?: number; content: string; expectedSource?: ExpectedDraftSource; reviewCycleId?: string }, expectedProjectPath: string]; return: { success: boolean; id?: number; reviewIndex?: number; errorCode?: SourceDraftGuardErrorCode; error?: string } }
  'db:review-list': { args: [baseDraftId: number, expectedProjectPath: string]; return: ReviewMeta[] }
  'db:review-get-latest': { args: [baseDraftId: number, expectedProjectPath: string]; return: ReviewFull | null }
  'db:review-get-full': { args: [id: number, expectedProjectPath: string]; return: ReviewFull | null }
  'db:review-cycle-get': { args: [reviewId: number, expectedProjectPath: string]; return: ReviewCycleProjection | null }
  'db:review-next-index': { args: [baseDraftId: number, expectedProjectPath: string]; return: number }

  'db:post-process-create-run': { args: [params: { finalizedSource?: import('./finalized-continuity').FinalizedSourceIdentity; triggerSourceType: string; triggerSourceId: string; sourceLabel: string; steps: Array<{ key: string; label: string; critical: boolean }> }, expectedProjectPath: string]; return: { success: boolean; id?: string; error?: string } }
  'db:post-process-get-latest-run': { args: [sourceType: string, sourceId: string, expectedProjectPath: string]; return: PostProcessRunData | null }
  'db:post-process-get-steps': { args: [runId: string, expectedProjectPath: string]; return: PostProcessStepData[] }
  'db:post-process-mark-step-ok': { args: [runId: string, stepKey: string, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:post-process-mark-step-failed': { args: [runId: string, stepKey: string, errorMsg: string, expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'db:post-process-is-all-passed': { args: [sourceType: string, sourceId: string, expectedProjectPath: string]; return: boolean }

  'db:log-llm-call': { args: [call: Record<string, unknown>, expectedProjectPath: string]; return: { success: boolean; failure?: Failure } }
  'db:get-llm-stats': {
    args: [expectedProjectPath: string]
    return: {
      totalCalls: number
      successfulCalls: number
      failedCalls: number
      knownUsageCalls: number
      totalTokens: number | null
      totalPromptTokens: number | null
      totalCompletionTokens: number | null
    }
  }
  'db:get-llm-history': { args: [limit: number | undefined, expectedProjectPath: string]; return: unknown[] }
}

export interface KnowledgeBaseChannels {
  'kb:import-text': { args: [text: string, fileName: string, expectedProjectPath: string]; return: { success: boolean; docId?: string; chunkCount?: number; error?: string; errorCode?: AppErrorCode; failure?: Failure } }
  'kb:import-planning-text': { args: [text: string, fileName: string, expectedProjectPath: string]; return: { success: boolean; docId?: string; chunkCount?: number; error?: string; errorCode?: AppErrorCode; failure?: Failure } }
  'kb:import-reference-text': {
    args: [
      chapterNumber: number,
      runId: string,
      executionAuthority: ImportRunExecutionAuthority,
    ]
    return: { success: boolean; docId?: string; chunkCount?: number; idempotent?: boolean; error?: string; errorCode?: AppErrorCode; failure?: Failure }
  }
  'kb:search': { args: [query: string, topK: number | undefined, expectedProjectPath: string]; return: AppResult<KnowledgeSearchHit[]> }
  'kb:search-writing-context': { args: [query: string, topK: number | undefined, expectedProjectPath: string]; return: AppResult<Array<{ text: string; score: number; fileName: string }>> }
  'kb:list-documents': { args: [expectedProjectPath: string]; return: AppResult<Array<{ id: string; fileName: string; importedAt: string; chunkCount: number; filePath: string; finalizedChapter?: number }>> }
  'kb:read-document-copy': {
    args: [docId: string, expectedProjectPath: string]
    return: AppResult<{ available: boolean; content?: string; contentHash?: string; edited?: boolean; indexStatus: 'current' | 'stale' | 'unavailable' }>
  }
  'kb:save-document-copy': {
    args: [docId: string, content: string, expectedContentHash: string, expectedProjectPath: string]
    return: AppResult<{ success: boolean; error?: string }>
  }
  'kb:reindex-document-copy': {
    args: [docId: string, expectedProjectPath: string]
    return: AppResult<{ success: boolean; docId?: string; chunkCount?: number; error?: string }>
  }
  'kb:clear-all': { args: [expectedProjectPath: string]; return: { success: boolean; error?: string } }
  'kb:stats': { args: [expectedProjectPath: string]; return: AppResult<{ documentCount: number; totalChunks: number; vectorDimension: number }> }
  'dialog:select-knowledge-files': { args: []; return: ExternalFileGrant[] | null }
  'kb:get-vectorless-count': { args: [expectedProjectPath: string]; return: AppResult<{ count: number }> }
  'kb:get-vector-rebuild-status': {
    args: [expectedProjectPath: string]
    return: AppResult<{
      embeddingConfigured: boolean
      canRebuild: boolean
      totalChunks: number
      vectorlessCount: number
      activeVectorDimension: number
    }>
  }
  'kb:backfill-vectors': { args: [expectedProjectPath: string]; return: { success: boolean; processed: number; failed: number; error?: string; errorCode?: AppErrorCode; failure?: Failure } }
}

export interface ImportChannels {
  'dialog:select-novel-files': {
    args: [request?: ImportPurpose | ImportNovelFileSelectionRequest, projectSession?: ProjectSessionContext]
    return: {
      success: boolean
      inspection?: ImportInspectionSummary
      preparation?: ImportRunPreparationResult
      error?: string
    } | null
  }
}

export interface ChapterLifecycleChannels {
  'chapter:delete-finalized': {
    args: [request: DeleteFinalizedChapterRequest, expectedProjectPath: string]
    return: ChapterDeletionResult
  }
  'chapter:retry-deletion': {
    args: [operationId: string, expectedProjectPath: string]
    return: ChapterDeletionResult
  }
  'chapter:confirm-legacy-knowledge-absent': {
    args: [operationId: string, expectedProjectPath: string]
    return: ChapterDeletionResult
  }
  'chapter:list-incomplete-deletions': {
    args: [expectedProjectPath: string]
    return: { success: boolean; operations?: ChapterDeletionOperation[]; error?: string }
  }
  'chapter:trash-list': {
    args: [expectedProjectPath: string]
    return: ChapterTrashListResult
  }
  'chapter:trash-restore': {
    args: [request: RestoreTrashedChapterRequest, expectedProjectPath: string]
    return: RestoreTrashedChapterResult
  }
  'chapter:trash-purge': {
    args: [request: PurgeTrashRequest, expectedProjectPath: string]
    return: PurgeTrashResult
  }
  'chapter:reopen': {
    args: [request: ReopenChapterRequest, expectedProjectPath: string]
    return: ReopenChapterResult
  }
  'chapter:remove-replaced-knowledge': {
    args: [draftId: number, expectedProjectPath: string]
    return: { success: boolean; error?: string }
  }
  'chapter:remove-replaced-manuscripts': {
    args: [draftId: number, expectedProjectPath: string]
    return: { success: boolean; error?: string }
  }
  'chapter:replacement-impacts': {
    args: [expectedProjectPath: string]
    return: { success: true; impacts: ReplacementImpact[] } | { success: false; error: string }
  }
  'chapter:replacement-impact-preview': {
    args: [draftId: number, content: string, expectedProjectPath: string]
    return: { success: true; impact: ReplacementImpact | null } | { success: false; error: string }
  }
}

export type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface MCPServerSummary {
  id: string
  name: string
  transport: 'stdio' | 'sse'
}

export interface MCPServerStatus {
  id: string
  name: string
  status: MCPConnectionStatus
  toolCount: number
  error?: string
}

export interface MCPToolDescription {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  serverId: string
}

export interface MCPResourceDescription {
  uri: string
  name: string
  description?: string
  mimeType?: string
  serverId: string
}

export type MCPConfigLoadResult =
  | { status: 'missing'; servers: [] }
  | { status: 'loaded'; servers: MCPServerSummary[] }
  | { status: 'error'; servers: []; error: string }

export type MCPConfigLoadResponse =
  | ({ status: 'missing'; servers: [] } & { success: true })
  | ({ status: 'loaded'; servers: MCPServerSummary[] } & { success: true })
  | ({ status: 'error'; servers: []; error: string } & { success: false })

export interface MCPChannels {
  'mcp:load-config': { args: []; return: MCPConfigLoadResponse }
  'mcp:connect': { args: [serverId: string]; return: { success: boolean; error?: string } }
  'mcp:disconnect': { args: [serverId: string]; return: { success: boolean; error?: string } }
  'mcp:disconnect-all': { args: []; return: { success: boolean; error?: string } }
  'mcp:list-tools': { args: []; return: MCPToolDescription[] }
  'mcp:list-resources': { args: []; return: MCPResourceDescription[] }
  'mcp:call-tool': { args: [serverId: string, toolName: string, args: Record<string, unknown>]; return: { success: boolean; content: string; error?: string } }
  'mcp:get-servers-status': { args: []; return: MCPServerStatus[] }
  'mcp:get-config-path': { args: []; return: string }
}

export type AllInvokeChannels = LegacyRosterGenerationChannels & CharacterAvatarChannels & CloudBackupChannels & GraphGenerationChannels & FinalizationGenerationChannels & EditorInlineGenerationChannels & ImportGenerationChannels & AgentGenerationChannels & ReviewRevisionGenerationInvokeChannels & FinalizedCharacterGenerationChannels & CharacterProposalChannels & GenerationOwnerChannels & StartupChannels & WindowChannels & OfficialHomepageChannels & ModelProviderResourceChannels & ConfigChannels & UpdateChannels & ProjectChannels & FileChannels & AppDataChannels & LLMChannels & DatabaseChannels & KnowledgeBaseChannels & ChapterLifecycleChannels & ImportChannels & MCPChannels
export type AllEventChannels = GenerationOwnerEvents & UpdateStateEvents & WindowEvents & PortableExportEvents

export type InvokeChannel = keyof AllInvokeChannels

export type EventChannel = keyof AllEventChannels
