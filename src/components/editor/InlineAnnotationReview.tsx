import { useEffect, useMemo, useRef, useState } from 'react'
import { diff_match_patch, DIFF_DELETE, DIFF_INSERT } from 'diff-match-patch'
import { createEditorInlineGeneration } from '../../services/editor-inline-generation'
import { routeModelId } from '../../services/model-routing'
import { getActiveProjectSessionContext } from '../../shared/project-session-context'
import type { EditorInlineAnnotation } from '../../shared/editor-inline-generation'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'

type Piece = { kind: 'same'; text: string } | { kind: 'change'; index: number; from: number; to: number; before: string; after: string }
function splitChanges(before: string, after: string): Piece[] {
  const engine = new diff_match_patch()
  const diffs = engine.diff_main(before, after)
  engine.diff_cleanupSemantic(diffs)
  const pieces: Piece[] = []
  let offset = 0
  for (const [kind, text] of diffs) {
    if (kind === 0) { pieces.push({ kind: 'same', text }); offset += text.length; continue }
    let last = pieces.at(-1)
    if (!last || last.kind !== 'change') { last = { kind: 'change', index: pieces.filter(piece => piece.kind === 'change').length, from: offset, to: offset, before: '', after: '' }; pieces.push(last) }
    if (kind === DIFF_DELETE) { last.before += text; offset += text.length; last.to = offset }
    if (kind === DIFF_INSERT) last.after += text
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
    } catch { setError(text('保存版本失败，修改仍在当前页面，请重试。', 'Could not save the version. Your edits are still here; try again.')); commitGuard.current = false }
    finally { setCommitting(false) }
  }
  const accept = (index: number) => {
    const next = changes.map((item, i) => i === index ? { ...item, accepted: true, editing: false } : item)
    setChanges(next); setActiveChange(null); void commit(next)
  }
  const acceptAll = () => { const next = changes.map(item => ({ ...item, accepted: true, editing: false })); setChanges(next); void commit(next) }
  const reroll = async (piece: Extract<Piece, { kind: 'change' }>) => {
    const session = getActiveProjectSessionContext()
    const selected = changes[piece.index]?.value || piece.before
    if (!session || !selected) { update(piece.index, { error: text('没有可重新生成的文字', 'No text to regenerate') }); return }
    update(piece.index, { busy: true, accepted: false, error: '' })
    const client = createEditorInlineGeneration(session)
    rerollClients.current.add(client)
    try {
      const notes = annotations.filter(item => item.from <= piece.to && item.to >= piece.from).map(item => item.instruction).join('；').slice(0, 1000)
      const context = before.slice(Math.max(0, piece.from - 160), Math.min(before.length, piece.to + 160))
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
    <div className="inline-annotation-prose">{pieces.map((piece, position) => piece.kind === 'same' ? <span key={position}>{piece.text}</span> : <span key={position} className="inline-annotation-change">
      <button type="button" className="inline-annotation-mark" aria-label={text(`查看修改 ${piece.index + 1}`, `Inspect change ${piece.index + 1}`)} aria-expanded={activeChange === piece.index} onClick={() => setActiveChange(activeChange === piece.index ? null : piece.index)}>
        {piece.before && <del>{piece.before}</del>}{changes[piece.index]!.value && <ins>{changes[piece.index]!.value}</ins>}{changes[piece.index]!.accepted && <span aria-label={text('已接受', 'Accepted')}>✓</span>}
      </button>
      {activeChange === piece.index && <span className="inline-annotation-actions">
        {changes[piece.index]!.editing && <textarea aria-label={text(`编辑修改 ${piece.index + 1}`, `Edit change ${piece.index + 1}`)} value={changes[piece.index]!.value} onChange={event => update(piece.index, { value: event.target.value, accepted: false, error: '' })} />}
        <Button variant="text" size="sm" disabled={committing || changes[piece.index]!.busy} onClick={() => update(piece.index, { editing: !changes[piece.index]!.editing, accepted: false })}>{text('编辑', 'Edit')}</Button>
        <Button variant="text" size="sm" disabled={committing || changes[piece.index]!.busy} onClick={() => void reroll(piece)}>{changes[piece.index]!.busy ? text('生成中…', 'Generating…') : text('重新生成', 'Reroll')}</Button>
        <Button variant="secondary" size="sm" disabled={committing || changes[piece.index]!.busy || changes[piece.index]!.accepted} onClick={() => accept(piece.index)}>{changes[piece.index]!.accepted ? text('已接受', 'Accepted') : text('接受', 'Accept')}</Button>
        {changes[piece.index]!.error && <span role="alert">{changes[piece.index]!.error}</span>}
      </span>}
    </span>)}</div>
    {error && <p role="alert">{error}</p>}
    <div className="inline-annotation-footer"><Button variant="secondary" disabled={committing} onClick={onCancel}>{text('取消', 'Cancel')}</Button><Button variant="primary" disabled={committing || changes.some(item => item.busy)} onClick={acceptAll}>{committing ? text('保存中…', 'Saving…') : text('接受全部', 'Accept all')}</Button></div>
  </section>
}
