import { localize, type Locale } from '../../i18n/core'
import type { StageNotice } from '../../shared/ipc-channels'
import type { WorkflowRun } from '../../stores/workflow-store'
import type { PostProcessStatus } from './workflow-utils'

/** 作者手动发起、结束时值得在后台提醒的运行。判定表见 batch11/feat-685.todo.md。 */
export type BackgroundNotice =
  | { stage: 'draft' | 'review' | 'revise' | 'finalize'; chapterNumber: number }
  | { stage: 'batch'; startChapter: number; endChapter: number }

/** 定稿执行器把本次后处理的步骤结果放在 context.data 的这个键下。 */
export const FINALIZE_POST_PROCESS_KEY = 'finalizePostProcess'

const STAGE_NAME = {
  draft: ['写作', 'draft'],
  review: ['审稿', 'review'],
  revise: ['修稿', 'revision'],
  finalize: ['定稿', 'finalization'],
} as const

/** 运行结束时的通知；取消等非完成、非失败的结局不通知。 */
export function stageNotice(
  locale: Locale,
  notice: BackgroundNotice,
  run: Pick<WorkflowRun, 'status' | 'steps'>,
  data: Readonly<Record<string, unknown>>,
): StageNotice | null {
  if (run.status !== 'completed' && run.status !== 'failed') return null
  const text = (zh: string, en: string) => localize(locale, zh, en)
  const done = text('回到书童查看结果。', 'Return to Pagekin to see the result.')
  const why = text('回到书童查看原因。', 'Return to Pagekin to see why.')

  if (notice.stage === 'batch') {
    const { startChapter, endChapter } = notice
    if (run.status === 'completed') {
      return {
        title: startChapter === endChapter
          ? text(`第 ${startChapter} 章批量创作完成`, `Batch writing finished for chapter ${startChapter}`)
          : text(`第 ${startChapter} 至 ${endChapter} 章批量创作完成`, `Batch writing finished for chapters ${startChapter}–${endChapter}`),
        body: done,
      }
    }
    const finished = run.steps.filter(step => step.status === 'completed').length
    const stoppedAt = Math.min(startChapter + finished, endChapter)
    return {
      title: text(`批量创作停在第 ${stoppedAt} 章`, `Batch writing stopped at chapter ${stoppedAt}`),
      body: finished === 0 ? why : text(
        `已完成 ${finished} 章，回到书童查看原因。`,
        `${finished} ${finished === 1 ? 'chapter is' : 'chapters are'} done. Return to Pagekin to see why.`,
      ),
    }
  }

  const { chapterNumber } = notice
  const [zh, en] = STAGE_NAME[notice.stage]
  if (run.status === 'failed') {
    return { title: text(`第 ${chapterNumber} 章${zh}没完成`, `Chapter ${chapterNumber} ${en} didn't finish`), body: why }
  }
  const postProcess = notice.stage === 'finalize' ? data[FINALIZE_POST_PROCESS_KEY] as PostProcessStatus | undefined : undefined
  const unfinished = postProcess ? Object.values(postProcess.steps).filter(step => !step.ok).length : 0
  if (unfinished > 0) {
    return {
      title: text(
        `第 ${chapterNumber} 章已定稿，有${unfinished === 1 ? '一' : ` ${unfinished} `}步没完成`,
        `Chapter ${chapterNumber} finalized, but ${unfinished} ${unfinished === 1 ? "step didn't" : "steps didn't"} finish`,
      ),
      body: text('回到书童查看并重试。', 'Return to Pagekin to check and retry.'),
    }
  }
  return { title: text(`第 ${chapterNumber} 章${zh}完成`, `Chapter ${chapterNumber} ${en} finished`), body: done }
}
