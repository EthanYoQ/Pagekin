import { findRelationReversals } from './blueprint-relation-conflict'
import { latestNodesBefore, type ContinuityNode, type LatestContinuityNodes } from './character-continuity'
import type { FinalizedContinuityProjection } from './finalized-continuity'

export interface ConsistencyExemption {
  stableFactKey: string
  reason: string
  revoked: boolean
  /** null 表示全书豁免。 */
  chapterNumber: number | null
}

export interface ConsistencyFinding {
  stableFactKey: string
  severity: 'warning'
  sourceChapter: number
  evidence: string
  issue: { zhCN: string; enUS: string }
  suggestion: { zhCN: string; enUS: string }
}

export interface ReviewLike {
  summary?: string
  items?: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface BlueprintForPreflight {
  chapterNumber: number
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: string[]
  suspenseHook: string
  userGuidance: string
  notes: string
  /** 未校验的 JSON，形状和 BlueprintData 的同名字段一致，由规则解析。 */
  relationshipHints?: unknown
}

function normalizedKeyPart(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function isExplicitTerminalSubject(statement: string, entity: string): boolean {
  const subject = escapeRegExp(entity)
  const divider = String.raw`[\s|:：,，、—-]*`
  const chinese = new RegExp(
    `${subject}${divider}(?:(?:已经|已|被确认(?:为)?|被证实(?:为)?)${divider})?(?:死亡|身亡|牺牲|去世)`,
    'u',
  )
  const english = new RegExp(
    String.raw`${subject}[\s|:,-]+(?:(?:is|was|has(?: been)?)\s+)?(?:dead|died|deceased)\b`,
    'iu',
  )
  return chinese.test(statement) || english.test(statement)
}

export function continuityStableFactKey(fact: {
  category: string
  sourceChapter: number
  entities: string[]
  statement: string
}): string {
  const identity = [
    fact.category,
    fact.sourceChapter,
    fact.entities.map(normalizedKeyPart).sort().join(','),
    normalizedKeyPart(fact.statement),
  ].join(':')
  let hash = 0xcbf29ce484222325n
  for (const character of identity) {
    hash ^= BigInt(character.codePointAt(0) ?? 0)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `fact:${hash.toString(16).padStart(16, '0')}`
}

/** 规则只产出 ConsistencyFinding，豁免在规则表外统一处理。 */
interface BlueprintRuleContext {
  blueprint: BlueprintForPreflight
  projections: readonly FinalizedContinuityProjection[]
  continuity: LatestContinuityNodes
}

/** 故意收窄：只有结构化的死亡终态才和「本章出场」冲突。 */
function terminalCharacterScheduled({ blueprint, projections }: BlueprintRuleContext): ConsistencyFinding[] {
  const characters = new Set(blueprint.characters.map(normalizedKeyPart))
  return projections.flatMap(projection => (
    projection.sourceStatus === 'current' ? (projection.facts ?? []) : []
  ).flatMap((fact) => {
    if (fact.category !== 'character-state') return []
    const subject = fact.entities
      .map(normalizedKeyPart)
      .find(entity => characters.has(entity) && isExplicitTerminalSubject(fact.statement, entity))
    if (!subject) return []
    return [{
      stableFactKey: continuityStableFactKey(fact),
      severity: 'warning' as const,
      sourceChapter: fact.sourceChapter,
      evidence: fact.evidence,
      issue: {
        zhCN: `定稿正文绑定的派生索引提示“${subject}”处于死亡终态，但当前蓝图仍将其列为出场角色。请对照原文确认语义。`,
        enUS: `A derived index bound to finalized prose marks “${subject}” as dead, but the current blueprint still schedules the character to appear. Confirm the meaning against the prose.`,
      },
      suggestion: {
        zhCN: '调整蓝图，或说明这是回忆、幻象等刻意安排。',
        enUS: 'Adjust the blueprint, or record an intentional device such as a flashback or vision.',
      },
    }]
  }))
}

const BLUEPRINT_CONTINUITY_RULES: ReadonlyArray<(context: BlueprintRuleContext) => ConsistencyFinding[]> = [
  terminalCharacterScheduled,
  ({ blueprint, continuity }) => findRelationReversals(blueprint, continuity),
]

/** 审稿入口不传 nodes：它的结果冻结在审稿上下文里，恢复时要逐字段相等，升级后不能多出关系提示。 */
export function findBlueprintContinuityRisks(
  projections: readonly FinalizedContinuityProjection[],
  blueprint: BlueprintForPreflight,
  exemptions: readonly ConsistencyExemption[],
  nodes: readonly ContinuityNode[] = [],
): ConsistencyFinding[] {
  const exempted = new Set(exemptions
    .filter(exemption => !exemption.revoked && (exemption.chapterNumber === null || exemption.chapterNumber === blueprint.chapterNumber))
    .map(exemption => exemption.stableFactKey))
  const context = { blueprint, projections, continuity: latestNodesBefore(nodes, blueprint.chapterNumber) }
  return BLUEPRINT_CONTINUITY_RULES.flatMap(rule => rule(context)).filter(finding => !exempted.has(finding.stableFactKey))
}

export function mergeConsistencyFindingsIntoReview(
  review: ReviewLike,
  findings: readonly ConsistencyFinding[],
  locale: 'zh-CN' | 'en-US',
): ReviewLike & { items: Array<Record<string, unknown>> } {
  const mapped = findings.map(finding => ({
    category: locale === 'en-US' ? 'Deterministic continuity preflight' : '确定性一致性预检',
    severity: finding.severity,
    description: locale === 'en-US' ? finding.issue.enUS : finding.issue.zhCN,
    quote: finding.evidence,
    stableFactKey: finding.stableFactKey,
    sourceChapter: finding.sourceChapter,
  }))
  return { ...review, items: [...(Array.isArray(review.items) ? review.items : []), ...mapped] }
}
