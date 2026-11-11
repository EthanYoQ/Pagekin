import { relationshipFacts } from './blueprint-character-sync-evidence'
import type { CharacterRelationNode, ContinuityNode, LatestContinuityNodes } from './character-continuity'
import { characterRosterIdentityKey } from './character-roster'
import type { BlueprintForPreflight, ConsistencyFinding } from './consistency-preflight'
import type { PendingFinalizedRelationCandidate } from './finalized-continuity'

export type RelationPolarity = 'hostile' | 'close'

const OPPOSITE: Readonly<Record<RelationPolarity, RelationPolarity>> = { hostile: 'close', close: 'hostile' }

const pattern = (chinese: readonly string[], english: string) =>
  new RegExp(`${[...chinese].sort((a, b) => b.length - a.length).join('|')}|\\b(?:${english})\\b`, 'giu')

const POLARITY_TERMS: ReadonlyArray<readonly [RelationPolarity, RegExp]> = [
  ['hostile', pattern(
    ['决裂', '反目', '敌对', '敌人', '仇人', '仇敌', '仇家', '死敌', '宿敌', '势不两立', '水火不容', '不共戴天', '翻脸', '绝交', '背叛', '追杀'],
    'enem(?:y|ies)|archenem(?:y|ies)|foes?|nemes[ie]s|estranged|betray(?:ed|er|s)?',
  )],
  ['close', pattern(
    ['亲密无间', '亲密', '同伴', '伙伴', '搭档', '挚友', '好友', '密友', '朋友', '知己', '至交', '战友', '盟友', '同盟', '结盟', '恋人', '爱人', '情侣', '伴侣', '夫妻'],
    'friends?|all(?:y|ies)|lovers?|companions?|confidants?|spouses?',
  )],
]

const UNCERTAIN = /[不没无未非假伪曾昔前旧原似疑虚或]|表面|名义|暗中|可能|破裂|解除|结束|\b(?:not|no|never|former(?:ly)?|ex|once|fake|false|pretend(?:s|ed|ing)?|sham|seeming(?:ly)?|maybe|perhaps)\b/iu

/** 蓝图自己写了关系转折，相反就是作者要的安排，整章不报。 */
const RELATION_TURN = /和解|解开误会|误会解开|解除误会|重归于好|言归于好|冰释前嫌|尽释前嫌|破镜重圆|握手言和|化敌为友|化干戈|重修旧好|回心转意|反水|倒戈|决裂|反目|背叛|翻脸|假意|伪装|卧底|\b(?:reconcil\w*|mak(?:e|es|ing) amends|mend\w*|forgiv\w*|forgave|defect\w*|turncoat|betray\w*|undercover|double agent|pretend\w*)\b/iu

/** 只认词表里明确的说法。两类都沾、带否定或不确定词的一律不判，宁可漏报，不要误报。 */
export function relationPolarity(text: string): RelationPolarity | null {
  const found = new Set<RelationPolarity>()
  let rest = text
  for (const [polarity, terms] of POLARITY_TERMS) {
    const stripped = rest.replace(terms, ' ')
    if (stripped !== rest) found.add(polarity)
    rest = stripped
  }
  return found.size === 1 && !UNCERTAIN.test(rest) ? [...found][0]! : null
}

interface ContinuityBasis {
  sourceChapter: number
  authorSetting?: true
  evidence: string
  since: { zhCN: string; enUS: string }
}

/** 派生节点没有定稿原文就没有依据（ADR-0017）。基线节点的章号是迁移时补的，不当章号给作者看，sourceChapter 记 0。 */
export function continuityBasis(node: ContinuityNode): ContinuityBasis | null {
  const chapter = node.effectiveChapter
  switch (node.provenance.kind) {
    case 'author':
      return { sourceChapter: chapter, authorSetting: true, evidence: node.value, since: { zhCN: `第 ${chapter} 章起`, enUS: `from chapter ${chapter}` } }
    case 'adopted':
      return { sourceChapter: chapter, evidence: node.value, since: { zhCN: `第 ${chapter} 章起`, enUS: `from chapter ${chapter}` } }
    case 'derived':
      return node.quote && {
        sourceChapter: chapter, evidence: node.quote.text,
        since: { zhCN: `第 ${chapter} 章定稿后`, enUS: `since chapter ${chapter} was finalized` },
      }
    case 'legacy':
      return { sourceChapter: 0, evidence: node.value, since: { zhCN: '升级前的设定里', enUS: 'in your notes from before the upgrade' } }
  }
}

function newestFirst(left: CharacterRelationNode, right: CharacterRelationNode): number {
  return right.effectiveChapter - left.effectiveChapter || right.seq - left.seq
}

/** 键只取自节点：同一节点在别的章要用同一个键，全书豁免才管用。 */
export function findRelationReversals(blueprint: BlueprintForPreflight, continuity: LatestContinuityNodes): ConsistencyFinding[] {
  const planText = [blueprint.purpose, blueprint.keyEvents, blueprint.suspenseHook, blueprint.notes, blueprint.userGuidance].join('\n')
  if (RELATION_TURN.test(planText)) return []
  const findings = new Map<string, ConsistencyFinding>()
  for (const hint of relationshipFacts(blueprint.relationshipHints)) {
    const planned = relationPolarity(hint.relation)
    if (!planned) continue
    const names = new Set([hint.from, hint.to].map(characterRosterIdentityKey))
    const lines = continuity.relations.flatMap(pair => pair.lines)
      .filter(line => names.size === 2 && names.has(characterRosterIdentityKey(line.subjectName)) && names.has(characterRosterIdentityKey(line.targetName)))
    if (lines.length === 0 || lines.some(line => relationPolarity(line.value) !== OPPOSITE[planned])) continue
    const line = [...lines].sort(newestFirst).find(candidate => continuityBasis(candidate))
    if (!line) continue
    const basis = continuityBasis(line)!
    const stableFactKey = `relation:${line.eventId}`
    if (findings.has(stableFactKey)) continue
    findings.set(stableFactKey, {
      stableFactKey,
      severity: 'warning',
      sourceChapter: basis.sourceChapter,
      ...(basis.authorSetting && { authorSetting: true }),
      evidence: basis.evidence,
      issue: {
        zhCN: `第 ${blueprint.chapterNumber} 章蓝图把 ${hint.from} 和 ${hint.to} 写成「${hint.relation}」，但${basis.since.zhCN}两人是「${line.value}」。`,
        enUS: `The chapter ${blueprint.chapterNumber} blueprint has ${hint.from} and ${hint.to} as “${hint.relation}”, but ${basis.since.enUS} they are “${line.value}”.`,
      },
      suggestion: {
        zhCN: '改这一章的蓝图，或确认这是有意安排。',
        enUS: 'Edit this chapter’s blueprint, or mark it as intentional.',
      },
    })
  }
  return [...findings.values()]
}

export const pendingRelationFactKey = (candidateKey: string) => `relation-pending:${candidateKey}`

/** 作者一直没决定时每章的说法都会留一条建议，这里每对人物只提示本章之前最新的一条。pending 按章升序。 */
export function findUndecidedRelations(blueprint: BlueprintForPreflight, pending: readonly PendingFinalizedRelationCandidate[]): ConsistencyFinding[] {
  const cast = new Set(blueprint.characters.map(characterRosterIdentityKey))
  const latest = new Map<string, PendingFinalizedRelationCandidate>()
  for (const candidate of pending) {
    if (candidate.source.chapterNumber >= blueprint.chapterNumber) continue
    if (cast.has(characterRosterIdentityKey(candidate.sourceName)) && cast.has(characterRosterIdentityKey(candidate.targetName)))
      latest.set(JSON.stringify([candidate.sourceId, candidate.targetId].sort()), candidate)
  }
  return [...latest.values()].map(candidate => {
    const { sourceName, targetName, value, source: { chapterNumber } } = candidate
    return {
      stableFactKey: pendingRelationFactKey(candidate.candidateKey),
      severity: 'warning',
      sourceChapter: chapterNumber,
      evidence: candidate.evidence.text,
      issue: {
        zhCN: `你设定${sourceName}和${targetName}是「${candidate.authorRelations.join('、')}」，第 ${chapterNumber} 章定稿写的是「${value}」，还没决定用哪个。`,
        enUS: `You set ${sourceName} and ${targetName} as “${candidate.authorRelations.join(', ')}”, but finalized chapter ${chapterNumber} says “${value}”. You have not decided yet.`,
      },
      suggestion: { zhCN: '到角色页的建议里决定。', enUS: 'Decide in the suggestions on the Cast page.' },
    }
  })
}
