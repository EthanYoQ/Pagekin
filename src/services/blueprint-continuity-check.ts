import type { ContinuityCheckChapter, ContinuityCheckNode, ContinuityCheckResult } from '../shared/blueprint-continuity-check'
import type { GraphGenerationRecovery } from '../shared/graph-generation'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import { throwIfLastAttemptTerminal } from './generation/generation-harness'
import { createGraphGeneration } from './graph-generation'
import { ipc } from './ipc-client'

export interface ContinuityReport {
  /** 结果读回来时，来源（蓝图、时间线、模型）和检查时是否一致。 */
  sourceStatus: GraphGenerationRecovery['sourceStatus']
  chapters: ReadonlyMap<number, ContinuityCheckChapter>
  nodes: ReadonlyMap<string, ContinuityCheckNode>
  result: ContinuityCheckResult
}

export type ContinuityCheckOutcome =
  | { status: 'checked'; report: ContinuityReport }
  /** 检查期间来源变了，这份结果对不上现在的蓝图。 */
  | { status: 'changed' }
  | { status: 'unreadable' }

function reportOf(recovery: GraphGenerationRecovery): ContinuityReport | null {
  if (recovery.context.kind !== 'continuity' || recovery.result?.kind !== 'continuity') return null
  return {
    sourceStatus: recovery.sourceStatus,
    chapters: new Map(recovery.context.chapters.map(chapter => [chapter.chapterNumber, chapter])),
    nodes: new Map(recovery.context.nodes.map(node => [node.eventId, node])),
    result: recovery.result,
  }
}

const checks = new Map<string, Promise<ContinuityCheckOutcome>>()
const checkKey = (session: ProjectSessionContext) => `${session.projectId}:${session.leaseId}`

/** 作者切走页面时检查照样跑完；回到蓝图页从这里接回，不再花一次模型费用。渲染进程重载后接不回。 */
export function runContinuityCheck(session: ProjectSessionContext, modelId: string): Promise<ContinuityCheckOutcome> {
  const outcome = checkContinuity(session, modelId)
  checks.set(checkKey(session), outcome)
  return outcome
}

export const pendingContinuityCheck = (session: ProjectSessionContext) => checks.get(checkKey(session))

/** 结果显示给作者之后才放掉；没人看到之前一直留着等页面回来。 */
export function forgetContinuityCheck(session: ProjectSessionContext, outcome: Promise<ContinuityCheckOutcome>) {
  if (checks.get(checkKey(session)) === outcome) checks.delete(checkKey(session))
}

async function checkContinuity(session: ProjectSessionContext, modelId: string): Promise<ContinuityCheckOutcome> {
  const client = createGraphGeneration(session)
  try {
    await client.open({ input: { kind: 'continuity' }, modelId, uiActionNonce: crypto.randomUUID() })
    const recovery = await client.execute()
    if (recovery.sourceStatus === 'conflict') return { status: 'changed' }
    const report = reportOf(recovery)
    if (report) return { status: 'checked', report }
    throwIfLastAttemptTerminal(recovery.view.budgetDiagnostics, recovery.view.handle.runId)
    return { status: 'unreadable' }
  } finally {
    client.detach()
  }
}

export async function readLatestContinuityReport(session: ProjectSessionContext): Promise<ContinuityReport | null> {
  const recovery = await ipc.invokeWithProjectSession(session, 'graph-generation:latest-continuity')
  return recovery && reportOf(recovery)
}
