import { diff_match_patch, DIFF_DELETE, DIFF_INSERT } from 'diff-match-patch'

export type DiffKind = 'same' | 'added' | 'removed'

export interface DiffSegment {
  kind: DiffKind
  text: string
}

export interface ProseDiff {
  paragraphs: DiffSegment[][]
  added: number
  removed: number
}

const KIND: Record<number, DiffKind> = { [DIFF_INSERT]: 'added', [DIFF_DELETE]: 'removed' }

export function diffProse(older: string, current: string): ProseDiff {
  const engine = new diff_match_patch()
  const diffs = engine.diff_main(older, current)
  engine.diff_cleanupSemantic(diffs)
  const paragraphs: DiffSegment[][] = [[]]
  let added = 0
  let removed = 0
  for (const [operation, text] of diffs) {
    const kind = KIND[operation] ?? 'same'
    if (kind === 'added') added++
    if (kind === 'removed') removed++
    text.split('\n').forEach((piece, index) => {
      if (index > 0) paragraphs.push([])
      if (piece) paragraphs[paragraphs.length - 1].push({ kind, text: piece })
    })
  }
  return { paragraphs: paragraphs.filter(paragraph => paragraph.length > 0), added, removed }
}
