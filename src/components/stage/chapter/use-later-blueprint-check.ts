import { useCallback, useEffect, useRef, useState } from 'react'
import { displayedErrorMessage, errorCodeOf } from '../../../i18n/app-errors'
import {
  decideLaterBlueprintSuggestion, pendingLaterBlueprintCheck, readLaterBlueprintSuggestions, releaseLaterBlueprintCheck, runLaterBlueprintCheck,
  type LaterBlueprintCheckOutcome,
} from '../../../services/blueprint-continuity-suggest'
import type { ContinuitySuggestionList, SuggestionDecision } from '../../../shared/blueprint-continuity-suggest'
import { globalEventBus } from '../../../shared/event-bus'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { routeStageModel } from '../../../shared/model-stage-routing'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { toast } from '../../ui/Toast'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../../project-session-gate'

type Status = { kind: 'idle' | 'running' | 'done' | 'unreadable' } | { kind: 'failed'; message: string }

function sessionFor(projectKey: string) {
  const session = captureProjectSession(useProjectStore.getState().currentProject)
  return session && isProjectSessionPath(session, projectKey) ? session : null
}

export function useLaterBlueprintCheck(projectKey: string, finalizationId: string) {
  const sessionLease = useProjectStore(s => s.currentProject?.sessionLease)
  const [status, setStatus] = useState<Status>(() => {
    const session = sessionFor(projectKey)
    return session && pendingLaterBlueprintCheck(session, finalizationId) ? { kind: 'running' } : { kind: 'idle' }
  })
  const [list, setList] = useState<ContinuitySuggestionList | null>(null)
  const [busy, setBusy] = useState(false)
  const [staleChapter, setStaleChapter] = useState<number | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const follow = useCallback((session: ProjectSessionContext, pending: Promise<LaterBlueprintCheckOutcome>) => {
    const shown = () => {
      if (!mounted.current || !isProjectSessionCurrent(session)) return false
      releaseLaterBlueprintCheck(session, finalizationId, pending)
      return true
    }
    return pending.then(outcome => {
      if (!shown()) return
      setStaleChapter(null)
      if (outcome.status === 'checked') { setList(outcome.list); setStatus({ kind: 'done' }) } else setStatus({ kind: 'unreadable' })
    }, (error: unknown) => {
      if (!shown()) return
      const { text, locale } = useLocaleStore.getState()
      setStatus({ kind: 'failed', message: errorCodeOf(error) === 'GENERATION_GRAPH_BLUEPRINT_REQUIRED'
        ? text('后面的章都已定稿，没有要检查的蓝图。', 'Every later chapter is finalized, so there is no blueprint to check.')
        : displayedErrorMessage(locale, error, text('蓝图没有改动。这次没查成，再点“检查后续蓝图”。', 'Your blueprints are unchanged. The check did not finish. Choose Check later blueprints again.')) })
    })
  }, [finalizationId])

  useEffect(() => {
    const session = sessionFor(projectKey)
    if (!session) return
    let active = true
    const pending = pendingLaterBlueprintCheck(session, finalizationId)
    if (pending) void follow(session, pending)
    void readLaterBlueprintSuggestions(session, finalizationId)
      .then(latest => { if (active && isProjectSessionCurrent(session) && !pending) setList(latest) }).catch(() => {})
    return () => { active = false }
  }, [projectKey, finalizationId, sessionLease, follow])

  const run = async () => {
    const session = sessionFor(projectKey)
    if (!session) return
    const modelId = routeStageModel('planning', useLLMStore.getState()).modelId
    if (!modelId) {
      const { text } = useLocaleStore.getState()
      setStatus({ kind: 'failed', message: text('蓝图没有改动。还没有能用的模型，到“分工模型”选一个，再点“检查后续蓝图”。', 'Your blueprints are unchanged. No model is available. Pick one in Model roles, then choose Check later blueprints again.') })
      return
    }
    setStatus({ kind: 'running' })
    await follow(session, runLaterBlueprintCheck(session, finalizationId, modelId))
  }

  const decide = async (suggestionId: string, chapterNumber: number, decision: SuggestionDecision) => {
    const session = sessionFor(projectKey)
    if (!session || busy) return
    setBusy(true)
    try {
      const result = await decideLaterBlueprintSuggestion(session, suggestionId, decision).catch(() => null)
      if (!isProjectSessionCurrent(session)) return
      if (!result) {
        const { text } = useLocaleStore.getState()
        toast.error(text('蓝图没有改动。没处理成，再点一次试试。', 'Your blueprint is unchanged. That did not go through. Try again.'))
        return
      }
      setStaleChapter(result.status === 'stale' ? chapterNumber : null)
      if (result.status === 'accepted') globalEventBus.emit('REFRESH_RESOURCE', { projectSession: session, projectPath: session.projectPath, resources: ['blueprints'] })
      setList(await readLaterBlueprintSuggestions(session, finalizationId).catch(() => list))
    } finally { setBusy(false) }
  }

  return { status, list, busy, staleChapter, run, decide }
}

export type LaterBlueprintCheck = ReturnType<typeof useLaterBlueprintCheck>
