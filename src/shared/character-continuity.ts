import { CHARACTER_STATE_TEXT_FIELDS, type CharacterStateTextField } from './character-roster'
import type { FinalizedCharacterEvidence, FinalizedSourceIdentity } from './finalized-continuity'

export type ContinuityProvenance =
  | { kind: 'author'; operationId: string }
  | { kind: 'derived'; source: FinalizedSourceIdentity }
  | { kind: 'adopted'; operationId: string; source?: FinalizedSourceIdentity }
  | { kind: 'legacy'; authorChapter?: number }

interface ContinuityNodeBase {
  eventId: string
  subjectId: string
  subjectName: string
  value: string
  effectiveChapter: number
  provenance: ContinuityProvenance
  draftId: number | null
  seq: number
  quote: FinalizedCharacterEvidence | null
}
export interface CharacterStateNode extends ContinuityNodeBase { aspect: CharacterStateTextField }
export interface CharacterRelationNode extends ContinuityNodeBase {
  aspect: 'relation'
  targetId: string
  targetName: string
  relationshipId: string
  authorDeclined?: true
  matchedAuthor?: true
}
export type ContinuityNode = CharacterStateNode | CharacterRelationNode

export interface CharacterRelationPair {
  lines: CharacterRelationNode[]
  conflict: boolean
}
export interface LatestContinuityNodes {
  states: CharacterStateNode[]
  relations: CharacterRelationPair[]
}

const authorDecided = (provenance: ContinuityProvenance) => provenance.kind === 'author' || provenance.kind === 'adopted'

export function firstVisibleChapter(node: ContinuityNode): number {
  if (node.provenance.kind === 'legacy' && node.provenance.authorChapter !== undefined) return node.provenance.authorChapter
  return authorDecided(node.provenance) ? node.effectiveChapter : node.effectiveChapter + 1
}

function newer(candidate: ContinuityNode, current: ContinuityNode): boolean {
  if (candidate.effectiveChapter !== current.effectiveChapter) return candidate.effectiveChapter > current.effectiveChapter
  const [left, right] = [authorDecided(candidate.provenance), authorDecided(current.provenance)]
  return left !== right ? left : candidate.seq > current.seq
}

const seriesKey = (node: ContinuityNode) =>
  node.aspect === 'relation' ? `relation:${node.relationshipId}` : `state:${JSON.stringify([node.subjectId, node.aspect])}`

const hasConflict = (lines: readonly CharacterRelationNode[]) => lines.some((left, index) => lines.slice(index + 1).some(right => left.value !== right.value
  && (left.subjectId === right.subjectId || left.provenance.kind === 'derived' || right.provenance.kind === 'derived')))

const isDerivedRelation = (node: ContinuityNode): node is CharacterRelationNode => node.aspect === 'relation' && node.provenance.kind === 'derived'
const pairKey = (node: CharacterRelationNode) => JSON.stringify([node.subjectId, node.targetId].sort())
const withoutAuthorRepeats = (lines: readonly CharacterRelationNode[]) =>
  lines.filter(line => line.provenance.kind !== 'derived' || !lines.some(other => other.provenance.kind !== 'derived' && other.value === line.value))

const sameStatement = (left: CharacterRelationNode, right: CharacterRelationNode) => left.value === right.value && left.subjectId === right.subjectId

export interface DerivedRelationRun {
  head: CharacterRelationNode
  observations: CharacterRelationNode[]
  declined: boolean
}

const authorMovedOn = (head: CharacterRelationNode, settingsInForce: readonly ContinuityNode[]) => !!head.matchedAuthor
  && settingsInForce.some(node => node.aspect === 'relation' && node.value !== '' && authorDecided(node.provenance) && pairKey(node) === pairKey(head)
    && node.effectiveChapter > head.effectiveChapter)

export function derivedRelationRuns(nodes: readonly ContinuityNode[]): Map<string, DerivedRelationRun[]> {
  const chapters = new Map<string, Map<number, CharacterRelationNode>>()
  for (const node of nodes) {
    if (!isDerivedRelation(node)) continue
    const series = chapters.get(node.relationshipId) ?? new Map<number, CharacterRelationNode>()
    const current = series.get(node.effectiveChapter)
    if (!current || node.seq > current.seq) series.set(node.effectiveChapter, node)
    chapters.set(node.relationshipId, series)
  }
  return new Map([...chapters].map(([key, series]) => {
    const runs: DerivedRelationRun[] = []
    for (const node of [...series.values()].sort((left, right) => left.effectiveChapter - right.effectiveChapter)) {
      const run = runs.at(-1)
      if (run && sameStatement(run.head, node) && run.head.matchedAuthor === node.matchedAuthor) {
        run.observations.push(node)
        run.declined ||= !!node.authorDeclined
      } else runs.push({ head: node, observations: [node], declined: !!node.authorDeclined })
    }
    return [key, runs]
  }))
}

export function latestNodesBefore(nodes: readonly ContinuityNode[], chapter: number, ids?: readonly string[]): LatestContinuityNodes {
  const wanted = ids && new Set(ids)
  const latest = new Map<string, ContinuityNode>()
  for (const node of nodes) {
    if (isDerivedRelation(node) || firstVisibleChapter(node) > chapter) continue
    const key = seriesKey(node), current = latest.get(key)
    if (!current || newer(node, current)) latest.set(key, node)
  }
  const settings = [...latest.values()], inForce = [...settings]
  for (const runs of derivedRelationRuns(nodes).values()) {
    const run = runs.filter(candidate => firstVisibleChapter(candidate.head) <= chapter).at(-1)
    if (run && !run.declined && !authorMovedOn(run.head, settings)) inForce.push(run.head)
  }
  const states: CharacterStateNode[] = []
  const pairs = new Map<string, CharacterRelationNode[]>()
  for (const node of inForce) {
    if (node.value === '') continue
    if (node.aspect !== 'relation') { if (!wanted || wanted.has(node.subjectId)) states.push(node); continue }
    pairs.set(pairKey(node), [...pairs.get(pairKey(node)) ?? [], node])
  }
  const relations = [...pairs.values()].flatMap(all => {
    const lines = withoutAuthorRepeats(wanted ? all.filter(line => wanted.has(line.subjectId)) : all)
    return lines.length ? [{ lines, conflict: hasConflict(withoutAuthorRepeats(all)) }] : []
  })
  return { states, relations }
}

export interface StateChapterRange { next: number; last: number }

export interface CharacterContinuityTimeline {
  nodes: ContinuityNode[]
  chapterRange: StateChapterRange
}

export function resolveStateEffectiveChapter(requested: unknown, range: StateChapterRange): number {
  const legal = typeof requested === 'number' && Number.isSafeInteger(requested) && requested >= 1 && requested <= range.last
  return legal ? requested : range.next
}

export type CharacterTimelineSource = 'author' | 'finalized' | 'legacy'

const TIMELINE_SOURCE: Readonly<Record<ContinuityProvenance['kind'], CharacterTimelineSource>> = Object.freeze({
  author: 'author', adopted: 'author', derived: 'finalized', legacy: 'legacy',
})

export interface CharacterTimelineChange {
  node: ContinuityNode
  source: CharacterTimelineSource
  removed: boolean
  value: string
  replaced?: string[]
}
export interface CharacterTimelineChapter { chapter: number; changes: CharacterTimelineChange[] }

const aspectRank = (node: ContinuityNode) => node.aspect === 'relation' ? CHARACTER_STATE_TEXT_FIELDS.length : CHARACTER_STATE_TEXT_FIELDS.indexOf(node.aspect)
const targetOf = (node: ContinuityNode) => node.aspect === 'relation' ? node.targetName : ''

function foldAdoptedRelations(changes: readonly CharacterTimelineChange[]): CharacterTimelineChange[] {
  const absorbed = new Set<CharacterTimelineChange>()
  const folded = changes.map(change => {
    const { node } = change
    if (node.aspect !== 'relation' || node.provenance.kind !== 'author' || change.removed) return change
    const { operationId } = node.provenance
    const samePair = (other: CharacterTimelineChange) => other.node.aspect === 'relation' && other.node.subjectId === node.subjectId && other.node.targetId === node.targetId
    const found = changes.find(other => samePair(other) && other.source === 'finalized' && other.value === change.value)
    const replaced = changes.filter(other => samePair(other) && other.removed && other.node.provenance.kind === 'author' && other.node.provenance.operationId === operationId)
    if (!found || !replaced.length) return change
    for (const other of [found, ...replaced]) absorbed.add(other)
    return { ...change, node: { ...node, quote: found.node.quote }, replaced: replaced.map(other => other.value) }
  })
  return folded.filter(change => !absorbed.has(change))
}

export function withoutRelationRestatements(nodes: readonly ContinuityNode[]): ContinuityNode[] {
  const settings = nodes.filter(node => !isDerivedRelation(node))
  const changes = new Set<ContinuityNode>()
  for (const runs of derivedRelationRuns(nodes).values()) runs.forEach(({ head }, index) => {
    const previous = runs[index - 1]?.head
    const restated = head.matchedAuthor ? !previous || !!previous.matchedAuthor || sameStatement(previous, head)
      : previous ? sameStatement(previous, head) && !previous.matchedAuthor
        : latestNodesBefore(settings.filter(node => node.effectiveChapter < head.effectiveChapter), head.effectiveChapter).relations
          .some(pair => pair.lines.some(line => pairKey(line) === pairKey(head) && line.value === head.value))
    if (!restated) changes.add(head)
  })
  return nodes.filter(node => !isDerivedRelation(node) || changes.has(node))
}

export function characterTimeline(nodes: readonly ContinuityNode[]): CharacterTimelineChapter[] {
  const series = new Map<string, ContinuityNode[]>()
  for (const node of nodes) {
    const key = seriesKey(node), line = series.get(key)
    if (line) line.push(node)
    else series.set(key, [node])
  }
  const chapters = new Map<number, CharacterTimelineChange[]>()
  for (const line of series.values()) {
    line.sort((left, right) => newer(left, right) ? 1 : newer(right, left) ? -1 : 0)
    let previous = ''
    line.forEach((node, index) => {
      const removed = node.value === ''
      if (line[index + 1]?.effectiveChapter !== node.effectiveChapter) {
        const changes = chapters.get(node.effectiveChapter) ?? []
        changes.push({ node, source: TIMELINE_SOURCE[node.provenance.kind], removed, value: removed ? previous : node.value })
        chapters.set(node.effectiveChapter, changes)
      }
      if (!removed) previous = node.value
    })
  }
  return [...chapters].sort(([left], [right]) => right - left).map(([chapter, changes]) => ({
    chapter,
    changes: foldAdoptedRelations(changes).sort((left, right) => aspectRank(left.node) - aspectRank(right.node)
      || targetOf(left.node).localeCompare(targetOf(right.node)) || Number(right.removed) - Number(left.removed)),
  }))
}
