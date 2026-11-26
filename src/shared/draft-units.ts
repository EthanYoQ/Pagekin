export const DRAFT_UNIT_ALGORITHM_VERSION = 3

export function draftTargetUnitRange(targetUnits: number): Readonly<{ minimum: number; maximum: number }> {
  if (!Number.isSafeInteger(targetUnits) || targetUnits < 1) throw new Error('DRAFT_TARGET_UNITS_INVALID')
  return Object.freeze({
    minimum: Math.floor(targetUnits * 0.7),
    maximum: Math.ceil(targetUnits * 1.3),
  })
}

const LEGACY_CHINESE_CHARACTER_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu
const LEGACY_ENGLISH_WORD_PATTERN = /[A-Za-z]+(?:['’][A-Za-z]+)*/g
const HAN_CHARACTER_PATTERN = /\p{Script=Han}/gu
const UNICODE_WORD_PATTERN = /\p{L}[\p{L}\p{M}]*(?:['’]\p{L}[\p{L}\p{M}]*)*/gu
const WHITESPACE_OR_PUNCTUATION_OR_SYMBOL_PATTERN = /[\s\p{P}\p{S}]/gu

export function countLegacyDraftUnitsV1(text: string): number {
  const englishWords = text.match(LEGACY_ENGLISH_WORD_PATTERN)?.length ?? 0
  const withoutEnglishWords = text.replace(LEGACY_ENGLISH_WORD_PATTERN, '')
  const chineseCharacters = withoutEnglishWords.match(LEGACY_CHINESE_CHARACTER_PATTERN)?.length ?? 0
  const otherCharacters = withoutEnglishWords
    .replace(LEGACY_CHINESE_CHARACTER_PATTERN, '')
    .replace(WHITESPACE_OR_PUNCTUATION_OR_SYMBOL_PATTERN, '')
    .length
  return chineseCharacters + englishWords + otherCharacters
}

let lastCounted: { text: string; units: number } | null = null

export function countDraftUnits(text: string): number {
  if (lastCounted?.text === text) return lastCounted.units
  const units = countUncached(text)
  lastCounted = { text, units }
  return units
}

function countUncached(text: string): number {
  const normalized = text.normalize('NFC')
  const hanCharacters = normalized.match(HAN_CHARACTER_PATTERN)?.length ?? 0
  const withoutHan = normalized.replace(HAN_CHARACTER_PATTERN, ' ')
  const words = withoutHan.match(UNICODE_WORD_PATTERN)?.length ?? 0
  const otherVisibleCodePoints = [...withoutHan
    .replace(UNICODE_WORD_PATTERN, '')
    .replace(WHITESPACE_OR_PUNCTUATION_OR_SYMBOL_PATTERN, '')]
    .length
  return hanCharacters + words + otherVisibleCodePoints
}
