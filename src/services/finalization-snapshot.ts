import type { ProjectSessionContext } from '../shared/ipc-channels'
import {
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import type { EditorTab } from '../stores/editor-store'
import { useLocaleStore } from '../stores/locale-store'

export type FinalizationPublicationStatus = 'pending' | 'published'

export interface FinalizationSnapshot {
  tabId: string
  projectPath: string
  projectSession: ProjectSessionContext
  draftId: number
  chapterNumber: number
  chapterTitle: string
  content: string
  contentRevision: number
}

export interface FinalizationCompletion {
  finalizationId: string
  contentHash: string
  contentRevision: number
  draftId: number
  projectPath: string
  projectSession: ProjectSessionContext
  publicationStatus: FinalizationPublicationStatus
}

export function finalizationContentRevision(editorRevision: number | undefined): number {
  return (editorRevision ?? 0) + 1
}

export function captureFinalizationSnapshot(input: {
  tab: EditorTab
  projectSession: ProjectSessionContext
  chapterTitle: string
}): FinalizationSnapshot {
  const { tab, projectSession, chapterTitle } = input
  if (!tab.projectKey || !sameProjectPathKey(tab.projectKey, projectSession.projectPath)) {
    throw new Error(useLocaleStore.getState().text('定稿目标不属于当前项目会话', 'This chapter does not belong to the open book session.'))
  }
  if (!Number.isInteger(tab.draftId) || tab.draftId === undefined) {
    throw new Error(useLocaleStore.getState().text('定稿目标缺少草稿身份', 'This chapter tab is not linked to a saved draft.'))
  }
  if (!Number.isInteger(tab.chapterNumber) || tab.chapterNumber === undefined) {
    throw new Error(useLocaleStore.getState().text('定稿目标缺少章节身份', 'This chapter tab has no chapter number.'))
  }

  const frozenSession = Object.freeze({ ...projectSession })
  return Object.freeze({
    tabId: tab.id,
    projectPath: tab.projectKey,
    projectSession: frozenSession,
    draftId: tab.draftId,
    chapterNumber: tab.chapterNumber,
    chapterTitle,
    content: tab.content ?? '',
    contentRevision: finalizationContentRevision(tab.contentRevision),
  })
}

export function reconcileFinalizationCompletion(
  tab: EditorTab,
  snapshot: FinalizationSnapshot,
  completion: FinalizationCompletion,
): EditorTab {
  const sameTarget = (
    tab.id === snapshot.tabId
    && tab.draftId === snapshot.draftId
    && tab.projectSessionLease === snapshot.projectSession.leaseId
    && sameProjectPathKey(tab.projectKey, snapshot.projectPath)
    && sameProjectSessionContext(snapshot.projectSession, completion.projectSession)
    && sameProjectPathKey(completion.projectPath, snapshot.projectPath)
    && completion.draftId === snapshot.draftId
    && completion.contentRevision === snapshot.contentRevision
  )
  const replacedFinal = !sameTarget
    && tab.draftStatus === 'finalized'
    && tab.draftId !== snapshot.draftId
    && tab.chapterNumber === snapshot.chapterNumber
    && tab.projectSessionLease === snapshot.projectSession.leaseId
    && sameProjectPathKey(tab.projectKey, snapshot.projectPath)
  if (replacedFinal) return { ...tab, draftStatus: 'superseded' }
  if (!sameTarget) return tab

  const snapshotStillCurrent = (
    finalizationContentRevision(tab.contentRevision) === snapshot.contentRevision
    && (tab.content ?? '') === snapshot.content
  )
  if (!snapshotStillCurrent) {
    return {
      ...tab,
      dirty: true,
      finalizationId: completion.finalizationId,
      finalizationPublication: completion.publicationStatus,
      finalizationConflict: {
        finalizationId: completion.finalizationId,
        publicationStatus: completion.publicationStatus,
      },
    }
  }

  return {
    ...tab,
    savedContent: snapshot.content,
    dirty: false,
    draftStatus: 'finalized',
    finalizationId: completion.finalizationId,
    finalizationPublication: completion.publicationStatus,
    finalizationConflict: undefined,
  }
}
