import type { Locale } from '../../i18n/types'
import type { GenerationRecoveryContext } from '../../shared/generation-owner-contract'
import { outlineSourceChangedNote, outlineSourceInvalidNote, planningRemainingText } from '../run/run-recovery'
import type { NoticeTone } from '../ui/Notice'

export interface OutlineRecoveryView {
  /** editable：作者可以保存；saved：已保存，只能复制；waiting：生成还在进行；blocked：来源变了或无效，不能写回。 */
  phase: 'editable' | 'saved' | 'waiting' | 'blocked'
  notice: { tone: NoticeTone; title: string; lines: string[] }
  continuable: boolean
  /** 流程上的下一步：能接着生成就是继续，否则是保存。 */
  primary: 'save' | 'continue' | null
}

type Text = (zh: string, en: string) => string

const span = (chapters: readonly number[]) => chapters.length > 1 ? `${chapters[0]}–${chapters.at(-1)}` : `${chapters[0]}`

/** 大纲恢复稿页的状态、说明与主操作，全部由主进程给的恢复上下文和本标签的保存快照推出。 */
export function outlineRecoveryView(
  recovery: GenerationRecoveryContext,
  snapshot: 'pending' | 'saved' | undefined,
  locale: Locale,
  text: Text,
  targetUnit: string,
): OutlineRecoveryView {
  const candidate = recovery.plotOutlineRecovery, outline = recovery.plotOutline, continuation = recovery.planningContinuation
  const continuable = Boolean(continuation?.remainingRange) && ['ready', 'continued'].includes(continuation?.state ?? '')
  const next = [
    continuation?.state === 'save-prefix' && text('保存后才能继续生成。', 'Save before generating more.'),
    continuation?.remainingRange && planningRemainingText(continuation.remainingRange, continuation.targetUnits, targetUnit, text),
  ].filter(Boolean).join(text('', ' '))
  const view = (phase: OutlineRecoveryView['phase'], tone: NoticeTone, title: string, line: string | null): OutlineRecoveryView => ({
    phase, continuable, primary: continuable ? 'continue' : phase === 'editable' ? 'save' : null,
    notice: { tone, title, lines: [line, next].filter((item): item is string => Boolean(item)) },
  })

  if (!candidate || !outline) {
    return view('blocked', 'warn', text('恢复内容暂时无法读取', 'Recovery content is unavailable'), text('请重新打开恢复稿。', 'Reopen the recovery draft.'))
  }
  const blocked = candidate.writeState.kind === 'blocked' ? candidate.writeState.reason : null
  if (snapshot === 'saved' || snapshot !== 'pending' && (candidate.saved || blocked === 'author-saved')) {
    return view('saved', 'ok', text('本次恢复已保存，后续修改仅供复制。', 'This recovery is saved. Further edits can only be copied.'), null)
  }
  if (blocked === 'in-flight' && !candidate.saved) {
    return view('waiting', 'info', text('大纲还在生成', 'The outline is still generating'),
      text('生成结束后才能保存或继续。恢复稿可以先编辑、复制。', 'Save or continue after it finishes. You can edit or copy this draft meanwhile.'))
  }
  if (blocked && !candidate.saved) {
    return view('blocked', 'warn', text('不能保存，也不能继续生成', 'This draft cannot be saved or continued'),
      outlineSourceInvalidNote(recovery, locale) ?? outlineSourceChangedNote(recovery, locale))
  }

  const done = candidate.completeChapters
  const stopped = outline.cursor.kind === 'stopped' || outline.cursor.kind === 'request' ? outline.cursor.chapterNumber : null
  const heading = outline.sourceExpected.writingLanguage === 'en-US' ? `## Chapter ${stopped}:` : `## 第${stopped}章：`
  const written = done.length > 1 ? `Chapters ${span(done)} are written` : `Chapter ${span(done)} is written`
  if (done.length > 0 && stopped !== null) {
    return view('editable', 'info', text(`第 ${span(done)} 章已写好，第 ${stopped} 章没写成`, `${written}; chapter ${stopped} is not`),
      text(`删掉正文里第 ${stopped} 章那段再保存；或把它补全（以「${heading}」开头），并把「保存到第几章」改成 ${stopped}。`,
        `Delete the chapter ${stopped} part, then save. Or complete it (start with “${heading}”) and set “Last complete chapter” to ${stopped}.`))
  }
  if (done.length > 0) {
    return view('editable', 'info', text(`第 ${span(done)} 章已写好，还没存进正式大纲`, `${written} but not in the outline yet`),
      text('点「保存恢复大纲」存进正式大纲。', 'Click “Save recovered outline” to add them to the outline.'))
  }
  if (stopped === null) return view('editable', 'info', text('大纲没有写完', 'The outline is unfinished'), null)
  return view('editable', 'info', text(`第 ${stopped} 章没写成`, `Chapter ${stopped} was not written`), continuable
    ? text(`点「继续生成缺少的章节」重新生成；也可以自己补全（以「${heading}」开头）后保存。`,
      `Click “Generate remaining chapters” to try again, or complete it yourself (start with “${heading}”) and save.`)
    : text(`自己补全它（以「${heading}」开头）后保存。`, `Complete it yourself (start with “${heading}”) and save.`))
}
