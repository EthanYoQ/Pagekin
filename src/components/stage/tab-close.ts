import { discardAndCloseEditorTab } from '../../stores/editor-discard'
import { useEditorStore } from '../../stores/editor-store'
import { useStageStore } from '../../stores/navigation/stage-store'
import { useProjectStore } from '../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../project-session-gate'

export const STAGE_CONTENT_ID = 'stage-content'

function focusContent(): void {
  requestAnimationFrame(() => {
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    document.getElementById(STAGE_CONTENT_ID)?.focus({ preventScroll: true })
  })
}

export function requestCloseTab(tabId: string): void {
  const tab = useEditorStore.getState().tabs.find(candidate => candidate.id === tabId)
  if (!tab || tab.pinned) return
  if (tab.dirty) {
    useStageStore.setState({ closingTabId: tabId })
    return
  }
  useEditorStore.getState().closeTab(tabId)
  focusContent()
}

export function confirmCloseTab(): void {
  const { closingTabId } = useStageStore.getState()
  const session = captureProjectSession(useProjectStore.getState().currentProject)
  if (closingTabId && session && isProjectSessionCurrent(session)) discardAndCloseEditorTab(closingTabId, session)
  useStageStore.setState({ closingTabId: null })
  focusContent()
}

export function cancelCloseTab(): void {
  useStageStore.setState({ closingTabId: null })
}

export function closeCleanTabs(tabIds: readonly string[]): string[] {
  const editor = useEditorStore.getState()
  const dirty: string[] = []
  for (const tabId of tabIds) {
    const tab = editor.tabs.find(candidate => candidate.id === tabId)
    if (!tab || tab.pinned) continue
    if (tab.dirty) dirty.push(tabId)
    else useEditorStore.getState().closeTab(tabId)
  }
  if (dirty.length < tabIds.length) focusContent()
  return dirty
}

export function discardAndCloseTabs(tabIds: readonly string[]): void {
  const session = captureProjectSession(useProjectStore.getState().currentProject)
  if (!session || !isProjectSessionCurrent(session)) return
  for (const tabId of tabIds) discardAndCloseEditorTab(tabId, session)
  focusContent()
}
