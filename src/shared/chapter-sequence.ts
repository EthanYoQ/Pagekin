export type ChapterGapCause = 'deleted' | 'unexplained'

export interface ChapterGap {
  from: number
  to: number
  cause: ChapterGapCause
}

export type ChapterSequence =
  | { status: 'empty'; lastChapterNumber: 0; nextChapterNumber: 1; gaps: []; duplicateChapterNumbers: [] }
  | { status: 'continuous' | 'gapped'; lastChapterNumber: number; nextChapterNumber: number; gaps: ChapterGap[]; duplicateChapterNumbers: [] }
  | { status: 'invalid'; lastChapterNumber: number; gaps: ChapterGap[]; duplicateChapterNumbers: number[] }

export type AuthoritativeChapterSequence = ChapterSequence & { authorityFingerprint: string }

export function chapterSequenceFrom(
  finalizedChapterNumbers: readonly number[],
  deletedChapterNumbers: ReadonlySet<number>,
): ChapterSequence {
  if (finalizedChapterNumbers.length === 0) {
    return { status: 'empty', lastChapterNumber: 0, nextChapterNumber: 1, gaps: [], duplicateChapterNumbers: [] }
  }
  const counts = new Map<number, number>()
  for (const chapterNumber of finalizedChapterNumbers) counts.set(chapterNumber, (counts.get(chapterNumber) ?? 0) + 1)
  const lastChapterNumber = Math.max(...counts.keys())
  const gaps: ChapterGap[] = []
  for (let chapterNumber = 1; chapterNumber < lastChapterNumber; chapterNumber += 1) {
    if (counts.has(chapterNumber)) continue
    const open = gaps.at(-1)
    const cause: ChapterGapCause = deletedChapterNumbers.has(chapterNumber) ? 'deleted' : 'unexplained'
    if (open && open.to === chapterNumber - 1) {
      open.to = chapterNumber
      if (cause === 'deleted') open.cause = 'deleted'
    } else {
      gaps.push({ from: chapterNumber, to: chapterNumber, cause })
    }
  }
  const duplicateChapterNumbers = [...counts].filter(([, count]) => count > 1).map(([chapterNumber]) => chapterNumber)
    .sort((left, right) => left - right)
  if (duplicateChapterNumbers.length > 0) {
    return { status: 'invalid', lastChapterNumber, gaps, duplicateChapterNumbers }
  }
  return {
    status: gaps.length > 0 ? 'gapped' : 'continuous',
    lastChapterNumber,
    nextChapterNumber: lastChapterNumber + 1,
    gaps,
    duplicateChapterNumbers: [],
  }
}

export function writableChapterNumbers(sequence: Exclude<ChapterSequence, { status: 'invalid' }>): number[] {
  return [...sequence.gaps.map(gap => gap.from), sequence.nextChapterNumber]
}
