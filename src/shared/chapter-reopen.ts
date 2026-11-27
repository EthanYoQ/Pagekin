import type { DraftSourceDependency } from './draft-source-dependency'
import type { Failure } from './failure'
import { WORKING_DRAFT_STATUSES, type DraftStatus } from './draft-status'

export type ReopenedFinal = Extract<DraftSourceDependency, { chapterNumber: number }>

export interface ReopenChapterRequest {
  chapterNumber: number
  initialDraftId?: number
}

export type ReopenChapterResult =
  | { success: true; created: boolean; draftId: number; version: number }
  | { success: false; failure?: Failure }

export interface ReplacementImpact {
  chapterNumber: number
  finalizationId: string | null
  laterChapters: number[]
  blueprintOnlyChapters: number[]
  characters: string[]
  unmovedConfirmations: Array<{ threadTitle: string; evidence: string }>
}

export function reopenedFinal(draft: {
  chapterNumber: number
  sourceDependencies?: readonly DraftSourceDependency[]
}): ReopenedFinal | null {
  for (const dependency of draft.sourceDependencies ?? []) {
    if ('chapterNumber' in dependency && dependency.chapterNumber === draft.chapterNumber) return dependency
  }
  return null
}

export function isOpenReopenDraft(draft: {
  chapterNumber: number
  status: DraftStatus
  sourceDependencies?: readonly DraftSourceDependency[]
  dependenciesStale?: boolean
}): boolean {
  return (WORKING_DRAFT_STATUSES as readonly DraftStatus[]).includes(draft.status)
    && reopenedFinal(draft) !== null
    && draft.dependenciesStale === false
}
