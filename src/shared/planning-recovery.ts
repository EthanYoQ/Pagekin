import type { GenerationRecoveryContext } from './generation-owner-contract'

export function planningRecoverable(context: GenerationRecoveryContext): boolean {
  if (!context.plotOutlineRecovery && !context.blueprintRecovery) return false
  if (context.planningDraft && context.planningDraft.standing !== 'open') return false
  return context.planningContinuation?.state !== 'complete' && !context.plotOutlineRecovery?.inFormalOutline
}
