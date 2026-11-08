import { useCallback, useEffect, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import type { PendingFinalizedRelationCandidate } from '../../shared/finalized-continuity'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { useCharacterStore } from '../../stores/character-store'
import { useLocaleStore } from '../../stores/locale-store'
import { appErrorMessage } from '../../i18n/app-errors'
import { isProjectSessionCurrent } from '../project-session-gate'

const failureText = (cause: unknown) => appErrorMessage(useLocaleStore.getState().locale, cause)

/** 定稿发现的、和作者设定不一致的关系：采用、保留原设定，或以后再说（什么都不记）。 */
export function usePendingRelationCandidates(session: ProjectSessionContext) {
  const [candidates, setCandidates] = useState<PendingFinalizedRelationCandidate[]>([])
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reload = useCallback(async (failure = '') => {
    if (!isProjectSessionCurrent(session)) return
    try {
      const pending = await ipc.invokeWithProjectSession(session, 'finalized-character:list-relation-candidates')
      if (!isProjectSessionCurrent(session)) return
      setCandidates(pending); setError(failure)
    } catch (cause) {
      if (isProjectSessionCurrent(session)) setError(failureText(cause))
    }
  }, [session])

  useEffect(() => {
    const timer = window.setTimeout(() => { void reload() }, 0)
    return () => window.clearTimeout(timer)
  }, [reload])

  const open = candidates.find(item => item.candidateKey === openKey) ?? null

  async function decide(decision: 'accept' | 'decline') {
    if (!open || busy) return
    setBusy(true); setError('')
    try {
      await ipc.invokeWithProjectSession(session, 'finalized-character:decide-relation-candidate', {
        draftId: open.source.draftId, candidateKey: open.candidateKey, expectedAuthorRelations: open.authorRelations,
        operationId: `finalized-relation:${decision}:${open.candidateKey}`, decision,
      })
      if (!isProjectSessionCurrent(session)) return
      if (decision === 'accept') await useCharacterStore.getState().load(session.projectPath, session)
      setOpenKey(null)
      await reload()
    } catch (cause) {
      if (!isProjectSessionCurrent(session)) return
      setOpenKey(null)
      await reload(failureText(cause))
    } finally {
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }

  return { candidates, open, busy, error, reload, decide, review: setOpenKey, later: () => setOpenKey(null) }
}
