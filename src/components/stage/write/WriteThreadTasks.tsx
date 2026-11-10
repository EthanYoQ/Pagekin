import { ChevronRight } from 'lucide-react'
import type { ChapterThreadPanelRow } from '../../../shared/narrative-thread'
import { useLocaleStore } from '../../../stores/locale-store'
import { Button } from '../../ui/Button'
import type { useChapterThreadTasks } from './use-chapter-thread-tasks'

interface WriteThreadTasksProps {
  chapterNumber: number
  threads: ReturnType<typeof useChapterThreadTasks>
}

export default function WriteThreadTasks({ chapterNumber, threads }: WriteThreadTasksProps) {
  const text = useLocaleStore(s => s.text)
  const { panel, savingPlanId, failure, defer, assign, undo } = threads
  if (panel.rows.length === 0 && panel.canAdvance.length === 0) return null
  const saving = savingPlanId !== null

  const statusOf = (row: ChapterThreadPanelRow) => {
    if (row.state === 'deferred') return text(`已延到第 ${row.deferredTo} 章`, `Moved to Ch. ${row.deferredTo}`)
    if (row.schedule.kind === 'overdue') return text(`逾期 ${row.schedule.chaptersOverdue} 章`, `${row.schedule.chaptersOverdue} overdue`)
    return row.schedule.kind === 'due' ? text('本章到期', 'Due now') : text('本章推进', 'This chapter')
  }

  const actionsOf = (row: ChapterThreadPanelRow) => {
    if (row.state === 'deferred') return <Button variant="text" size="sm" disabled={saving} onClick={() => undo(row.thread.id, row.deferredTo)}>{text('撤销', 'Undo')}</Button>
    if (row.schedule.kind === 'assigned') return <Button variant="text" size="sm" disabled={saving} onClick={() => undo(row.thread.id, chapterNumber)}>{text('撤销', 'Undo')}</Button>
    return (
      <>
        <Button variant="text" size="sm" disabled={saving} onClick={() => defer(row.thread.id, 1)}>{text('延后一章', 'Move 1 on')}</Button>
        <Button variant="text" size="sm" disabled={saving} onClick={() => defer(row.thread.id, 3)}>{text('延后三章', 'Move 3 on')}</Button>
      </>
    )
  }

  return (
    <section className="stage-write-threads" aria-label={text('本章线索', 'Threads for this chapter')}>
      {panel.rows.length > 0 && (
        <ul className="stage-write-thread-list">
          {panel.rows.map(row => (
            <li key={row.thread.id} className="stage-write-thread" data-state={row.state} data-saving={savingPlanId === row.thread.id || undefined}>
              <span className="stage-write-thread-name">
                <b>{row.thread.title}</b>
                <small data-overdue={(row.state === 'task' && row.schedule.kind === 'overdue') || undefined}>{statusOf(row)}</small>
              </span>
              <span className="stage-write-thread-actions">{actionsOf(row)}</span>
            </li>
          ))}
        </ul>
      )}
      {panel.leftOut > 0 && <p className="stage-write-thread-note">{text(`另有 ${panel.leftOut} 条本次不进任务`, `${panel.leftOut} more stay out of this run`)}</p>}
      {failure && <p className="stage-write-error" role="alert">{failure}</p>}
      {panel.canAdvance.length > 0 && (
        <details className="stage-write-more">
          <summary>
            <ChevronRight size={14} aria-hidden />
            {text('也可以本章推进', 'Advance one here')}
          </summary>
          <ul className="stage-write-thread-list">
            {panel.canAdvance.map(thread => (
              <li key={thread.id} className="stage-write-thread">
                <span className="stage-write-thread-name"><b>{thread.title}</b></span>
                <span className="stage-write-thread-actions">
                  <Button variant="text" size="sm" disabled={saving} onClick={() => assign(thread.id)}>{text('本章推进', 'Advance here')}</Button>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
