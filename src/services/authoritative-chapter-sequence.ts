import {
  writableChapterNumbers,
  type AuthoritativeChapterSequence,
  type ChapterGap,
} from '../shared/chapter-sequence'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { WritingLanguage } from '../shared/writing-language'
import { ipc } from './ipc-client'

export class AuthoritativeChapterSequenceError extends Error {
  readonly code = 'AUTHORITATIVE_CHAPTER_SEQUENCE_INVALID' as const

  constructor(
    readonly sequence: AuthoritativeChapterSequence,
    locale: WritingLanguage,
  ) {
    const duplicates = sequence.duplicateChapterNumbers
    const en = locale === 'en-US'
    const detail = duplicates.length > 0
      ? en
        ? `Finalized authority has duplicate records for Chapters ${duplicates.join(', ')}.`
        : `权威定稿的第 ${duplicates.join('、')} 章存在重复记录。`
      : en ? 'Finalized manuscript authority is inconsistent.' : '权威定稿状态不一致。'
    super(en
      ? `${detail} Repair or remove the conflicting finalized chapters before continuing.`
      : `${detail}请先修复或移除冲突定稿，再继续创作。`)
    this.name = 'AuthoritativeChapterSequenceError'
  }
}

export interface WritableChapters {
  next: number
  gaps: ChapterGap[]
  writable: number[]
}

const isChapterNumber = (value: number) => Number.isSafeInteger(value) && value >= 1

export async function readWritableChapters(
  projectSession: ProjectSessionContext,
  locale: WritingLanguage,
): Promise<WritableChapters> {
  const sequence = await ipc.invokeWithProjectSession(
    projectSession,
    'db:draft-authority-sequence',
    projectSession.projectPath,
  )
  if (sequence.status !== 'invalid' && Array.isArray(sequence.gaps)) {
    const writable = writableChapterNumbers(sequence)
    if (writable.every(isChapterNumber)) return { next: sequence.nextChapterNumber, gaps: sequence.gaps, writable }
  }
  throw new AuthoritativeChapterSequenceError(sequence, locale)
}
