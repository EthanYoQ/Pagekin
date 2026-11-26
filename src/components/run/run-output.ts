import { sameProjectPathKey } from '../../shared/project-session-context'
import type { WorkflowRun } from '../../stores/workflow-store'

export const ACTIVE_RUN_STATUSES: ReadonlySet<WorkflowRun['status']> = new Set(['running', 'waiting', 'paused', 'cancelling'])

export function projectRuns(runs: readonly WorkflowRun[], projectPath: string | undefined): WorkflowRun[] {
  return projectPath ? runs.filter(run => sameProjectPathKey(run.projectPath, projectPath)) : []
}

export function splitThinking(result: unknown): { raw: string; thinking: string; content: string } {
  const raw = typeof result === 'string' ? result : result ? JSON.stringify(result) : ''
  const segments = raw.split(/<think>/)
  if (segments.length === 1) return { raw, thinking: '', content: raw }
  const last = segments[segments.length - 1]
  const end = last.indexOf('</think>')
  return end === -1
    ? { raw, thinking: last, content: '' }
    : { raw, thinking: last.substring(0, end), content: last.substring(end + 8) }
}
