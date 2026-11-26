import type { ProjectSessionContext } from '../shared/ipc-channels'
import { getActiveProjectSessionContext, sameProjectSessionContext } from '../shared/project-session-context'
import { readDraftBody, type DraftMeta } from './draft-store'
import { useEditorStore } from './editor-store'

export async function openDraftTab(
  draft: DraftMeta,
  name: string,
  session: ProjectSessionContext,
  stillWanted: () => boolean = () => true,
): Promise<boolean> {
  const content = await readDraftBody(draft.filePath, session.projectPath, session)
  if (!stillWanted() || !sameProjectSessionContext(session, getActiveProjectSessionContext())) return false
  useEditorStore.getState().openFile({
    id: draft.filePath,
    name,
    type: 'chapter',
    filePath: draft.filePath,
    content,
    savedContent: content,
    draftId: draft.id,
    chapterNumber: draft.chapterNumber,
    draftStatus: draft.status,
    projectKey: session.projectPath,
    projectSessionLease: session.leaseId,
  })
  return true
}
