import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { BlueprintForPreflight, ConsistencyExemption, ConsistencyFinding } from '../shared/consistency-preflight'
import { pendingRelationFactKey } from '../shared/blueprint-relation-conflict'
import { findBlueprintContinuityRisks } from '../shared/consistency-preflight'
import type { PendingFinalizedRelationCandidate } from '../shared/finalized-continuity'
import { ipc } from './ipc-client'

/** 同一节点在批量里可能出现在多章，按章豁免要靠 chapterNumber 区分。 */
export type PreflightFinding = ConsistencyFinding & { chapterNumber: number; characterId?: string }

export interface ConsistencyPreflightResult {
  findings: PreflightFinding[]
  exemptions: ConsistencyExemption[]
}

export type ExemptionScope = 'chapter' | 'book'

type ExemptableFinding = Pick<PreflightFinding, 'stableFactKey' | 'chapterNumber'>

export const exemptionChapter = (finding: ExemptableFinding, scope: ExemptionScope) => scope === 'book' ? null : finding.chapterNumber

export function saveFindingExemption(
  session: ProjectSessionContext,
  finding: ExemptableFinding,
  scope: ExemptionScope,
  text: (zh: string, en: string) => string,
) {
  const reason = scope === 'book'
    ? text('作者确认全书都是有意安排', 'The author confirmed this is intentional throughout the book.')
    : text('作者确认是有意安排', 'The author confirmed this is intentional.')
  return ipc.invokeWithProjectSession(session, 'db:consistency-exemption-save', finding.stableFactKey, reason, exemptionChapter(finding, scope), session.projectPath)
}

export async function readConsistencyPreflight(
  session: ProjectSessionContext,
  blueprints: readonly BlueprintForPreflight[],
): Promise<ConsistencyPreflightResult> {
  const exemptions = await ipc.invokeWithProjectSession(
    session, 'db:consistency-exemption-list', session.projectPath,
  )
  // 回执和关系节点读不出来时只少一类提示，不影响其他提示，也不影响写作。
  const hints = await ipc.invokeWithProjectSession(
    session, 'db:blueprint-relationship-hints', [...blueprints], session.projectPath,
  ).catch((): Record<number, unknown> => ({}))
  const nodes = Object.keys(hints).length > 0
    ? await ipc.invokeWithProjectSession(session, 'db:character-continuity-preflight-nodes', session.projectPath).catch(() => [])
    : []
  const pendingRelations = await ipc.invokeWithProjectSession(session, 'finalized-character:list-relation-candidates')
    .catch((): PendingFinalizedRelationCandidate[] => [])
  const subjects = new Map([
    ...nodes.map(node => [`relation:${node.eventId}`, node.subjectId] as const),
    ...pendingRelations.map(candidate => [pendingRelationFactKey(candidate.candidateKey), candidate.sourceId] as const),
  ])
  const findings = (await Promise.all(blueprints.map(async blueprint => {
    const projections = await ipc.invokeWithProjectSession(
      session, 'db:continuity-list-before', blueprint.chapterNumber, session.projectPath,
    )
    return findBlueprintContinuityRisks(projections, { ...blueprint, relationshipHints: hints[blueprint.chapterNumber] }, exemptions, nodes, pendingRelations)
      .map(finding => ({ ...finding, chapterNumber: blueprint.chapterNumber, characterId: subjects.get(finding.stableFactKey) }))
  }))).flat()
  return { findings, exemptions }
}
