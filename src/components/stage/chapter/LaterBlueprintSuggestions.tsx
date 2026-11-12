import { Fragment, useMemo } from 'react'
import { BLUEPRINT_PATCH_FIELDS, type BlueprintPatchField, type ContinuitySuggestionView } from '../../../shared/blueprint-continuity-suggest'
import { useEditorStore } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { CHAPTER_CARD_TAB_ID, getChapterCardProjectDraft, parseChapterCardDraftLedger } from '../../editor/chapter-card-draft-ledger'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { basisLine } from '../blueprint/basis-line'
import { diffProse } from '../history/version-diff'
import { useStageView } from '../use-stage-work'
import type { LaterBlueprintCheck } from './use-later-blueprint-check'

type Text = (zh: string, en: string) => string

const FIELD_LABELS: Record<BlueprintPatchField, readonly [string, string]> = {
  title: ['标题', 'Title'],
  role: ['定位', 'Role'],
  purpose: ['本章目的', 'Purpose'],
  keyEvents: ['关键事件', 'Key events'],
  suspenseHook: ['悬念钩子', 'Hook'],
}

function FieldDiff({ before, after }: { before: string; after: string }) {
  const diff = useMemo(() => diffProse(before, after), [before, after])
  return (
    <>
      {diff.paragraphs.map((paragraph, index) => (
        <p key={index}>
          {paragraph.map((segment, part) => segment.kind === 'added'
            ? <ins key={part}>{segment.text}</ins>
            : segment.kind === 'removed' ? <del key={part}>{segment.text}</del> : <span key={part}>{segment.text}</span>)}
        </p>
      ))}
    </>
  )
}

function statusLine(card: ContinuitySuggestionView, text: Text): string | null {
  if (card.status === 'accepted') return text('已接受，蓝图已改。', 'Accepted. The blueprint is updated.')
  if (card.status === 'rejected') return text('没有采用，蓝图没动。', 'Not used. The blueprint is unchanged.')
  if (card.status === 'stale') return text('这章蓝图在建议之后改过，这条不再适用。重新检查一次。', 'This blueprint changed after the suggestion, so it no longer applies. Check again.')
  return null
}

function SuggestionCard({ card, check, drafted, unsaved }: { card: ContinuitySuggestionView; check: LaterBlueprintCheck; drafted: boolean; unsaved: boolean }) {
  const text = useLocaleStore(s => s.text)
  const done = statusLine(card, text)
  return (
    <li className="stage-ch-suggest-card" data-status={card.status}>
      <h3 className="stage-ch-suggest-head">{text(`第 ${card.chapterNumber} 章`, `Chapter ${card.chapterNumber}`)}</h3>
      {card.issues.map((issue, index) => <p key={index} className="stage-ch-suggest-issue">{issue}</p>)}
      <p className="stage-ch-suggest-basis">{text('依据：', 'Basis: ')}{card.basis.map((node, index) => (
        <Fragment key={node.eventId}>{index > 0 && text('；', '; ')}{basisLine(node, text)}</Fragment>
      ))}</p>
      <dl className="stage-ch-suggest-fields" aria-label={text('改动对比', 'Changes')}>
        {BLUEPRINT_PATCH_FIELDS.filter(field => card.after[field] !== undefined).map(field => (
          <Fragment key={field}>
            <dt>{text(...FIELD_LABELS[field])}</dt>
            <dd><FieldDiff before={card.before[field] ?? ''} after={card.after[field]!} /></dd>
          </Fragment>
        ))}
      </dl>
      {drafted && card.status === 'pending' && (
        <p className="stage-ch-suggest-note">{text(`第 ${card.chapterNumber} 章已有草稿，蓝图改了正文不会跟着变。`, `Chapter ${card.chapterNumber} already has a draft. Changing the blueprint does not change it.`)}</p>
      )}
      {done
        ? <p className="stage-ch-suggest-note" role="status">{done}</p>
        : (
          <div className="stage-ch-suggest-actions">
            <Button variant="secondary" size="sm" disabled={check.busy || unsaved} onClick={() => void check.decide(card.suggestionId, 'accept')}>{text('接受', 'Accept')}</Button>
            <Button variant="text" size="sm" disabled={check.busy} onClick={() => void check.decide(card.suggestionId, 'reject')}>{text('不用', 'Don’t use')}</Button>
            {unsaved && <span className="stage-ch-suggest-hint">{text('蓝图里有没保存的修改，先保存或放弃当前修改。', 'The blueprint has unsaved changes. Save or discard them first.')}</span>}
          </div>
        )}
    </li>
  )
}

function chapterList(chapters: readonly number[], text: Text) {
  const first = chapters[0]
  const last = chapters.at(-1)
  return first === last ? text(`第 ${first} 章`, `chapter ${first}`) : text(`第 ${first}–${last} 章`, `chapters ${first}–${last}`)
}

export default function LaterBlueprintSuggestions({ check, projectKey, pendingOnly }: {
  check: LaterBlueprintCheck
  projectKey: string
  /** 只留没处理的卡和这次刚处理的卡，处理过的旧卡不再占地方。 */
  pendingOnly: boolean
}) {
  const text = useLocaleStore(s => s.text)
  const ledger = useEditorStore(s => s.draftLedgers[CHAPTER_CARD_TAB_ID])
  const unsaved = (getChapterCardProjectDraft(parseChapterCardDraftLedger(ledger), projectKey)?.dirtyChapterNumbers.length ?? 0) > 0
  const { chapters } = useStageView()
  const { status, list } = check
  if (status.kind === 'unreadable') return <Notice tone="warn" title={text('蓝图没有改动。这次结果没读出来，再点“检查后续蓝图”。', 'Your blueprints are unchanged. This result could not be read. Choose Check later blueprints again.')} />
  if (status.kind === 'failed') return <Notice tone="warn" title={status.message} />
  if (!list) return null
  if (list.suggestions.length === 0) {
    if (list.droppedSuggestions > 0) return <Notice tone="warn" title={text('蓝图没有改动。这次的建议都不合格，再点“检查后续蓝图”。', 'Your blueprints are unchanged. None of the suggestions were usable. Choose Check later blueprints again.')} />
    return status.kind === 'done'
      ? <Notice tone="ok" title={text(`检查了${chapterList(list.checkedChapters, text)}，蓝图和新的时间线没有矛盾。`, `Checked ${chapterList(list.checkedChapters, text)}. No blueprint conflicts with the new timeline.`)} />
      : null
  }
  const cards = pendingOnly ? list.suggestions.filter(card => card.status === 'pending' || check.decided.has(card.suggestionId)) : list.suggestions
  if (cards.length === 0) return null
  const drafted = new Set(chapters.filter(row => row.draft && row.draft.status !== 'finalized').map(row => row.number))
  return (
    <section className="stage-ch-suggest" aria-label={text('后续蓝图的修改建议', 'Suggested blueprint changes')}>
      <h2 className="stage-ch-plan-title">
        {text('后续蓝图的修改建议', 'Suggested blueprint changes')}
        <small>{text(`检查了${chapterList(list.checkedChapters, text)}`, `Checked ${chapterList(list.checkedChapters, text)}`)}</small>
      </h2>
      <ul className="stage-ch-suggest-list">
        {cards.map(card => <SuggestionCard key={card.suggestionId} card={card} check={check} drafted={drafted.has(card.chapterNumber)} unsaved={unsaved} />)}
      </ul>
    </section>
  )
}
