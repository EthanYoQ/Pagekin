import type { CharacterStateTextField } from '../../shared/character-roster'
import { EMPTY_STATE, type CharacterCard, type CharacterCurrentState } from '../../stores/character-store'

export const CHARACTER_STATE_FIELDS: readonly (readonly [CharacterStateTextField, string, string])[] = [
  ['location', '当前位置/阵营', 'Location / faction'],
  ['powerLevel', '修为境界/能力等级', 'Power or ability level'],
  ['physicalState', '身体状态（伤势/BUFF/外貌）', 'Physical state (injuries, effects, appearance)'],
  ['mentalState', '心理状态（愿望/恐惧/心态）', 'Mental state (goals, fears, mindset)'],
  ['keyItems', '关键道具/资源', 'Key items / resources'],
  ['recentEvents', '最近重要事件', 'Recent important events'],
]

export type StateFieldSource = 'historical' | 'author' | 'derived' | 'unknown'

export function stateFieldView(
  card: CharacterCard,
  field: CharacterStateTextField,
  currentDerivedFields: Record<string, CharacterStateTextField[]>,
): { value: string; history: string; source: StateFieldSource } {
  const provenance = card.currentState?.provenance?.[field]
  const historical = provenance?.kind === 'derived' && !currentDerivedFields[card.characterId ?? '']?.includes(field)
  const raw = card.currentState?.[field]?.toString() ?? ''
  return {
    value: historical ? '' : raw,
    history: historical ? raw : '',
    source: historical ? 'historical' : provenance?.kind === 'author' ? 'author' : provenance?.kind === 'derived' ? 'derived' : 'unknown',
  }
}

export function rosterStateChanged(base: readonly CharacterCard[], draft: readonly CharacterCard[]): boolean {
  const before = new Map(base.map(card => [card.characterId, card.currentState]))
  return draft.some(card => CHARACTER_STATE_FIELDS.some(([field]) => (card.currentState?.[field] ?? '') !== (before.get(card.characterId)?.[field] ?? '')))
}

export function authorStateEdit(card: CharacterCard, field: CharacterStateTextField, value: string): CharacterCurrentState {
  return {
    ...(card.currentState ?? EMPTY_STATE),
    [field]: value,
    provenance: {
      ...card.currentState?.provenance,
      [field]: { kind: 'author', chapterNumber: card.currentState?.updatedAtChapter ?? 0 },
    },
  }
}
