import type { Failure } from './failure'

export type ChapterDeletionProjectionStatus = 'pending' | 'completed' | 'failed' | 'not_required'
export type ChapterDeletionStatus = 'authorization_required' | 'pending' | 'failed' | 'completed'
export type LegacyKnowledgeAuthorization = 'not_required' | 'required' | 'consumed'

export interface DeleteFinalizedChapterRequest {
  draftId: number
  chapterNumber: number
}

export interface ChapterDeletionOperation {
  operationId: string
  draftId: number
  chapterNumber: number
  chapterTitle: string
  finalizationId: string
  targetFileName: string
  knowledgeDocumentId: string
  postProcessRunIds: string[]
  manuscriptStatus: ChapterDeletionProjectionStatus
  manuscriptError: string
  knowledgeStatus: ChapterDeletionProjectionStatus
  knowledgeError: string
  legacyKnowledgeAuthorization: LegacyKnowledgeAuthorization
  legacyKnowledgeAuthorizedAt: string
  status: ChapterDeletionStatus
  attemptCount: number
  createdAt: string
  updatedAt: string
  completedAt: string
}

export interface ChapterDeletionResult {
  success: boolean
  committed: boolean
  operation?: ChapterDeletionOperation
  failure?: Failure
}

export const CHAPTER_RESTORE_MODES = Object.freeze(['into-gap', 'as-history', 'reopen-as-draft'] as const)
export type ChapterRestoreMode = typeof CHAPTER_RESTORE_MODES[number]

export interface TrashedChapter {
  deletionId: string
  draftId: number
  chapterNumber: number
  chapterTitle: string
  deletedAt: string
  wordCount: number
  versionCount: number
  cleanup: ChapterDeletionStatus
  restoreMode: ChapterRestoreMode
}

export interface DamagedTrashEntry {
  deletionId: string
  error: string
}

export type ChapterTrashListResult =
  | { success: true; entries: TrashedChapter[]; damaged: DamagedTrashEntry[] }
  | { success: false; failure?: Failure }

export interface RestoreTrashedChapterRequest {
  deletionId: string
  draftId: number
  expectedMode: ChapterRestoreMode
}

export type RestoreTrashedChapterResult =
  | { success: true; outcome: 'restored'; chapterNumber: number; draftId: number; finalizationId: string
      publicationStatus: 'pending' | 'published'; publicationError?: string }
  | { success: true; outcome: 'restored-as-history'; chapterNumber: number; draftId: number }
  | { success: true; outcome: 'reopened-as-draft'; chapterNumber: number; draftId: number; created: boolean }
  | { success: true; outcome: 'already-restored'; chapterNumber: number; draftId: number }
  | { success: false; failure?: Failure; operation?: ChapterDeletionOperation }

export type PurgeTrashRequest = { deletionIds: string[] } | { all: true }

export type PurgeTrashResult =
  | { success: true; purged: string[]; alreadyGone: string[] }
  | { success: false; failure?: Failure }
