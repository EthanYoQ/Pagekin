import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { FinalizationGenerationContext, FinalizationGenerationSlot } from '../../src/shared/finalization-generation'
import { finalizedCharacterOutputContract, finalizedCharacterPromptCards, replacedFinalFields, type FinalizedCharacterContext } from '../../src/shared/finalized-continuity'
import { composePromptSystemRole, type PromptTemplate } from '../../src/services/builtin-prompt-templates'
import { renderPrompt } from '../../src/shared/render-prompt'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import type { WritingLanguage } from '../../src/shared/writing-language'
import { SummaryRepository } from '../repositories/summary-repository'
import { textHash, type DurableGenerationRun } from '../repositories/generation-run-repository'

export function finalizationSlotKey(slot: FinalizationGenerationSlot): string {
  if (!slot || Object.keys(slot).some(key => !['source', 'stepKey'].includes(key)) || !['chapter_notes', 'character_cards'].includes(slot.stepKey)
    || !slot.source || Object.keys(slot.source).some(key => !['draftId', 'chapterNumber', 'finalizationId', 'contentHash'].includes(key))
    || !Number.isSafeInteger(slot.source.draftId) || slot.source.draftId < 1 || !Number.isSafeInteger(slot.source.chapterNumber) || slot.source.chapterNumber < 1
    || typeof slot.source.finalizationId !== 'string' || !slot.source.finalizationId.trim() || !/^[a-f0-9]{64}$/.test(slot.source.contentHash)) throw new Error('GENERATION_FINALIZATION_SLOT_INVALID')
  return textHash(JSON.stringify([slot.source.draftId, slot.source.finalizationId, slot.source.chapterNumber, slot.source.contentHash, slot.stepKey]))
}
export function finalizationNotesBaseline(db: Database.Database, slot: FinalizationGenerationSlot): FinalizationGenerationContext['notesBaseline'] {
  const blueprint = db.prepare('SELECT notes FROM blueprints WHERE chapter_number=?').get(slot.source.chapterNumber) as { notes: string } | undefined
  const rows = db.prepare('SELECT chapter_number,chapter_notes,continuity_facts,source_finalization_id,source_content_hash,projection_generation FROM summary_snapshots WHERE draft_id=? ORDER BY id').all(slot.source.draftId)
  return { blueprint: { exists: !!blueprint, notes: blueprint?.notes ?? '' }, continuityHash: textHash(JSON.stringify(rows)) }
}
// authorRelationsRevision：#667 合并后的开发版在冻结上下文里存过它，现在不再写，比较时照旧剔除。
const immutableIdentity = (context: FinalizedCharacterContext) => ({ ...context, authorRelations: undefined, authorRelationsRevision: undefined, characters: context.characters.map(({ fields: _fields, ...identity }) => { void _fields; return identity }) })

export function captureFinalizationGenerationContext(db: Database.Database, slot: FinalizationGenerationSlot, scope: { projectId: string; epoch: string },
  writingLanguage: WritingLanguage, template: PromptTemplate, frozen?: FinalizationGenerationContext): FinalizationGenerationContext {
  finalizationSlotKey(slot)
  const identity = SummaryRepository.readFinalizedCharacterContext(slot.source.draftId, frozen?.identity ?? scope, db)
  if (!isDeepStrictEqual(identity.source, slot.source)) throw new Error('GENERATION_FINALIZATION_SOURCE_CHANGED')
  if (frozen && (!isDeepStrictEqual(slot, frozen.slot) || !isDeepStrictEqual(immutableIdentity(identity), immutableIdentity(frozen.identity)))) throw new Error('GENERATION_FINALIZATION_IDENTITY_CHANGED')
  const row = db.prepare('SELECT chapter_title FROM finalization_outbox WHERE draft_id=?').get(slot.source.draftId) as { chapter_title: string }
  const blueprint = db.prepare('SELECT characters FROM blueprints WHERE chapter_number=?').get(slot.source.chapterNumber) as { characters: string } | undefined
  return { slot: structuredClone(slot), identity: structuredClone(frozen?.identity ?? identity), chapterTitle: row.chapter_title,
    chapterEntities: JSON.parse(blueprint?.characters ?? '[]'), writingLanguage, template: structuredClone(template),
    notesBaseline: frozen?.notesBaseline ?? finalizationNotesBaseline(db, slot) }
}
export function readFinalizationGenerationContext(run: DurableGenerationRun): FinalizationGenerationContext {
  const manifest = run.binding.sourceManifest, context = manifest.finalizationGenerationContext as FinalizationGenerationContext | undefined
  if (!context || textHash(JSON.stringify(context)) !== manifest.finalizationGenerationContextHash
    || finalizationSlotKey(context.slot) !== manifest.finalizationGenerationSlotKey
    || context.identity.projectId !== run.binding.projectId || context.identity.epoch !== manifest.finalizationGenerationOriginEpoch
    || !isDeepStrictEqual(context.slot.source, context.identity.source) || textHash(context.identity.content) !== context.slot.source.contentHash
    || manifest.operation !== (context.slot.stepKey === 'chapter_notes' ? 'finalized-chapter-notes' : 'finalized-character-state')) throw new Error('GENERATION_FINALIZATION_CONTEXT_INVALID')
  return structuredClone(context)
}
export function finalizationGenerationTask(context: FinalizationGenerationContext, originProjectId?: string): GenerationTask {
  const characters = context.slot.stepKey === 'character_cards'
  const contract = finalizedCharacterOutputContract(context.writingLanguage)
  const cards = characters ? finalizedCharacterPromptCards(context.identity, originProjectId)
    : context.identity.characters.map(character => ({ characterId: character.characterId, name: character.displayNameSnapshot, aliases: character.aliases,
      fields: character.fields.map(field => ({ field: field.field, value: field.value, provenance: field.provenance })) }))
  const prompt = renderPrompt(context.template, { chapter_content: context.identity.content, chapter_number: String(context.slot.source.chapterNumber), chapter_title: context.chapterTitle,
    existing_cards_json: JSON.stringify(cards, null, 2) }, context.writingLanguage)
  return { purpose: characters ? 'finalized-character-state' : 'finalized-chapter-notes', reasoningStage: 'review', output: characters ? 'structured-data' : 'visible-text',
    messages: [{ role: 'system', content: composePromptSystemRole(context.template, context.writingLanguage) },
      { role: 'user', content: characters ? [prompt, contract, replacedFinalRestatement(context, originProjectId)].filter(Boolean).join('\n\n') : prompt }] }
}
function replacedFinalRestatement(context: FinalizationGenerationContext, originProjectId?: string): string {
  const characters = replacedFinalFields(context.identity, originProjectId)
  if (!characters.length) return ''
  const en = context.writingLanguage === 'en-US'
  return [en
    ? '[This chapter replaced an earlier final: restate these fields] The fields below came from the replaced final of this chapter. Based on the current prose, give each one\'s current value in that character\'s update, even when it is the same as the existing card; this overrides "list other fields only when the value differs" above. Leave a field out only when the current prose no longer supports it.'
    : '【本章替换了旧定稿：逐项重新给出】下面这些字段来自本章被替换的旧定稿。请按现在的正文，在对应角色的 update 里逐项给出当前值，与现有角色卡相同也要列出，这一条优先于上面的「其余字段只在值不同时列出」；只有现在的正文已经不支持的字段才不返回。',
  ...characters.map(character => en
    ? `- ${character.name} (characterId: ${character.characterId}): ${character.fields.join(', ')}`
    : `- ${character.name}（characterId：${character.characterId}）：${character.fields.join('、')}`)].join('\n')
}
