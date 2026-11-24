import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { LatestRequestGate } from '../../shared/latest-request-gate'
import { sameProjectSessionContext } from '../../shared/project-session-context'

export interface ArchFileSnapshot {
  savedContent: string
  currentContent: string
}

/** 最后一次 reload 才算数；编辑、保存调用 invalidate() 作废在途 reload。 */
export class ArchReloadGate {
  private readonly reloads = new LatestRequestGate()

  begin(): number {
    return this.reloads.begin()
  }

  invalidate(): void {
    this.reloads.begin()
  }

  isCurrent(token: number): boolean {
    return this.reloads.isLatest(token)
  }
}

export function createProjectArchTabId(projectKey: string, filePath: string): string {
  return `arch:${encodeURIComponent(projectKey)}:${filePath}`
}

export function isArchProjectCurrent(
  projectKey: string,
  currentProjectKey: string | undefined,
): boolean {
  return currentProjectKey === projectKey
}

export function shouldSyncProjectArchTab(
  tab: { projectKey?: string; dirty?: boolean },
  projectKey: string,
): boolean {
  return tab.projectKey === projectKey && !tab.dirty
}

export function shouldRefreshArchOnWorkflowComplete(
  payload: {
    type: string
    projectPath: string
    projectSession: ProjectSessionContext
    runId: string
  },
  projectSession: ProjectSessionContext,
  lastHandledRunId?: string | null,
): boolean {
  return payload.type === 'architecture_generation'
    && sameProjectSessionContext(
      payload.projectSession,
      projectSession,
    )
    && payload.runId.length > 0
    && payload.runId !== lastHandledRunId
}

export type ArchExternalRefreshDecision =
  | { kind: 'noop' }
  | { kind: 'blocked' }
  | { kind: 'apply'; content: string }

export const ARCH_REFRESH_BLOCKED_MESSAGE =
  '当前架构文档有未保存修改，已跳过刷新并保留本地内容。请先保存后再刷新。'
export const ARCH_PROJECT_MISMATCH_MESSAGE =
  '当前架构文档属于另一个项目。已阻止保存和刷新；切回原项目后可继续处理未保存内容。'

export type ArchEditStoreAction = 'update-dirty' | 'sync-saved'

export interface ArchEditorTabWriter {
  updateTabContent(filePath: string, content: string): void
  syncTabContent(filePath: string, content: string): void
  markTabSaved(filePath: string, savedContent?: string): void
}

export function hasUnsavedArchEdit(snapshot: ArchFileSnapshot): boolean {
  return snapshot.currentContent !== snapshot.savedContent
}

export function archEditStoreAction(snapshot: ArchFileSnapshot): ArchEditStoreAction {
  return hasUnsavedArchEdit(snapshot) ? 'update-dirty' : 'sync-saved'
}

export function writeArchEditState(
  writer: ArchEditorTabWriter,
  filePath: string,
  content: string,
  action: ArchEditStoreAction,
): void {
  if (action === 'update-dirty') {
    writer.updateTabContent(filePath, content)
    return
  }
  writer.syncTabContent(filePath, content)
  writer.markTabSaved(filePath)
}

export function reassertBlockedArchEdit(
  writer: ArchEditorTabWriter,
  filePath: string,
  currentContent: string,
): void {
  writer.updateTabContent(filePath, currentContent)
}

export function didArchSaveSettle(
  writtenContent: string,
  currentContent: string,
): boolean {
  return currentContent === writtenContent
}

export function decideArchExternalRefresh(
  snapshot: ArchFileSnapshot,
  incomingContent: string,
): ArchExternalRefreshDecision {
  if (
    incomingContent === snapshot.savedContent
    || incomingContent === snapshot.currentContent
  ) {
    return { kind: 'noop' }
  }

  if (hasUnsavedArchEdit(snapshot)) {
    return { kind: 'blocked' }
  }

  return { kind: 'apply', content: incomingContent }
}
