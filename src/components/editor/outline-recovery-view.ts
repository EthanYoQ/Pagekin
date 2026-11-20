import type { Locale } from '../../i18n/types'
import type { GenerationRecoveryContext } from '../../shared/generation-owner-contract'
import { outlineSourceChangedNote, outlineSourceInvalidNote, planningRemainingText } from '../run/run-recovery'
import type { NoticeTone } from '../ui/Notice'

export interface OutlineRecoveryView {
  /** editable：作者可以保存；saved：已保存，只能复制；waiting：生成还在进行；blocked：来源变了或无效，不能写回。 */
  phase: 'editable' | 'saved' | 'waiting' | 'blocked'
  notice: { tone: NoticeTone; title: string; lines: string[] }
  continuable: boolean
  primary: 'save' | 'continue' | null
}

type Text = (zh: string, en: string) => string

const span = (chapters: readonly number[]) => chapters.length > 1 ? `${chapters[0]}–${chapters.at(-1)}` : `${chapters[0]}`

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
    continuation?.state === 'save-prefix' && text('保存后可继续生成。', 'Save to generate the rest.'),
    continuation?.remainingRange && planningRemainingText(continuation.remainingRange, continuation.targetUnits, targetUnit, text),
  ].filter(Boolean).join(text('', ' '))
  const view = (phase: OutlineRecoveryView['phase'], tone: NoticeTone, title: string, line: string | null, aside: string | null = null): OutlineRecoveryView => ({
    phase, continuable, primary: continuable ? 'continue' : phase === 'editable' ? 'save' : null,
    // 不能写回时作者要按说明从本批起始章重新生成，再列「待完成第几章」会和它对不上。
    notice: { tone, title, lines: [line, phase !== 'blocked' && next, aside].filter((item): item is string => Boolean(item)) },
  })

  if (!candidate || !outline) {
    return view('blocked', 'warn', text('恢复内容暂时无法读取', 'Recovery content is unavailable'), text('请重新打开恢复稿。', 'Reopen the recovery draft.'))
  }
  const blocked = candidate.writeState.kind === 'blocked' ? candidate.writeState.reason : null
  // 已续写过的运行主进程也报 source-changed；回包丢失待重发的保存仍要能重发。
  const sourceBlocked = (blocked === 'source-changed' || blocked === 'source-invalid') && continuation?.state !== 'continued' && !(snapshot === 'pending' && candidate.saved)
  const saved = snapshot === 'saved' || snapshot !== 'pending' && (candidate.saved || blocked === 'author-saved')
  const restart = candidate.saved?.remainingRange?.from
  if (sourceBlocked && saved && restart) {
    return view('blocked', 'warn', text('本次恢复已保存，但不能接着生成', 'This recovery is saved, but generation cannot continue'),
      text(`保存后正式大纲、模型设置、作品设定、提示词模板或写作 Skill 有改动。请从第 ${restart} 章重新生成情节大纲。`,
        `The outline, model settings, book settings, a prompt template, or a writing skill changed after saving. Generate the plot outline again from chapter ${restart}.`))
  }
  if (sourceBlocked && !saved) {
    return view('blocked', 'warn', text('不能保存，也不能继续生成', 'This draft cannot be saved or continued'),
      outlineSourceInvalidNote(recovery, locale) ?? outlineSourceChangedNote(recovery, locale))
  }
  if (saved) {
    return view('saved', 'ok', text('本次恢复已保存，后续修改仅供复制。', 'This recovery is saved. Further edits can only be copied.'), null)
  }
  if (continuation?.state === 'continued') {
    return view('blocked', 'info', text('这批大纲已经接着生成过', 'This outline batch was already continued'), continuable
      ? text('不能再保存。点「继续生成缺少的章节」回到那一次生成。', 'It can no longer be saved. Click “Generate remaining chapters” to go back to that run.')
      : text('不能再保存。', 'It can no longer be saved.'))
  }
  if (blocked === 'in-flight' && !candidate.saved) {
    return view('waiting', 'info', text('大纲还在生成', 'The outline is still generating'),
      text('生成结束后才能保存或继续。恢复稿可以先编辑、复制。', 'Save or continue after it finishes. You can edit or copy this draft meanwhile.'))
  }

  const done = candidate.completeChapters
  const stopped = outline.cursor.kind === 'stopped' || outline.cursor.kind === 'request' ? outline.cursor.chapterNumber : null
  const heading = outline.sourceExpected.writingLanguage === 'en-US' ? `## Chapter ${stopped}:` : `## 第${stopped}章：`
  const written = done.length > 1 ? `Chapters ${span(done)} are written` : `Chapter ${span(done)} is written`
  const reply = candidate.rejectedReply && stopped !== null
    ? text(`第 ${stopped} 章那次的回复在「原始候选」里。`, `Chapter ${stopped}'s last reply is under “Original candidate”.`) : null
  if (done.length > 0 && stopped !== null) {
    return view('editable', 'info', text(`第 ${span(done)} 章已写好，第 ${stopped} 章没写成`, `${written}; chapter ${stopped} is not`), null, reply)
  }
  if (done.length > 0) {
    return view('editable', 'info', text(`第 ${span(done)} 章已写好，还没存进正式大纲`, `${written} but not in the outline yet`),
      text('点「保存恢复大纲」存进正式大纲。', 'Click “Save recovered outline” to add them to the outline.'))
  }
  if (stopped === null) return view('editable', 'info', text('大纲没有写完', 'The outline is unfinished'), null)
  return view('editable', 'info', text(`第 ${stopped} 章没写成`, `Chapter ${stopped} was not written`), continuable
    ? text(`点「继续生成缺少的章节」重新生成；也可以自己补全（以「${heading}」开头）后保存。`,
      `Click “Generate remaining chapters” to try again, or complete it yourself (start with “${heading}”) and save.`)
    : text(`自己补全它（以「${heading}」开头）后保存。`, `Complete it yourself (start with “${heading}”) and save.`), reply)
}
