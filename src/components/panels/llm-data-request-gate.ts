import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { sameProjectSessionContext } from '../../shared/project-session-context'
import { LatestRequestGate } from '../../shared/latest-request-gate'

export interface LLMDataRequestTicket {
  requestId: number
  projectSession: ProjectSessionContext
}

export class LLMDataRequestGate {
  private readonly requests = new LatestRequestGate()

  begin(projectSession: ProjectSessionContext): LLMDataRequestTicket {
    return { requestId: this.requests.begin(), projectSession }
  }

  isCurrent(
    ticket: LLMDataRequestTicket,
    currentProjectSession: ProjectSessionContext | null,
  ): boolean {
    return this.requests.isLatest(ticket.requestId)
      && sameProjectSessionContext(ticket.projectSession, currentProjectSession)
  }

  invalidate(): void {
    this.requests.begin()
  }
}
