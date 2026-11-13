import type { ApproveCharacterProposalRequest, CharacterProposalBatch } from '../shared/character-proposal'
import { defaultCharacterProposalRelationships, defaultCharacterProposalSelections } from './workflows/character-proposal-preview'

export interface CharacterProposalChoices {
  proposalBatchId: string
  revision: number
  selections: ApproveCharacterProposalRequest['selections']
  relationships: NonNullable<ApproveCharacterProposalRequest['relationships']>
  edits?: NonNullable<ApproveCharacterProposalRequest['edits']>
}
export function createCharacterProposalChoices(batch: CharacterProposalBatch,
  identities: Parameters<typeof defaultCharacterProposalRelationships>[1] = []): CharacterProposalChoices {
  return { proposalBatchId: batch.proposalBatchId, revision: batch.revision,
    selections: defaultCharacterProposalSelections(batch), relationships: defaultCharacterProposalRelationships(batch, identities) }
}
