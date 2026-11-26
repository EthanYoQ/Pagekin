import { useCallback, useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../../stores/project-store'
import { readPostProcessStatus, type PostProcessStatus } from '../../services/workflows/workflow-utils'
import { globalEventBus } from '../../shared/event-bus'
import { sameProjectSessionContext } from '../../shared/project-session-context'
import { captureProjectSession, isProjectSessionCurrent } from '../project-session-gate'

export type StepPresentation = 'success' | 'pending' | 'failed'

export function getStepPresentation(step: PostProcessStatus['steps'][string]): StepPresentation {
  if (step.ok) return 'success'

  const hasFailureEvidence = Number(step.attemptCount) > 0
    || Boolean(step.error?.trim())
    || Boolean(step.lastAttemptAt?.trim())
    || Boolean(step.completedAt?.trim())

  return hasFailureEvidence ? 'failed' : 'pending'
}

export function usePostProcessStatus(scope: string, busy = false) {
  const [status, setStatus] = useState<PostProcessStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const project = useProjectStore(s => s.currentProject)

  const loadStatus = useCallback(async () => {
    const projectSession = captureProjectSession(project)
    if (!projectSession) return
    const s = await readPostProcessStatus(projectSession.projectPath, scope, projectSession)
    if (!isProjectSessionCurrent(projectSession)) return
    setStatus(s)
    setLoading(false)
  }, [project, scope])

  useEffect(() => {
    let mounted = true
    const init = async () => {
      const projectSession = captureProjectSession(project)
      if (!projectSession) return
      setLoading(true)
      const s = await readPostProcessStatus(projectSession.projectPath, scope, projectSession)
      if (mounted && isProjectSessionCurrent(projectSession)) {
        setStatus(s)
        setLoading(false)
      }
    }
    init()
    return () => { mounted = false }
  }, [project, scope])

  useEffect(() => {
    const matchesCurrentProject = (eventSession: Parameters<typeof sameProjectSessionContext>[0]) => {
      const projectSession = captureProjectSession(project)
      return !!projectSession && sameProjectSessionContext(projectSession, eventSession)
    }
    const unsub1 = globalEventBus.on('FINALIZE_COMPLETE', ({ projectSession }) => {
      if (matchesCurrentProject(projectSession)) void loadStatus()
    })
    const unsub2 = globalEventBus.on('WORKFLOW_COMPLETE', ({ projectSession }) => {
      if (matchesCurrentProject(projectSession)) void loadStatus()
    })
    return () => { unsub1(); unsub2() }
  }, [loadStatus, project])

  const wasBusy = useRef(busy)
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => {
    if (wasBusy.current && !busy) {
      setRefreshing(true)
      void loadStatus().finally(() => setRefreshing(false))
    }
    wasBusy.current = busy
  }, [busy, loadStatus])

  const steps = status
    ? Object.entries(status.steps).map(([key, step]) => ({ key, step, presentation: getStepPresentation(step) }))
    : []
  return { status, loading, refreshing, steps }
}
