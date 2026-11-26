import type { ChapterWritePrefill } from '../stores/layout-store'

export interface NextChapterBlueprint {
  chapterNumber: number
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: string[]
  userGuidance: string
}

export function getAutoNextChapterPrefill(
  enabled: boolean,
  completedChapter: number,
  blueprint: NextChapterBlueprint | null,
  hasExistingDraft: boolean,
): ChapterWritePrefill | null {
  if (!enabled || hasExistingDraft || !blueprint || blueprint.chapterNumber !== completedChapter + 1) {
    return null
  }

  return {
    title: blueprint.title,
    role: blueprint.role,
    purpose: blueprint.purpose,
    keyEvents: blueprint.keyEvents,
    characters: blueprint.characters.join('、'),
    userGuidance: blueprint.userGuidance || '',
  }
}
