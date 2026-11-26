import type { Locale } from '../../i18n/types'
import type { GenerationRecoveryContext } from '../../shared/generation-owner-contract'
import { outlineRecoveryGuide, planningRemainingText } from '../run/run-recovery'
import type { NoticeTone } from '../ui/Notice'

export interface OutlineRecoveryView {
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
  const guide = outlineRecoveryGuide(recovery, snapshot, locale)
  const continuation = recovery.planningContinuation, continuable = guide.continuable
  const next = [
    continuation?.state === 'save-prefix' && text('保存后可继续生成。', 'Save to generate the rest.'),
    continuation?.remainingRange && planningRemainingText(continuation.remainingRange, continuation.targetUnits, targetUnit, text),
  ].filter(Boolean).join(text('', ' '))
  const phase = ({ unavailable: 'blocked', regenerate: 'blocked', continued: 'blocked', saved: 'saved', waiting: 'waiting', editable: 'editable' } as const)[guide.kind]
  const view = (tone: NoticeTone, title: string, line: string | null, aside: string | null = null): OutlineRecoveryView => ({
    phase, continuable, primary: guide.primary,
    notice: { tone, title, lines: [line, guide.showRemaining && next, aside].filter((item): item is string => Boolean(item)) },
  })
  const candidate = recovery.plotOutlineRecovery, outline = recovery.plotOutline
  if (guide.kind !== 'editable' || !candidate || !outline) return view(guide.tone, guide.title ?? '', guide.note)

  const done = candidate.completeChapters
  const stopped = outline.cursor.kind === 'stopped' || outline.cursor.kind === 'request' ? outline.cursor.chapterNumber : null
  const heading = outline.sourceExpected.writingLanguage === 'en-US' ? `## Chapter ${stopped}:` : `## 第${stopped}章：`
  const written = done.length > 1 ? `Chapters ${span(done)} are written` : `Chapter ${span(done)} is written`
  const reply = candidate.rejectedReply && stopped !== null
    ? text(`第 ${stopped} 章那次的回复在「原始候选」里。`, `Chapter ${stopped}'s last reply is under “Original candidate”.`) : null
  if (done.length > 0 && stopped !== null) {
    return view('info', text(`第 ${span(done)} 章已写好，第 ${stopped} 章没写成`, `${written}; chapter ${stopped} is not`), null, reply)
  }
  if (done.length > 0) {
    return view('info', text(`第 ${span(done)} 章已写好，还没存进正式大纲`, `${written} but not in the outline yet`),
      text('点「保存恢复大纲」存进正式大纲。', 'Click “Save recovered outline” to add them to the outline.'))
  }
  if (stopped === null) return view('info', text('大纲没有写完', 'The outline is unfinished'), null)
  return view('info', text(`第 ${stopped} 章没写成`, `Chapter ${stopped} was not written`), continuable
    ? text(`点「继续生成缺少的章节」重新生成；也可以自己补全（以「${heading}」开头）后保存。`,
      `Click “Generate remaining chapters” to try again, or complete it yourself (start with “${heading}”) and save.`)
    : text(`自己补全它（以「${heading}」开头）后保存。`, `Complete it yourself (start with “${heading}”) and save.`), reply)
}
