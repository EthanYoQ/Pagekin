import type { ApproveCharacterProposalRequest, CharacterProposalBatch } from '../shared/character-proposal'
import { adoptableRelationships, defaultCharacterProposalSelections, proposalRelations, sameRelationship } from './workflows/character-proposal-preview'

export interface CharacterProposalChoices {
  proposalBatchId: string
  revision: number
  /** 关系目标按这份已保存角色快照解析，面板与提交都用它，不各自重读。 */
  identities: { characterId: string; name: string; role?: string }[]
  selections: ApproveCharacterProposalRequest['selections']
  relationships: NonNullable<ApproveCharacterProposalRequest['relationships']>
  edits?: NonNullable<ApproveCharacterProposalRequest['edits']>
}
/** 作者勾着、且在同一份快照下可勾的关系。改采用方式后的修剪和提交都只认它。 */
export function adoptedRelationships(batch: CharacterProposalBatch, choices: CharacterProposalChoices) {
  const allowed = proposalRelations(batch, choices.identities, choices.selections).flatMap(relation => relation.adoptable && relation.edge ? [relation.edge] : [])
  return adoptableRelationships(choices.selections, choices.relationships.filter(relation => allowed.some(edge => sameRelationship(edge, relation))))
}
export function createCharacterProposalChoices(batch: CharacterProposalBatch, identities: CharacterProposalChoices['identities']): CharacterProposalChoices {
  const selections = defaultCharacterProposalSelections(batch)
  const choices = { proposalBatchId: batch.proposalBatchId, revision: batch.revision, identities, selections,
    relationships: proposalRelations(batch, identities, selections).flatMap(relation => relation.edge ? [relation.edge] : []) }
  return { ...choices, relationships: adoptedRelationships(batch, choices) }
}
