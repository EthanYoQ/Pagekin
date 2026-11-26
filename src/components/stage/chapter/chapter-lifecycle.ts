import type { ChapterPhase } from '../../../stores/navigation/stage-progress'

export type ChapterStage = ChapterPhase | 'archived' | 'superseded'

export const STAGE_STEP: Record<ChapterStage, number> = {
  todo: 0,
  draft: 1,
  reviewed: 2,
  merge: 2,
  revised: 3,
  final: 4,
  archived: 4,
  superseded: 4,
}
