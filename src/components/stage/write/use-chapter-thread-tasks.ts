import { useEffect, useRef, useState } from 'react'
import { ipc } from '../../../services/ipc-client'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { chapterThreadPanel, type NarrativeThreadAssignmentInput, type NarrativeThreadView } from '../../../shared/narrative-thread'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'

type ThreadsResult = { success: boolean; threads?: NarrativeThreadView[]; error?: string }

/** 写前弹层的线索：挂载时就读，主按钮旁的小字才有数。读不出来只是不显示，不挡开写。 */
export function useChapterThreadTasks(chapterNumber: number, open: boolean) {
  const text = useLocaleStore(s => s.text)
  const projectId = useProjectStore(s => s.currentProject?.id)
  const [loaded, setLoaded] = useState<{ projectId: string; threads: NarrativeThreadView[] } | null>(null)
  const [savingPlanId, setSavingPlanId] = useState<number | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // 只认最后一次发出的请求：刚点完延后，先发的列表请求晚到也不能盖掉新结果。
  const latestRequest = useRef(0)

  useEffect(() => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    const request = ++latestRequest.current
    void ipc.invokeWithProjectSession(session, 'db:narrative-thread-list', session.projectPath).then(threads => {
      if (request === latestRequest.current && isProjectSessionCurrent(session)) setLoaded({ projectId: session.projectId, threads })
    }).catch(() => undefined)
  }, [projectId, chapterNumber, open])

  const change = async (planId: number, failed: string, call: (session: ProjectSessionContext) => Promise<ThreadsResult>) => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || savingPlanId !== null) return
    const request = ++latestRequest.current
    setSavingPlanId(planId)
    setFailure(null)
    try {
      const result = await call(session)
      if (!result.threads) throw new Error(result.error)
      if (request === latestRequest.current && isProjectSessionCurrent(session)) setLoaded({ projectId: session.projectId, threads: result.threads })
    } catch {
      if (isProjectSessionCurrent(session)) setFailure(failed)
    } finally {
      setSavingPlanId(null)
    }
  }

  const set = (input: NarrativeThreadAssignmentInput, failed: string) =>
    void change(input.planId, failed, session => ipc.invokeWithProjectSession(session, 'db:narrative-thread-assignment-set', input, session.projectPath))
  const undo = (planId: number, chapter: number) =>
    void change(planId, text('没能撤销，再点一次试试。', 'Could not undo. Try again.'), session =>
      ipc.invokeWithProjectSession(session, 'db:narrative-thread-assignment-remove', planId, chapter, session.projectPath))

  return {
    panel: chapterThreadPanel(loaded?.projectId === projectId ? loaded?.threads ?? [] : [], chapterNumber),
    savingPlanId,
    failure,
    defer: (planId: number, chapters: number) => {
      const target = chapterNumber + chapters
      set({
        planId, chapterNumber: target, writingChapter: chapterNumber, kind: 'resolve',
        note: text(`写第 ${chapterNumber} 章前延后到第 ${target} 章`, `Moved to Ch. ${target} before writing Ch. ${chapterNumber}`),
      }, text('线索还在本章任务里。延后没保存上，再点一次试试。', 'The thread is still a task for this chapter. The change was not saved. Try again.'))
    },
    assign: (planId: number) => set({
      planId, chapterNumber, writingChapter: chapterNumber, kind: 'advance',
      note: text(`写第 ${chapterNumber} 章前指定本章推进`, `Assigned to Ch. ${chapterNumber} before writing it`),
    }, text('没能指定，再点一次试试。', 'Could not assign it. Try again.')),
    undo,
  }
}
