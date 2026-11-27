import { useEffect, useRef, useState } from 'react'
import { ipc } from '../../../services/ipc-client'
import { note, type AuthorNote, type Failure } from '../../../shared/failure'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { chapterThreadPanel, type NarrativeThreadAssignmentInput, type NarrativeThreadView } from '../../../shared/narrative-thread'
import { LatestRequestGate } from '../../../shared/latest-request-gate'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { plotWriteFailureText } from '../plot/plot-write-failure'

type ThreadsResult = { success: boolean; threads?: NarrativeThreadView[]; failure?: Failure }
type Move = { from: number; to: number }
type Moves = { key: string; byPlan: ReadonlyMap<number, Move> }

export function useChapterThreadTasks(chapterNumber: number, open: boolean) {
  const text = useLocaleStore(s => s.text)
  const projectId = useProjectStore(s => s.currentProject?.id)
  const [loaded, setLoaded] = useState<{ projectId: string; threads: NarrativeThreadView[] } | null>(null)
  const [savingPlanId, setSavingPlanId] = useState<number | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [moves, setMoves] = useState<Moves | null>(null)
  const movesKey = `${projectId}:${chapterNumber}`
  const movedHere = moves?.key === movesKey ? moves.byPlan : new Map<number, Move>()
  const threadReads = useRef(new LatestRequestGate())

  useEffect(() => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    const request = threadReads.current.begin()
    void ipc.invokeWithProjectSession(session, 'db:narrative-thread-list', session.projectPath).then(threads => {
      if (threadReads.current.isLatest(request) && isProjectSessionCurrent(session)) setLoaded({ projectId: session.projectId, threads })
    }).catch(() => undefined)
  }, [projectId, chapterNumber, open])

  const change = async (planId: number, failed: AuthorNote, call: (session: ProjectSessionContext) => Promise<ThreadsResult>,
    saved: (byPlan: Map<number, Move>) => void = () => undefined) => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || savingPlanId !== null) return
    const request = threadReads.current.begin()
    setSavingPlanId(planId)
    setFailure(null)
    try {
      const result = await call(session)
      if (!isProjectSessionCurrent(session)) return
      if (!result.threads) return setFailure(plotWriteFailureText(result, failed))
      const byPlan = new Map(movedHere)
      saved(byPlan)
      setMoves({ key: movesKey, byPlan })
      if (threadReads.current.isLatest(request)) setLoaded({ projectId: session.projectId, threads: result.threads })
    } catch {
      if (isProjectSessionCurrent(session)) setFailure(plotWriteFailureText(undefined, failed))
    } finally {
      setSavingPlanId(null)
    }
  }

  const set = (input: NarrativeThreadAssignmentInput, failed: AuthorNote, saved?: Parameters<typeof change>[3]) =>
    void change(input.planId, failed, session => ipc.invokeWithProjectSession(session, 'db:narrative-thread-assignment-set', input, session.projectPath), saved)
  const undo = (planId: number, chapter: number) => {
    const move = movedHere.get(planId)
    const restoreEndChapter = move?.to === chapter ? move.from : null
    void change(planId, note('没能撤销，再点一次试试。', 'Could not undo. Try again.'), session =>
      ipc.invokeWithProjectSession(session, 'db:narrative-thread-assignment-remove', planId, chapter, restoreEndChapter, session.projectPath),
    byPlan => byPlan.delete(planId))
  }
  const threads = loaded?.projectId === projectId ? loaded?.threads ?? [] : []

  return {
    panel: chapterThreadPanel(threads, chapterNumber, movedHere),
    savingPlanId,
    failure,
    defer: (planId: number, chapters: number) => {
      const target = chapterNumber + chapters
      const from = threads.find(thread => thread.id === planId)?.targetEndChapter
      set({
        planId, chapterNumber: target, writingChapter: chapterNumber, kind: 'resolve',
        note: text(`写第 ${chapterNumber} 章时延后`, `Moved on while writing Ch. ${chapterNumber}`),
      }, note('线索还在本章任务里。延后没保存上，再点一次试试。', 'The thread is still a task for this chapter. The change was not saved. Try again.'),
      byPlan => { if (from !== undefined) byPlan.set(planId, { from, to: target }) })
    },
    assign: (planId: number) => set({
      planId, chapterNumber, writingChapter: chapterNumber, kind: 'advance',
      note: text(`写第 ${chapterNumber} 章前指定本章推进`, `Assigned to Ch. ${chapterNumber} before writing it`),
    }, note('没能指定，再点一次试试。', 'Could not assign it. Try again.')),
    undo,
  }
}
