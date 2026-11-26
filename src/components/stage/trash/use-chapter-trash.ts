import { useCallback, useEffect, useRef, useState } from 'react'
import type { DamagedTrashEntry, TrashedChapter } from '../../../shared/chapter-deletion'
import { globalEventBus } from '../../../shared/event-bus'
import { LatestRequestGate } from '../../../shared/latest-request-gate'
import { sameProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { ipc } from '../../../services/ipc-client'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'

export interface ChapterTrash {
  entries: readonly TrashedChapter[]
  damaged: readonly DamagedTrashEntry[]
  byChapter: ReadonlyMap<number, TrashedChapter>
  stale: boolean
}

export function announceTrashChanged(projectSession: ProjectSessionContext): void {
  globalEventBus.emit('CHAPTER_DELETION_UPDATED', { projectPath: projectSession.projectPath, projectSession })
}

export function useChapterTrash(): ChapterTrash | null {
  const currentProject = useProjectStore(s => s.currentProject)
  const [state, setState] = useState<{ session: ProjectSessionContext | null; trash: ChapterTrash | null }>({ session: null, trash: null })
  const trashReads = useRef(new LatestRequestGate())

  const load = useCallback(async (session: ProjectSessionContext) => {
    const request = trashReads.current.begin()
    let trash: ChapterTrash | null = null
    try {
      const result = await ipc.invokeWithProjectSession(session, 'chapter:trash-list', session.projectPath)
      if (result.success) {
        const byChapter = new Map<number, TrashedChapter>()
        for (const entry of result.entries) if (!byChapter.has(entry.chapterNumber)) byChapter.set(entry.chapterNumber, entry)
        trash = { entries: result.entries, damaged: result.damaged, byChapter, stale: false }
      }
    } catch {
      // 回收站读不到不影响写作，下次删除、恢复或重新打开作品时再读。
    }
    if (!trashReads.current.isLatest(request) || !isProjectSessionCurrent(session)) return
    setState(previous => ({
      session,
      trash: trash ?? (sameProjectSessionContext(previous.session, session) && previous.trash ? { ...previous.trash, stale: true } : null),
    }))
  }, [])

  useEffect(() => {
    const session = captureProjectSession(currentProject)
    if (session) void load(session)
  }, [currentProject, load])

  useEffect(() => globalEventBus.on('CHAPTER_DELETION_UPDATED', ({ projectSession }) => {
    if (isProjectSessionCurrent(projectSession)) void load(projectSession)
  }), [load])

  const session = captureProjectSession(currentProject)
  const current = session && sameProjectSessionContext(state.session, session)
  return current ? state.trash : null
}
