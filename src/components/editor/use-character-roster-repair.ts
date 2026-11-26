import type { MainGenerationRunHandle } from '../../services/generation/generation-runtime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useCharacterStore } from '../../stores/character-store'
import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../../services/ipc-client'
import { migrateLegacyCharacterRoster } from '../../services/workflows/architecture-workflow'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../project-session-gate'
import {
  CharacterRosterRepairController,
  type CharacterRosterRepairPort,
  type CharacterRosterRepairState,
} from './character-roster-repair-controller'

const EMPTY_STATE: CharacterRosterRepairState & { settled: boolean } = {
  snapshot: null,
  repairError: null,
  isRepairing: false,
  settled: false,
}

interface SessionBoundRosterRepairState extends CharacterRosterRepairState {
  sessionKey: string
  settled: boolean
}

export interface UseCharacterRosterRepairOptions {
  projectKey: string
  enabled?: boolean
}

function projectSessionKey(
  projectId: string | undefined,
  projectPath: string | undefined,
  projectLease: string | undefined,
): string {
  return projectId && projectPath && projectLease
    ? `${projectId}\u0000${projectLease}\u0000${projectPath}`
    : ''
}

export function useCharacterRosterRepair({
  projectKey,
  enabled = true,
}: UseCharacterRosterRepairOptions) {
  const projectId = useProjectStore(state => state.currentProject?.id)
  const projectPath = useProjectStore(state => state.currentProject?.path)
  const projectLease = useProjectStore(state => state.currentProject?.sessionLease)
  const sessionKey = projectSessionKey(projectId, projectPath, projectLease)
  const [state, setState] = useState<SessionBoundRosterRepairState>({
    ...EMPTY_STATE,
    sessionKey: '',
  })

  const setControllerState = useCallback((next: Partial<CharacterRosterRepairState>) => {
    setState(previous => ({ ...previous, ...next, sessionKey, settled: (previous.sessionKey === sessionKey && previous.settled) || 'snapshot' in next }))
  }, [sessionKey])

  const port = useMemo<CharacterRosterRepairPort>(() => ({
    getSession: () => captureProjectSession(useProjectStore.getState().currentProject),
    isSessionUsable: session => (
      enabled
      && projectSessionKey(session.projectId, session.projectPath, session.leaseId) === sessionKey
      && isProjectSessionPath(session, projectKey)
      && isProjectSessionCurrent(session)
    ),
    read: session => ipc.invokeWithProjectSession(
      session,
      'db:character-roster-read',
      session.projectPath,
    ),
    migrate: (projectPath, options) => migrateLegacyCharacterRoster(projectPath, options),
    setState: setControllerState,
  }), [enabled, projectKey, sessionKey, setControllerState])

  const controller = useMemo(
    () => new CharacterRosterRepairController(() => port),
    [port],
  )
  const refresh = useCallback(() => controller.load(), [controller])
  const migrate = useCallback((options?: { recoveryHandle?: MainGenerationRunHandle; restart?: boolean }) => controller.migrate(options), [controller])

  useEffect(() => {
    const timer = setTimeout(() => { void controller.load() }, 0)
    return () => {
      clearTimeout(timer)
      controller.invalidate()
    }
  }, [controller])

  const rosterRevision = useCharacterStore(state => state.dataProjectKey === projectKey ? state.rosterRevision : null)
  const seenRevision = useRef(rosterRevision)
  useEffect(() => {
    if (rosterRevision === seenRevision.current) return
    const first = seenRevision.current === null
    seenRevision.current = rosterRevision
    if (!first && rosterRevision !== null) void controller.load()
  }, [controller, rosterRevision])

  const visibleState = state.sessionKey === sessionKey ? state : EMPTY_STATE
  return {
    snapshot: visibleState.snapshot,
    repairError: visibleState.repairError,
    isRepairing: visibleState.isRepairing,
    settled: visibleState.settled,
    refresh,
    migrate,
  }
}
