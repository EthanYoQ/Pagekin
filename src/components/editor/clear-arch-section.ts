import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { writeCoreContent } from '../../services/resource-protocol'
import { useEditorStore } from '../../stores/editor-store'
import { isProjectSessionCurrent } from '../project-session-gate'
import { createProjectArchTabId } from './arch-file-refresh-policy'

export async function clearArchSection(filePath: string, projectSession: ProjectSessionContext): Promise<boolean> {
  const success = await writeCoreContent(filePath, '', projectSession)
  if (!success || !isProjectSessionCurrent(projectSession)) return success
  const store = useEditorStore.getState()
  const tabId = createProjectArchTabId(projectSession.projectPath, filePath)
  store.syncTabContent(tabId, '')
  store.markTabSaved(tabId, '')
  return true
}
