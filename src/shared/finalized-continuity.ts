import { CHARACTER_STATE_TEXT_FIELDS, type CharacterStateTextField } from './character-roster'
import { decideDerivedPatch, type CharacterFieldSnapshot, type DerivedSourceOrder } from './character-identity'
import { isFinalizedSourceIdentity, type ProjectEpoch } from './source-ref'
import type { WritingLanguage } from './writing-language'

export type FinalizedContinuityFactCategory =
  | 'character-state'
  | 'timeline'
  | 'open-thread'
  | 'plot'

/** Existing finalization receipt fields needed to bind derived material to immutable prose. */
export interface FinalizedSourceIdentity {
  draftId: number
  finalizationId: string
  chapterNumber: number
  contentHash: string
}

export type FinalizedProjectionStatus = 'current' | 'stale' | 'legacy'

export interface FinalizedSourceSnapshot {
  source: FinalizedSourceIdentity
  chapterTitle: string
  content: string
  /** Project continuity watermark frozen before semantic extraction starts. */
  projectionGeneration: number
}

export type FinalizedSourceReadResult =
  | { status: 'valid'; snapshot: FinalizedSourceSnapshot }
  | {
      status: 'legacy'
      draftId: number
      chapterNumber: number
      chapterTitle: string
      content: string
    }
  | { status: 'invalid' }

export interface FinalizedContinuityFact {
  category: FinalizedContinuityFactCategory
  entities: string[]
  statement: string
  sourceChapter: number
  evidence: string
  /** Display labels remain readable; only these proven IDs are identity references. */
  characterRefs?: FinalizedCharacterReference[]
}

export interface FinalizedCharacterReference {
  characterId: string
  displayNameSnapshot: string
}

/** A machine-derived locator only; it never becomes an author-confirmed fact. */
export interface FinalizedCharacterStateCandidate {
  /** Absent only on preserved legacy locators, never sufficient for a new write. */
  characterId?: string
  characterName: string
  field: CharacterStateTextField
  value: string
  evidence?: FinalizedCharacterEvidence
  selectionKey?: string
  displayName?: string
  rawValue?: unknown
  reason?: 'author-protected' | 'legacy-protected'
  /** Present on current source-bound decisions; omitted only by preserved legacy rows. */
  candidateKey?: string
  source?: FinalizedSourceIdentity
  expectedFieldRevision?: number
  expectedFieldValueHash?: string
}

export interface PendingFinalizedCharacterStateCandidate extends FinalizedCharacterStateCandidate {
  candidateKey: string
  characterId: string
  source: FinalizedSourceIdentity
  expectedFieldRevision: number
  expectedFieldValueHash: string
}

export interface PendingFinalizedCharacterStateCandidateSummary {
  draftId: number
  candidateKey: string
  finalizationId: string
  characterId: string
  characterName: string
  field: CharacterStateTextField
}

export interface FinalizedCharacterStateDecisionRequest {
  draftId: number
  candidateKey: string
  characterId: string
  field: CharacterStateTextField
  expectedFieldRevision: number
  expectedFieldValueHash: string
  operationId: string
  decision: 'accept' | 'decline'
}

export interface FinalizedCharacterStateDecisionReceipt {
  candidateKey: string
  operationId: string
  payloadHash: string
  decision: 'accept' | 'decline'
  source: FinalizedSourceIdentity
  idempotent: boolean
}

/** Offsets count JS UTF-16 code units in the immutable, unnormalized prose. */
export interface FinalizedCharacterEvidence { start: number; end: number; text: string }
export interface FinalizedCharacterContext extends ProjectEpoch {
  source: FinalizedSourceIdentity
  content: string
  projectionGeneration: number
  identityRevision: number
  identityStatus: 'bound' | 'legacy'
  sourceOrder: DerivedSourceOrder
  characters: Array<FinalizedCharacterReference & {
    aliases: string[]
    fields: CharacterFieldSnapshot[]
  }>
  /** 只用来告诉模型作者已有的关系，不参与身份比较。升级前冻结的在途定稿没有这个字段。 */
  authorRelations?: FinalizedAuthorRelation[]
  /** 读 authorRelations 那一刻的身份修订号，同样不参与身份比较。 */
  authorRelationsRevision?: number
}
export interface FinalizedAuthorRelation { sourceId: string; targetId: string; targetName: string; relation: string }
function fromReplacedFinal(context: FinalizedCharacterContext, characterId: string, field: CharacterFieldSnapshot, originProjectId?: string): boolean {
  const previous = field.sourceOrder
  // chapterNumber identifies the chapter within the verified project lineage; draft IDs identify versions, not chapters.
  return field.characterId === characterId && field.provenance.kind === 'derived'
    && typeof field.provenance.source?.finalizationId === 'string' && isFinalizedSourceIdentity(field.provenance.source)
    && field.provenance.source.chapterNumber === context.source.chapterNumber
    && field.provenance.source.finalizationId !== context.source.finalizationId
    && !!previous && previous.authoritativeFinalizationRevision < context.sourceOrder.authoritativeFinalizationRevision
    && decideDerivedPatch(field, { ...field, projectId: context.projectId, epoch: context.epoch,
      baseFieldRevision: field.revision, baseValueHash: field.valueHash, baseProvenance: field.provenance,
      source: context.source, sourceOrder: context.sourceOrder }, { source: context.source, order: context.sourceOrder, originProjectId, laterOwnerAuthoritative: true }) === 'apply-derived'
}
/** Render only: the original fields remain the CAS baseline. originProjectId must be main-verified transfer authority. */
export function finalizedCharacterPromptCards(context: FinalizedCharacterContext, originProjectId?: string) {
  return context.characters.map(character => {
    const relationships = context.authorRelations?.filter(item => item.sourceId === character.characterId)
      .map(item => ({ targetId: item.targetId, target: item.targetName, relation: item.relation })) ?? []
    return { characterId: character.characterId, name: character.displayNameSnapshot, aliases: character.aliases,
      fields: character.fields.filter(field => !(field.field === 'recentEvents' && fromReplacedFinal(context, character.characterId, field, originProjectId)))
        .map(field => ({ field: field.field, value: field.value, provenance: field.provenance })),
      ...(relationships.length ? { relationships } : {}) }
  })
}
export function replacedFinalFields(context: FinalizedCharacterContext, originProjectId?: string) {
  return context.characters.flatMap(character => {
    const fields = character.fields.filter(field => fromReplacedFinal(context, character.characterId, field, originProjectId)).map(field => field.field)
    return fields.length ? [{ characterId: character.characterId, name: character.displayNameSnapshot, fields }] : []
  })
}
export type FinalizedCharacterStateValues = Partial<Record<CharacterStateTextField, string>>
export interface FinalizedCharacterStateUpdate {
  characterId: string
  currentState: FinalizedCharacterStateValues
  evidence: FinalizedCharacterEvidence
}
/** A model occurrence requiring an explicit identity decision, never an automatic merge. */
export interface FinalizedCharacterStateOccurrence {
  selectionKey: string
  displayName: string
  originalText: string
  candidateIds: string[]
  currentState: FinalizedCharacterStateValues
  evidence: FinalizedCharacterEvidence
  rawValue: unknown
  reason: 'name-only' | 'unknown-id' | 'ambiguous' | 'legacy'
}
/** 模型报告的一条关系变化，角色身份和原文都已校验。 */
export interface FinalizedRelationChange {
  sourceId: string
  targetId: string
  relation: string
  evidence: FinalizedCharacterEvidence
}
export interface FinalizedCharacterStateResponse {
  updates: FinalizedCharacterStateUpdate[]
  unresolved: FinalizedCharacterStateOccurrence[]
  relations: FinalizedRelationChange[]
}
/** 派生关系与作者设定不一致时留给作者的待确认项，存在 summary_snapshots.character_state_candidates 里。 */
export interface FinalizedRelationCandidate {
  candidateKey: string
  source: FinalizedSourceIdentity
  sourceId: string
  sourceName: string
  targetId: string
  targetName: string
  value: string
  evidence: FinalizedCharacterEvidence
  /** 建议创建时这对人物两个方向的作者行，每项是 [来源, 目标, 关系] 的 JSON，已排序。升级前写的候选没有这个字段。 */
  authorLinesAtCreation?: string[]
  /** 读 authorLinesAtCreation 时的身份修订号。之后的采纳收据修订号更大。升级前写的候选没有这个字段。 */
  authorRevisionAtCreation?: number
}
export interface PendingFinalizedRelationCandidate extends FinalizedRelationCandidate {
  /** 列出时现读，作者后来改过就是改后的值。 */
  authorRelations: string[]
}
export interface FinalizedRelationDecisionRequest {
  draftId: number
  candidateKey: string
  expectedAuthorRelations: string[]
  operationId: string
  decision: 'accept' | 'decline'
}
export interface FinalizedCharacterStateCommitReceipt {
  applied: number
  unchanged: number
  candidates: FinalizedCharacterStateCandidate[]
}

export class FinalizedCharacterEvidenceError extends Error {
  constructor(code: 'FINALIZED_CHARACTER_EVIDENCE_MISSING' | 'FINALIZED_CHARACTER_EVIDENCE_NOT_UNIQUE' | 'FINALIZED_CHARACTER_EVIDENCE_INVALID',
    readonly updateIndex: number,
    readonly reason: 'missing' | 'no-exact-match' | 'multiple-exact-matches' | 'offset-mismatch') { super(code) }
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

type EvidenceFailure = 'no-exact-match' | 'multiple-exact-matches' | 'offset-mismatch'
function locateEvidence(evidence: Record<string, unknown>, content: string): FinalizedCharacterEvidence | EvidenceFailure {
  let start = evidence.start, end = evidence.end
  if (!Object.hasOwn(evidence, 'start') && !Object.hasOwn(evidence, 'end') && typeof evidence.text === 'string' && evidence.text.length > 0) {
    const located = content.indexOf(evidence.text)
    if (located < 0) return 'no-exact-match'
    if (content.indexOf(evidence.text, located + 1) !== -1) return 'multiple-exact-matches'
    start = located; end = located + evidence.text.length
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0
    || (end as number) <= (start as number) || (end as number) > content.length
    || typeof evidence.text !== 'string' || content.slice(start as number, end as number) !== evidence.text) return 'offset-mismatch'
  return { start: start as number, end: end as number, text: evidence.text }
}

const EVIDENCE_FAILURE_CODE = { 'no-exact-match': 'FINALIZED_CHARACTER_EVIDENCE_NOT_UNIQUE', 'multiple-exact-matches': 'FINALIZED_CHARACTER_EVIDENCE_NOT_UNIQUE',
  'offset-mismatch': 'FINALIZED_CHARACTER_EVIDENCE_INVALID' } as const

/** relations 是附带产物：不合格的条目丢掉，绝不让它挡住状态更新或触发重新生成。 */
function parseRelationChanges(input: unknown, context: FinalizedCharacterContext): FinalizedRelationChange[] {
  if (!Array.isArray(input) || context.identityStatus !== 'bound') return []
  const resolve = (ref: unknown) => {
    if (typeof ref !== 'string' || !ref) return undefined
    const byId = context.characters.find(item => item.characterId === ref)
    const named = byId ? [byId] : context.characters.filter(item => item.displayNameSnapshot === ref || item.aliases.includes(ref))
    return named.length === 1 && context.characters.filter(item => item.displayNameSnapshot === named[0].displayNameSnapshot).length === 1 ? named[0] : undefined
  }
  const byPair = new Map<string, FinalizedRelationChange>()
  for (const item of input) {
    if (!record(item) || !record(item.evidence)) continue
    const source = resolve(item.source), target = resolve(item.target)
    const relation = typeof item.relation === 'string' ? item.relation.trim() : ''
    const evidence = locateEvidence(item.evidence, context.content)
    if (!source || !target || source === target || !relation || relation.length > 80 || typeof evidence === 'string') continue
    byPair.set(JSON.stringify([source.characterId, target.characterId]), { sourceId: source.characterId, targetId: target.characterId, relation, evidence })
  }
  return [...byPair.values()]
}

/** Main re-parses the settled artifact with its own frozen context before domain commit. */
export function parseFinalizedCharacterStateResponse(content: string, context: FinalizedCharacterContext): FinalizedCharacterStateResponse {
  const text = content.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '')
  const parsed: unknown = JSON.parse(text)
  if (!record(parsed) || !Array.isArray(parsed.updates) || parsed.updates.length > 1_000) throw new Error('FINALIZED_CHARACTER_UPDATES_INVALID')
  const result: FinalizedCharacterStateResponse = { updates: [], unresolved: [], relations: parseRelationChanges(parsed.relations, context) }
  const seen = new Set<string>()
  for (const [index, input] of parsed.updates.entries()) {
    if (!record(input) || !record(input.currentState)) throw new Error('FINALIZED_CHARACTER_UPDATE_INVALID')
    // A distinct code lets the repair turn name the missing field instead of offering only the empty exit.
    if (!record(input.evidence)) throw new FinalizedCharacterEvidenceError('FINALIZED_CHARACTER_EVIDENCE_MISSING', index, 'missing')
    const exactEvidence = locateEvidence(input.evidence, context.content)
    if (typeof exactEvidence === 'string') throw new FinalizedCharacterEvidenceError(EVIDENCE_FAILURE_CODE[exactEvidence], index, exactEvidence)
    const currentState: FinalizedCharacterStateValues = {}
    for (const field of CHARACTER_STATE_TEXT_FIELDS) {
      if (!Object.hasOwn(input.currentState, field)) continue
      if (typeof input.currentState[field] !== 'string') throw new Error('FINALIZED_CHARACTER_FIELD_INVALID')
      currentState[field] = input.currentState[field]
    }
    if (!Object.keys(currentState).length || Object.hasOwn(input.currentState, 'updatedAtChapter') && input.currentState.updatedAtChapter !== context.source.chapterNumber) {
      throw new Error('FINALIZED_CHARACTER_FIELD_INVALID')
    }
    const characterId = typeof input.characterId === 'string' ? input.characterId : ''
    const originalText = typeof input.name === 'string' ? input.name : ''
    const character = context.identityStatus === 'bound' ? context.characters.find(item => item.characterId === characterId) : undefined
    // Even an explicit model ID cannot disambiguate two source characters with
    // the same frozen display label. Preserve the occurrence for author approval.
    const sharedLabel = character && context.characters.filter(item => item.displayNameSnapshot === character.displayNameSnapshot).length > 1
    if (!character || sharedLabel) {
      if (!originalText.trim() && !characterId) throw new Error('FINALIZED_CHARACTER_IDENTITY_REQUIRED')
      result.unresolved.push({ selectionKey: `update:${index}`, displayName: originalText.trim() ? originalText : character?.displayNameSnapshot ?? originalText, originalText,
        candidateIds: context.characters.filter(item => item.characterId === characterId || sharedLabel && item.displayNameSnapshot === character?.displayNameSnapshot
          || item.displayNameSnapshot === originalText || item.aliases.includes(originalText)).map(item => item.characterId),
        currentState, evidence: exactEvidence, rawValue: structuredClone(input),
        reason: context.identityStatus === 'legacy' ? 'legacy' : sharedLabel ? 'ambiguous' : characterId ? 'unknown-id' : 'name-only' })
      continue
    }
    if (seen.has(characterId)) throw new Error('FINALIZED_CHARACTER_DUPLICATE_ID')
    seen.add(characterId)
    result.updates.push({ characterId, currentState, evidence: exactEvidence })
  }
  return result
}

const STATE_OUTPUT_CONTRACT = {
  'en-US': '[Final output contract: this overrides the [JSON output contract] above] Do not copy that example: its newCharacters list and full-field layout do not apply. A person with an existing character card must use that card\'s exact characterId, and every update must include evidence. Every update must include recentEvents (this character\'s latest state at the end of the chapter, within 50 words). The recentEvents of each update states the latest state of this character at the end of the chapter: when later prose corrects, withdraws, or postpones an earlier plan, follow the last correction and prioritize that correction and its current conditions over a more prominent earlier event; do not write the superseded plan or describe a still-pending plan as executed. Without a correction, retain this character\'s relevant event or still-pending plan. Do not apply another character\'s change of plan to this character; evidence quotes the one sentence that directly supports that latest state. List other fields only when the value differs from the existing card and matches the field (location is only the place the chapter prose explicitly states the character is currently in, never an event or progress; when the prose only states a plan, a decision, or an intention to go somewhere, the character is still where they were and must not be written as en route or arrived; when the prose states no clear change of place, do not list location). Return one JSON object: {"updates":[{"characterId":"exact ID from the frozen list","currentState":{"recentEvents":"this chapter\'s event","location":"new place"},"evidence":{"text":"exact source quote"}}]}. Copy a quote that occurs exactly once in the unmodified chapter; its offsets will be calculated. If you supply start/end, they must be exact JS UTF-16 offsets. evidence.text must be one contiguous, verbatim span of the frozen chapter that occurs exactly once; never join sentences across paragraphs or blank lines, and do not alter punctuation or whitespace. If unsure of the position, omit start/end and let the program calculate them. Only supplied dynamic fields are proposed. Do not infer identity from a name. Unknown or ambiguous people use name without characterId and remain proposals. Do not return static character facts or author provenance.',
  'zh-CN': '【最终输出合同，覆盖上文【输出格式（JSON）】】不得照抄上文示例：其中的 newCharacters 与全字段写法不适用；现有角色卡中的人物必须使用其精确 characterId，每个 update 都必须含 evidence；每个 update 必须填写 recentEvents（本章结束时该角色的最新状态，50字以内）；每个 update 的 recentEvents 写本章结束时该角色的最新状态：正文后文更正、撤回或推迟了前文安排时，以最后的更正为准，优先保留该更正及当前条件，不得被更显著的旧事件挤掉；不写已被更正的旧安排，也不把仍待执行的计划写成已执行。没有更正时，保留该角色有关事件或仍待执行的安排；不得将其他角色的安排变化套到该角色；evidence 引用直接支持该最新状态的一句。其余字段只在值与现有角色卡不同且名实相符时列出（location 只写正文明确写出的人物当前所在地点，不写事件或进度；正文只写了计划、决定或打算前往某处时，人物仍在原处，不得写成“前往途中”“已到达”；正文没有明确写出地点变化时不要列出 location）。只返回一个 JSON 对象：{"updates":[{"characterId":"冻结名单中的精确ID","currentState":{"recentEvents":"本章事件","location":"新地点"},"evidence":{"text":"原文精确引用"}}]}。引用必须在未改写正文中仅出现一次，位置由程序精确计算；若提供 start/end，必须是准确的 JS UTF-16 位置。evidence.text 必须是冻结正文中单一连续、逐字、只出现一次的片段；不得跨段落或空行拼接多句，不得删改标点或空白；不确定位置时省略 start/end，由程序计算。只提议明确返回的动态字段；不可凭名字推断身份。未知或歧义人物只返回 name、不填 characterId，保留为待确认提议。不得输出静态角色事实或作者来源。',
} as const
const RELATION_OUTPUT_CONTRACT = {
  'en-US': 'Also add a relations array to the same JSON object. List only relationships the prose explicitly shows actually changed in this chapter (allied, broke with, became mentor, fell in love, reconciled). Format: {"updates":[...],"relations":[{"source":"characterId of the character","target":"characterId of the other character","relation":"the relationship after the change, within 6 words","evidence":{"text":"exact source quote"}}]}. relationships on each existing card are what the author has set; do not list one this chapter leaves unchanged, and do not list people merely sharing a scene, talking, or cooperating once. source and target must both be characterIds from the frozen list; leave out anyone not on it. The evidence rules above apply. If no relationship changed, return "relations":[].',
  'zh-CN': '另外，在同一个 JSON 对象里加 relations 数组，只写本章正文明确写出、确实发生变化的人物关系（结盟、决裂、拜师、定情、反目、和解等）。格式：{"updates":[...],"relations":[{"source":"角色的 characterId","target":"对方的 characterId","relation":"变化后的关系，12字以内","evidence":{"text":"原文精确引用"}}]}。现有角色卡的 relationships 是作者写好的关系；本章没有改变它的不要写，只是同场出现、交谈、合作一次也不要写。source 和 target 都必须是冻结名单中的 characterId，名单外的人物不要写。evidence 规则同上。本章没有关系变化时写 "relations":[]。',
} as const
export function finalizedCharacterOutputContract(language: WritingLanguage): string {
  const key = language === 'en-US' ? 'en-US' : 'zh-CN'
  return `${STATE_OUTPUT_CONTRACT[key]} ${RELATION_OUTPUT_CONTRACT[key]}`
}

export interface FinalizedContinuityProjection {
  draftId: number
  /** Current finalized prose to read when this derived locator is stale. */
  currentFinalizedDraftId?: number
  chapterNumber: number
  chapterTitle: string
  chapterNotes: string
  facts?: FinalizedContinuityFact[]
  /** Used only to locate the bound finalized prose, never rendered as a fact. */
  characterStateCandidates?: FinalizedCharacterStateCandidate[]
  /** Missing only for pre-v2 rows whose source cannot be safely reconstructed. */
  source?: FinalizedSourceIdentity
  /** Missing legacy callers must be treated exactly like `legacy`, never current. */
  sourceStatus?: FinalizedProjectionStatus
}

export interface SaveFinalizedContinuityRequest {
  draftId: number
  chapterNumber: number
  chapterNotes: string
  facts?: FinalizedContinuityFact[]
  /** Watermark frozen before extraction; stale in-flight results must not advance it. */
  projectionGeneration: number
  /** Frozen before extraction; the main process revalidates it at commit time. */
  source: FinalizedSourceIdentity
}

export interface SaveFinalizedCharacterStateCandidatesRequest {
  draftId: number
  chapterNumber: number
  candidates: FinalizedCharacterStateCandidate[]
  /** Watermark frozen before extraction; stale in-flight results must not advance it. */
  projectionGeneration: number
  /** Frozen before extraction; the main process revalidates it at commit time. */
  source: FinalizedSourceIdentity
}
