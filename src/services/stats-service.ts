import { ipc } from './ipc-client'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { LLMFinishReason } from '../shared/ipc-channels'
import { sameProjectPathKey } from '../shared/project-session-context'
import { SQLITE_TIMESTAMP } from '../shared/sqlite-time'
import type { WorkflowRun } from '../stores/workflow-store'
import type { SafeDiagnosticWorkflow } from './safe-call-diagnostic'

export interface LLMStats {
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  knownUsageCalls: number
  totalTokens: number | null
  totalPromptTokens: number | null
  totalCompletionTokens: number | null
}

export interface LLMCallRecord {
  id: number
  modelId?: string
  modelName: string
  purpose: string
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  durationMs: number
  success: boolean
  finishReason?: LLMFinishReason | null
  createdAt: string
}

function callCompletionRange(createdAt: string): [number, number] | null {
  const sqlite = SQLITE_TIMESTAMP.exec(createdAt)
  if (sqlite) {
    const start = Date.parse(`${sqlite[1]}T${sqlite[2]}Z`)
    return Number.isFinite(start) ? [start, start + 999] : null
  }
  const timestamp = Date.parse(createdAt)
  return Number.isFinite(timestamp) ? [timestamp, timestamp] : null
}

function timestamp(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function diagnosticWorkflowForCall(
  call: LLMCallRecord,
  runs: readonly WorkflowRun[],
  projectPath: string,
): SafeDiagnosticWorkflow {
  const diagnostic: SafeDiagnosticWorkflow = call.finishReason
    ? { finishReason: call.finishReason }
    : {}
  const completionRange = callCompletionRange(call.createdAt)
  if (!completionRange || !Number.isFinite(call.durationMs) || call.durationMs < 0) return diagnostic

  const [earliestCompletion, latestCompletion] = completionRange
  const candidates = runs.flatMap(run => {
    if (!sameProjectPathKey(run.projectPath, projectPath)) return []
    return run.steps.flatMap(step => {
      const stepStart = timestamp(step.startedAt)
      if (stepStart === null) return []
      const stepEnd = timestamp(step.completedAt) ?? timestamp(run.completedAt) ?? Number.POSITIVE_INFINITY
      const possibleCompletionStart = Math.max(earliestCompletion, stepStart + call.durationMs)
      const possibleCompletionEnd = Math.min(latestCompletion, stepEnd)
      return possibleCompletionStart <= possibleCompletionEnd ? [{ run, step }] : []
    })
  })
  if (candidates.length !== 1) return diagnostic

  const { run, step } = candidates[0]
  return {
    ...diagnostic,
    status: run.status,
    failureCode: run.failureCode,
    stepName: step.name,
    stepStatus: step.status,
    stepFailureCode: step.failureCode,
    promptBudgetReport: step.promptBudgetReport ?? run.promptBudgetReport,
  }
}

export async function getLLMStats(projectSession: ProjectSessionContext): Promise<LLMStats> {
  return ipc.invokeWithProjectSession(
    projectSession,
    'db:get-llm-stats',
    projectSession.projectPath,
  )
}

export async function getLLMHistory(
  projectSession: ProjectSessionContext,
  limit = 30,
): Promise<LLMCallRecord[]> {
  return (await ipc.invokeWithProjectSession(
    projectSession,
    'db:get-llm-history',
    limit,
    projectSession.projectPath,
  )) as unknown as LLMCallRecord[]
}

export async function loadLLMData(
  projectSession: ProjectSessionContext,
  limit = 30,
): Promise<{ stats: LLMStats; history: LLMCallRecord[] }> {
  const [stats, history] = await Promise.all([
    getLLMStats(projectSession),
    getLLMHistory(projectSession, limit),
  ])
  return { stats, history }
}
