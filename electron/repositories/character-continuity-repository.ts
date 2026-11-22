import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import type { CharacterApproval } from '../../src/shared/character-identity'
import { withoutRelationRestatements, type CharacterContinuityTimeline, type CharacterStateNode, type ContinuityNode, type ContinuityProvenance, type StateChapterRange } from '../../src/shared/character-continuity'
import { CHARACTER_STATE_TEXT_FIELDS, type CharacterStateTextField } from '../../src/shared/character-roster'
import type { FinalizedCharacterEvidence, FinalizedSourceIdentity } from '../../src/shared/finalized-continuity'

export const CHARACTER_STATE_COLUMNS: Readonly<Record<CharacterStateTextField, string>> = Object.freeze({
  location: 'cs_location', powerLevel: 'cs_power_level', physicalState: 'cs_physical_state',
  mentalState: 'cs_mental_state', keyItems: 'cs_key_items', recentEvents: 'cs_recent_events',
})

export type StateWriteOrigin =
  | { kind: 'author'; operationId: string; effectiveChapter: number }
  | { kind: 'adopted'; operationId: string; source: FinalizedSourceIdentity; quote?: FinalizedCharacterEvidence }
  /** fieldRevision 进节点号：同一份定稿重跑时模型可能给出新值，那是一个新节点，不是重复。 */
  | { kind: 'derived'; source: FinalizedSourceIdentity; quote: FinalizedCharacterEvidence; fieldRevision: number }

export interface CharacterStateWrite {
  characterId: string
  characterName: string
  field: CharacterStateTextField
  value: string
  origin: StateWriteOrigin
}

export interface CharacterRelationshipLine {
  relationshipId: string
  sourceId: string
  sourceName: string
  targetId: string
  targetName: string
}

/** 作者的改动从下一章开始算，下一章指已定稿的最大章之后。 */
function nextChapter(db: BetterSqlite3.Database): number {
  return (db.prepare("SELECT COALESCE(MAX(chapter_number),0) FROM drafts WHERE status='finalized'").pluck().get() as number) + 1
}

export function readStateChapterRange(db: BetterSqlite3.Database): StateChapterRange {
  const next = nextChapter(db)
  const planned = db.prepare('SELECT COALESCE(MAX(chapter_number),0) FROM blueprints').pluck().get() as number
  return { next, last: Math.max(next, planned) }
}

interface NodeWrite {
  eventId: string
  subjectId: string
  subjectName: string
  target: { id: string; name: string } | null
  aspect: ContinuityNode['aspect']
  value: string
  effectiveChapter: number
  provenance: ContinuityProvenance
  draftId: number | null
  evidence: { quote?: FinalizedCharacterEvidence; relationshipId?: string; matchedAuthor?: true }
}

/** 业务写入和节点要一起成败，放在写业务列之前检查。 */
function requireTransaction(db: BetterSqlite3.Database): void {
  if (!db.inTransaction) throw new Error('CHARACTER_CONTINUITY_TRANSACTION_REQUIRED')
}

/** 节点在系列里的章，口径同 parseNode。 */
const SERIES_CHAPTER = `CASE WHEN json_extract(e.provenance_json,'$.kind')='legacy' AND json_extract(e.evidence_json,'$.fieldProvenance.kind')='author'
  AND json_type(e.evidence_json,'$.fieldProvenance.chapterNumber') IN ('integer','real') THEN json_extract(e.evidence_json,'$.fieldProvenance.chapterNumber') ELSE e.effective_chapter END`

function appendNode(db: BetterSqlite3.Database, node: NodeWrite): void {
  const position = `SELECT
      MAX(CASE WHEN e.draft_id IS NULL OR d.status='finalized' THEN ${SERIES_CHAPTER} END) AS chapter,
      COALESCE(MAX(json_extract(e.evidence_json,'$.seq')),0) AS seq
    FROM character_continuity_events e LEFT JOIN drafts d ON d.id=e.draft_id`
  const series = (node.target
    ? db.prepare(`${position} WHERE e.subject_id IN (?,?) AND e.aspect='relation' AND json_extract(e.evidence_json,'$.relationshipId')=?`)
      .get(node.subjectId, node.target.id, node.evidence.relationshipId)
    : db.prepare(`${position} WHERE e.subject_id=? AND e.aspect=? AND e.target_id IS NULL`).get(node.subjectId, node.aspect)) as { chapter: number | null; seq: number }
  // 不早于同系列已有节点：否则按章折叠会读到更早写入的值，与当前列分叉。派生关系没有当前列，按章记。
  const effectiveChapter = node.provenance.kind === 'derived' && node.target ? node.effectiveChapter : Math.max(node.effectiveChapter, series.chapter ?? 0)
  db.prepare(`INSERT INTO character_continuity_events(event_id,subject_id,subject_name,target_id,target_name,aspect,value,effective_chapter,provenance_json,draft_id,evidence_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(node.eventId, node.subjectId, node.subjectName, node.target?.id ?? null, node.target?.name ?? null,
    node.aspect, node.value, effectiveChapter, JSON.stringify(node.provenance), node.draftId, JSON.stringify({ ...node.evidence, seq: series.seq + 1 }))
}

function stateNodePlacement(write: CharacterStateWrite): Pick<NodeWrite, 'eventId' | 'effectiveChapter' | 'provenance' | 'draftId' | 'evidence'> {
  const { origin, characterId, field } = write
  switch (origin.kind) {
    case 'author':
      return { eventId: `author:${origin.operationId}:${characterId}:${field}`, effectiveChapter: origin.effectiveChapter,
        provenance: { kind: 'author', operationId: origin.operationId }, draftId: null, evidence: {} }
    case 'adopted':
      return { eventId: `adopted:${origin.operationId}:${characterId}:${field}`, effectiveChapter: origin.source.chapterNumber,
        provenance: { kind: 'adopted', operationId: origin.operationId, source: origin.source }, draftId: null, evidence: origin.quote ? { quote: origin.quote } : {} }
    case 'derived':
      return { eventId: `derived:${origin.source.finalizationId}:${characterId}:${field}:${origin.fieldRevision}`, effectiveChapter: origin.source.chapterNumber,
        provenance: { kind: 'derived', source: origin.source }, draftId: origin.source.draftId, evidence: { quote: origin.quote } }
  }
}

/** 写 cs_* 值列的唯一入口。返回 false 表示角色已不在名单上，什么也没写。 */
export function writeCharacterStateField(db: BetterSqlite3.Database, write: CharacterStateWrite): boolean {
  requireTransaction(db)
  const updated = db.prepare(`UPDATE characters SET ${CHARACTER_STATE_COLUMNS[write.field]}=? WHERE character_id=? AND retired=0`).run(write.value, write.characterId)
  if (updated.changes !== 1) return false
  appendNode(db, { subjectId: write.characterId, subjectName: write.characterName, target: null, aspect: write.field, value: write.value, ...stateNodePlacement(write) })
  return true
}

const RELATION_ORIGIN: Readonly<Record<CharacterApproval['action'], 'author' | 'adopted'>> = Object.freeze({
  'author-edit': 'author', 'confirm-identity': 'author', 'adopt-generated': 'adopted', 'adopt-import': 'adopted',
})

export function insertCharacterRelationship(db: BetterSqlite3.Database, line: CharacterRelationshipLine & { relation: string; provenanceJson: string },
  approval: Pick<CharacterApproval, 'operationId' | 'action'>, effectiveChapter = nextChapter(db)): void {
  requireTransaction(db)
  db.prepare('INSERT INTO character_relationships VALUES(?,?,?,?,?,?,?,?)').run(line.relationshipId, line.sourceId, line.targetId, line.relation,
    line.sourceName, line.targetName, line.provenanceJson, approval.operationId)
  appendNode(db, { eventId: `relation:add:${line.relationshipId}`, subjectId: line.sourceId, subjectName: line.sourceName, target: { id: line.targetId, name: line.targetName },
    aspect: 'relation', value: line.relation, effectiveChapter, provenance: { kind: RELATION_ORIGIN[approval.action], operationId: approval.operationId },
    draftId: null, evidence: { relationshipId: line.relationshipId } })
}

/** 删除 character_relationships 的唯一入口。节点的值为空，靠 relationshipId 指出删的是哪一行。 */
export function deleteCharacterRelationship(db: BetterSqlite3.Database, line: CharacterRelationshipLine, operationId: string, effectiveChapter = nextChapter(db)): void {
  requireTransaction(db)
  db.prepare('DELETE FROM character_relationships WHERE relationship_id=?').run(line.relationshipId)
  appendNode(db, { eventId: `relation:remove:${line.relationshipId}`, subjectId: line.sourceId, subjectName: line.sourceName, target: { id: line.targetId, name: line.targetName },
    aspect: 'relation', value: '', effectiveChapter, provenance: { kind: 'author', operationId }, draftId: null, evidence: { relationshipId: line.relationshipId } })
}

/** 派生关系与作者关系行分开记，派生值不会盖掉作者设定。 */
export const derivedRelationSeries = (sourceId: string, targetId: string) => `derived:${JSON.stringify([sourceId, targetId].sort())}`

export interface DerivedRelationWrite {
  sourceId: string
  sourceName: string
  targetId: string
  targetName: string
  relation: string
  source: FinalizedSourceIdentity
  quote: FinalizedCharacterEvidence
  matchedAuthor: boolean
}

/** 只进事件表，不碰 character_relationships（ADR-0007）。节点绑定定稿稿，稿被替换后随之失效（ADR-0024、ADR-0025）。 */
export function appendDerivedRelationNode(db: BetterSqlite3.Database, write: DerivedRelationWrite): void {
  requireTransaction(db)
  appendNode(db, { eventId: `derived:${write.source.finalizationId}:relation:${randomUUID()}`, subjectId: write.sourceId, subjectName: write.sourceName,
    target: { id: write.targetId, name: write.targetName }, aspect: 'relation', value: write.relation, effectiveChapter: write.source.chapterNumber,
    provenance: { kind: 'derived', source: write.source }, draftId: write.source.draftId,
    evidence: { quote: write.quote, relationshipId: derivedRelationSeries(write.sourceId, write.targetId), ...(write.matchedAuthor && { matchedAuthor: true as const }) } })
}

interface NodeRow {
  event_id: string; subject_id: string; subject_name: string; target_id: string | null; target_name: string | null
  aspect: string; value: string; effective_chapter: number; provenance_json: string; draft_id: number | null; evidence_json: string
}

function parseNode(row: NodeRow): ContinuityNode {
  const evidence = JSON.parse(row.evidence_json) as { seq?: number; quote?: FinalizedCharacterEvidence; relationshipId?: string; matchedAuthor?: boolean
    fieldProvenance?: { kind?: string; chapterNumber?: number } | null }
  const stored = JSON.parse(row.provenance_json) as ContinuityProvenance
  const provenance: ContinuityProvenance = stored.kind === 'legacy' && evidence.fieldProvenance?.kind === 'author' && typeof evidence.fieldProvenance.chapterNumber === 'number'
    ? { kind: 'legacy', authorChapter: evidence.fieldProvenance.chapterNumber } : stored
  // M08 记的是升级时的快照章；升级前作者填的状态从当时记下的章起排，与 appendNode 的 SERIES_CHAPTER 一致。
  const effectiveChapter = provenance.kind === 'legacy' && provenance.authorChapter !== undefined ? provenance.authorChapter : row.effective_chapter
  const base = { eventId: row.event_id, subjectId: row.subject_id, subjectName: row.subject_name, value: row.value, effectiveChapter,
    provenance, draftId: row.draft_id, seq: evidence.seq ?? 0, quote: evidence.quote ?? null }
  return row.target_id === null
    ? { ...base, aspect: row.aspect as CharacterStateTextField }
    : { ...base, aspect: 'relation', targetId: row.target_id, targetName: row.target_name!, relationshipId: evidence.relationshipId ?? row.event_id,
      ...(evidence.matchedAuthor === true && { matchedAuthor: true as const }) }
}

/**
 * 读有效节点，喂给 latestNodesBefore。挂稿的节点要求稿仍是定稿，被替换和进回收站的稿不再算数。
 * 退休角色不产生删除节点，这里统一排除，迁移基线里早已退休的角色也一并覆盖。
 * characterIds 筛主语或关系对象的节点，null 不筛。
 */
export function readCharacterContinuityNodes(db: BetterSqlite3.Database, characterIds: readonly string[] | null = null): ContinuityNode[] {
  return (db.prepare(`SELECT e.* FROM character_continuity_events e LEFT JOIN drafts d ON d.id=e.draft_id
    WHERE (e.draft_id IS NULL OR d.status='finalized')
      AND (@ids IS NULL OR e.subject_id IN (SELECT value FROM json_each(@ids)) OR e.target_id IN (SELECT value FROM json_each(@ids)))
      AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.retired=1 AND c.character_id IN (e.subject_id,e.target_id))
    ORDER BY e.subject_id,e.aspect,e.effective_chapter,e.event_id`).all({ ids: characterIds && JSON.stringify(characterIds) }) as NodeRow[]).map(parseNode)
}

/** 只读在册角色的状态节点，不连带关系事件：审修每次捕获都要读，按 subject、aspect 走索引。 */
export function readCharacterStateNodes(db: BetterSqlite3.Database, activeCharacterIds: readonly string[]): CharacterStateNode[] {
  return (db.prepare(`SELECT e.* FROM character_continuity_events e LEFT JOIN drafts d ON d.id=e.draft_id
    WHERE e.subject_id IN (SELECT value FROM json_each(?)) AND e.aspect IN (SELECT value FROM json_each(?)) AND (e.draft_id IS NULL OR d.status='finalized')`)
    .all(JSON.stringify(activeCharacterIds), JSON.stringify(CHARACTER_STATE_TEXT_FIELDS)) as NodeRow[]).map(parseNode) as CharacterStateNode[]
}

/** 节点里的名字是写入时的快照，改名后对不上蓝图。给预检用的读取换成角色现在的名字。 */
export function readContinuityNodesWithCurrentNames(db: BetterSqlite3.Database): ContinuityNode[] {
  const names = new Map((db.prepare('SELECT character_id,name FROM characters').all() as { character_id: string; name: string }[])
    .map(row => [row.character_id, row.name]))
  return readCharacterContinuityNodes(db).map(node => ({
    ...node,
    subjectName: names.get(node.subjectId) ?? node.subjectName,
    ...(node.aspect === 'relation' ? { targetName: names.get(node.targetId) ?? node.targetName } : {}),
  }))
}

export function readCharacterContinuityTimeline(db: BetterSqlite3.Database, characterId: string): CharacterContinuityTimeline {
  const nodes = withoutRelationRestatements(readCharacterContinuityNodes(db, [characterId])).filter(node => node.subjectId === characterId)
  return { nodes, chapterRange: readStateChapterRange(db) }
}
