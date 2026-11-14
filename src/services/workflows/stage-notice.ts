import { localize, type Locale } from '../../i18n/core'
import type { StageNotice } from '../../shared/ipc-channels'

/** 作者手动发起、结束时值得在后台提醒的四个阶段。判定表见 batch11/feat-685.todo.md。 */
export type NoticeStage = 'draft' | 'review' | 'revise' | 'finalize'

export interface BackgroundNotice { stage: NoticeStage; chapterNumber: number }

const STAGE_NAME: Record<NoticeStage, readonly [string, string]> = {
  draft: ['写作', 'draft'],
  review: ['审稿', 'review'],
  revise: ['修稿', 'revision'],
  finalize: ['定稿', 'finalization'],
}

export function stageNotice(locale: Locale, { stage, chapterNumber }: BackgroundNotice, outcome: 'completed' | 'failed'): StageNotice {
  const [zh, en] = STAGE_NAME[stage]
  return outcome === 'completed'
    ? {
        title: localize(locale, `第 ${chapterNumber} 章${zh}完成`, `Chapter ${chapterNumber} ${en} finished`),
        body: localize(locale, '回到书童查看结果。', 'Return to Pagekin to see the result.'),
      }
    : {
        title: localize(locale, `第 ${chapterNumber} 章${zh}没完成`, `Chapter ${chapterNumber} ${en} didn't finish`),
        body: localize(locale, '回到书童查看原因。', 'Return to Pagekin to see why.'),
      }
}
