import { create } from 'zustand'
import type { ProjectSessionContext } from '../shared/ipc-channels'

interface RestoredPublication {
  finalizationId: string
  publication: 'pending' | 'published'
}

export const useRestoredPublicationStore = create<Record<string, RestoredPublication>>()(() => ({}))

export const restoredPublicationKey = (leaseId: string, draftId: number) => `${leaseId}\n${draftId}`

export function recordRestoredPublication(session: ProjectSessionContext, draftId: number, finalizationId: string, publication: 'pending' | 'published'): void {
  const key = restoredPublicationKey(session.leaseId, draftId)
  useRestoredPublicationStore.setState(state => {
    const next = { ...state }
    if (publication === 'pending') next[key] = { finalizationId, publication }
    else delete next[key]
    return next
  }, true)
}

export function markRestoredPublished(leaseId: string, draftId: number, finalizationId: string): void {
  const key = restoredPublicationKey(leaseId, draftId)
  if (useRestoredPublicationStore.getState()[key]?.finalizationId !== finalizationId) return
  useRestoredPublicationStore.setState({ [key]: { finalizationId, publication: 'published' } })
}
