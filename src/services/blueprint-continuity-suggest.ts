import type { ContinuitySuggestionList, SuggestionDecision } from '../shared/blueprint-continuity-suggest'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import { throwIfLastAttemptTerminal } from './generation/generation-harness'
import { createGraphGeneration } from './graph-generation'
import { ipc } from './ipc-client'

export type LaterBlueprintCheckOutcome = { status: 'checked'; list: ContinuitySuggestionList } | { status: 'unreadable' }

const checks = new Map<string, Promise<LaterBlueprintCheckOutcome>>()
const checkKey = (session: ProjectSessionContext, finalizationId: string) => `${session.projectId}:${session.leaseId}:${finalizationId}`

export const readLaterBlueprintSuggestions = (session: ProjectSessionContext, finalizationId: string) =>
  ipc.invokeWithProjectSession(session, 'graph-generation:suggestions', { finalizationId })

export const decideLaterBlueprintSuggestion = (session: ProjectSessionContext, suggestionId: string, decision: SuggestionDecision) =>
  ipc.invokeWithProjectSession(session, 'graph-generation:decide-suggestion', { suggestionId, decision })

/** 切页回来要接得上：进行中的检查按作品会话和这次替换记下来。 */
export function runLaterBlueprintCheck(session: ProjectSessionContext, finalizationId: string, modelId: string): Promise<LaterBlueprintCheckOutcome> {
  const outcome = check(session, finalizationId, modelId)
  checks.set(checkKey(session, finalizationId), outcome)
  return outcome
}

export const pendingLaterBlueprintCheck = (session: ProjectSessionContext, finalizationId: string) => checks.get(checkKey(session, finalizationId))

export function releaseLaterBlueprintCheck(session: ProjectSessionContext, finalizationId: string, outcome: Promise<LaterBlueprintCheckOutcome>) {
  if (checks.get(checkKey(session, finalizationId)) === outcome) checks.delete(checkKey(session, finalizationId))
}

async function check(session: ProjectSessionContext, finalizationId: string, modelId: string): Promise<LaterBlueprintCheckOutcome> {
  const client = createGraphGeneration(session)
  try {
    await client.open({ input: { kind: 'continuity-suggest', finalizationId }, modelId, uiActionNonce: crypto.randomUUID() })
    const recovery = await client.execute()
    if (recovery.result?.kind === 'continuity-suggest') {
      const list = await readLaterBlueprintSuggestions(session, finalizationId)
      if (list?.runId === recovery.view.handle.runId) return { status: 'checked', list }
    }
    throwIfLastAttemptTerminal(recovery.view.budgetDiagnostics, recovery.view.handle.runId)
    return { status: 'unreadable' }
  } finally {
    client.detach()
  }
}
