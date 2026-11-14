import { useEffect, useMemo, useRef, useState } from 'react'
import { diff_match_patch, DIFF_DELETE, DIFF_INSERT } from 'diff-match-patch'
import { Check } from 'lucide-react'
import { errorCodeOf } from '../../i18n/app-errors'
import { createEditorInlineGeneration } from '../../services/editor-inline-generation'
import { routeModelId } from '../../services/model-routing'
import { getActiveProjectSessionContext } from '../../shared/project-session-context'
import type { EditorInlineAnnotation } from '../../shared/editor-inline-generation'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'

type Piece = { kind: 'same'; text: string } | { kind: 'change'; index: number; from: number; to: number; before: string; after: string }
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff
function splitChanges(before: string, after: string): Piece[] {
  const engine = new diff_match_patch()
  const diffs = engine.diff_main(before, after)
  engine.diff_cleanupSemantic(diffs)
  const runs: ({ same: string } | { before: string; after: string })[] = []
  for (const [kind, text] of diffs) {
    const last = runs.at(-1)
    if (kind === 0) { runs.push({ same: text }); continue }
    const run = last && !('same' in last) ? last : { before: '', after: '' }
    if (run !== last) runs.push(run)
    if (kind === DIFF_DELETE) run.before += text
    if (kind === DIFF_INSERT) run.after += text
  }
  // diff 按 UTF-16 切分，会把扩展区汉字的代理对拆在相同与修改两边。
  runs.forEach((run, i) => {
    if ('same' in run) return
    const prev = runs[i - 1], next = runs[i + 1]
    if (prev && 'same' in prev && isHighSurrogate(prev.same.charCodeAt(prev.same.length - 1))) {
      const char = prev.same.slice(-1)
      prev.same = prev.same.slice(0, -1); run.before = char + run.before; run.after = char + run.after
    }
    if (next && 'same' in next && isLowSurrogate(next.same.charCodeAt(0))) {
      const char = next.same.slice(0, 1)
      next.same = next.same.slice(1); run.before += char; run.after += char
    }
  })
  const pieces: Piece[] = []
  let offset = 0
  let index = 0
  for (const run of runs) {
    if ('same' in run) { if (run.same) pieces.push({ kind: 'same', text: run.same }); offset += run.same.length; continue }
    pieces.push({ kind: 'change', index: index++, from: offset, to: offset + run.before.length, before: run.before, after: run.after })
    offset += run.before.length
  }
  return pieces
}

type Change = { value: string; accepted: boolean; editing: boolean; busy: boolean; error: string }
export default function InlineAnnotationReview({ before, after, annotations, onCommit, onCancel }: {
  before: string; after: string; annotations: EditorInlineAnnotation[]
  onCommit: (result: string) => Promise<void>; onCancel: () => void
}) {
  const text = useLocaleStore(s => s.text)
  const pieces = useMemo(() => splitChanges(before, after), [before, after])
  const [changes, setChanges] = useState<Change[]>(() => pieces.flatMap(piece => piece.kind === 'change'
    ? [{ value: piece.after, accepted: false, editing: false, busy: false, error: '' }] : []))
  const [committing, setCommitting] = useState(false)
  const [activeChange, setActiveChange] = useState<number | null>(null)
  const [error, setError] = useState('')
  const commitGuard = useRef(false)
  const rerollClients = useRef(new Set<ReturnType<typeof createEditorInlineGeneration>>())
  useEffect(() => {
    const clients = rerollClients.current
    return () => { for (const client of clients) void client.cancel().catch(() => {}) }
  }, [])
  const update = (index: number, patch: Partial<Change>) => setChanges(current => current.map((item, i) => i === index ? { ...item, ...patch } : item))
  const commit = async (next: Change[]) => {
    if (commitGuard.current || next.some(item => !item.accepted || item.busy)) return
    commitGuard.current = true; setCommitting(true); setError('')
    try {
      await onCommit(pieces.map(piece => piece.kind === 'same' ? piece.text : next[piece.index]!.value).join(''))
    } catch (cause) {
      setError(errorCodeOf(cause) === 'SOURCE_DRAFT_CHANGED'
        ? text('正文或来源已变化，这次修改不能保存。取消后可重新统一修改。', 'The chapter or its sources changed, so these edits cannot be saved. Cancel and run the revision again.')
        : text('保存版本失败，修改仍在当前页面，请重试。', 'Could not save the version. Your edits are still here; try again.'))
      commitGuard.current = false
    }
    finally { setCommitting(false) }
  }
  const accept = (index: number) => {
    const next = changes.map((item, i) => i === index ? { ...item, accepted: true, editing: false } : item)
    setChanges(next); setActiveChange(null); void commit(next)
  }
  const closingAfter = (position: number) => {
    const next = pieces[position + 1]
    return pieces[position]?.kind === 'change' && next?.kind === 'same' ? /^[，。、；：！？）」』”’]*/.exec(next.text)![0] : ''
  }
  const wrapAllBut = (value: string, kept: number) => {
    const chars = Array.from(value)
    return <><span className="inline-annotation-wrap">{chars.slice(0, chars.length - kept).join('')}</span>{chars.slice(chars.length - kept).join('')}</>
  }
  const toggle = (index: number) => setActiveChange(current => current === index ? null : index)
  const acceptAll = () => { const next = changes.map(item => ({ ...item, accepted: true, editing: false })); setChanges(next); void commit(next) }
  const reroll = async (piece: Extract<Piece, { kind: 'change' }>) => {
    const session = getActiveProjectSessionContext()
    const selected = changes[piece.index]?.value || piece.before
    if (!session || !selected) { update(piece.index, { error: text('没有可重新生成的文字', 'No text to regenerate') }); return }
    update(piece.index, { busy: true, accepted: false, editing: false, error: '' })
    const client = createEditorInlineGeneration(session)
    rerollClients.current.add(client)
    try {
      const notes = annotations.filter(item => piece.from === piece.to ? item.from <= piece.from && item.to >= piece.from : item.from < piece.to && item.to > piece.from).map(item => item.instruction).join('；').slice(0, 1000)
      const context = `${before.slice(Math.max(0, piece.from - 160), piece.from)}……${before.slice(piece.to, piece.to + 160)}`
      await client.open({ input: { action: 'instruct', instruction: text(`重新改写所选片段，只输出片段。上下文：${context}。作者意见：${notes}`, `Rewrite only the selected passage. Context: ${context}. Author notes: ${notes}`), documentText: selected, selectedText: selected, from: 0, to: selected.length }, modelId: routeModelId('editor-inline') ?? '', uiActionNonce: crypto.randomUUID() })
      const receipt = await client.execute()
      if (receipt.outcome.status !== 'completed' || receipt.outcome.finishReason !== 'stop' || receipt.sourceStatus !== 'current' || !(receipt.run.candidates ?? receipt.run.artifacts).some(candidate => candidate.text === receipt.outcome.content && candidate.status === 'completed' && candidate.compositionEligible)) throw new Error('REROLL_INCOMPLETE')
      const candidate = receipt.outcome.content
      const position = pieces.indexOf(piece)
      const preceding = pieces[position - 1], following = pieces[position + 1]
      const overlap = candidate.length > 1 && ((following?.kind === 'same' && following.text.length > 0 && candidate.endsWith(following.text[0]!))
        || (preceding?.kind === 'same' && preceding.text.length > 0 && candidate.startsWith(preceding.text.at(-1)!)))
      update(piece.index, { value: candidate, busy: false, editing: false,
        error: overlap ? text('结果可能与相邻正文重复，请检查或编辑。', 'The result may repeat adjacent text; inspect or edit it.') : '' })
    } catch { update(piece.index, { busy: false, error: text('重新生成失败，请重试', 'Regeneration failed; try again') }) }
    finally { rerollClients.current.delete(client) }
  }
  return <section className="inline-annotation-review" aria-label={text('批注修改对比', 'Annotation revision comparison')}>
    <p>{text('红色为删除，绿色为新增。点击标色文字可编辑、重新生成或接受；全部确认后自动保存版本。', 'Red is removed, green is added. Select a change to edit, reroll or accept it; confirming all saves a version.')}</p>
    <div className="inline-annotation-prose">{pieces.map((piece, position) => piece.kind === 'same' ? <span key={position}>{piece.text.slice(closingAfter(position - 1).length)}</span> : <span key={position} className="inline-annotation-change">
      {/* <button> 是原子行内盒，整段修改无法在中间断行，所以用可聚焦的 span */}
      <span role="button" tabIndex={0} className="inline-annotation-mark" aria-label={text(`查看修改 ${piece.index + 1}`, `Inspect change ${piece.index + 1}`)} aria-expanded={activeChange === piece.index}
        onClick={() => toggle(piece.index)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(piece.index) } }}>
        {piece.before && <del>{wrapAllBut(piece.before, changes[piece.index]!.value ? 0 : 1)}</del>}{changes[piece.index]!.value && <ins>{wrapAllBut(changes[piece.index]!.value, 1)}</ins>}
      </span>
      {/* 对勾与操作区是原子盒，浏览器会在其前后断行；末字不放进可断区，才能与它们和句读一起换行 */}
      {changes[piece.index]!.accepted && <Check size={13} aria-label={text('已接受', 'Accepted')} />}
      {activeChange === piece.index && <span className="inline-annotation-actions">
        {changes[piece.index]!.editing && <textarea aria-label={text(`编辑修改 ${piece.index + 1}`, `Edit change ${piece.index + 1}`)} value={changes[piece.index]!.value} onChange={event => update(piece.index, { value: event.target.value, accepted: false, error: '' })} />}
        <Button variant="text" size="sm" disabled={committing || changes[piece.index]!.busy} onClick={() => update(piece.index, { editing: !changes[piece.index]!.editing, accepted: false })}>{text('编辑', 'Edit')}</Button>
        <Button variant="text" size="sm" disabled={committing || changes[piece.index]!.busy} onClick={() => void reroll(piece)}>{changes[piece.index]!.busy ? text('生成中…', 'Generating…') : text('重新生成', 'Reroll')}</Button>
        <Button variant="secondary" size="sm" disabled={committing || changes[piece.index]!.busy || changes[piece.index]!.accepted} onClick={() => accept(piece.index)}>{changes[piece.index]!.accepted ? text('已接受', 'Accepted') : text('接受', 'Accept')}</Button>
        {changes[piece.index]!.error && <span role="alert">{changes[piece.index]!.error}</span>}
      </span>}{closingAfter(position)}
    </span>)}</div>
    {error && <p role="alert">{error}</p>}
    <div className="inline-annotation-footer"><Button variant="secondary" disabled={committing} onClick={onCancel}>{text('取消', 'Cancel')}</Button><Button variant="primary" disabled={committing || changes.some(item => item.busy)} onClick={acceptAll}>{committing ? text('保存中…', 'Saving…') : text('接受全部', 'Accept all')}</Button></div>
  </section>
}
