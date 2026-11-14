import { useEffect, useState } from 'react'
import { ipc } from '../../../services/ipc-client'
import { Button } from '../../ui/Button'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../../project-session-gate'
import type { EditorInlineAnnotation } from '../../../shared/editor-inline-generation'
import { diffProse } from '../history/version-diff'
import { sqliteTime } from '../../../shared/sqlite-time'

type Entry = { id: number; annotations: EditorInlineAnnotation[]; createdAt: string; diff: ReturnType<typeof diffProse> }
export default function AnnotationRevisionHistory({ draftId, projectKey, refresh }: { draftId: number; projectKey: string; refresh: number }) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const lease = useProjectStore(s => s.currentProject?.sessionLease)
  const [loaded, setLoaded] = useState<{ key: string } & ({ entries: Entry[] } | { failed: true }) | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = `${lease}:${draftId}:${refresh}:${attempt}`
  useEffect(() => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey)) return
    let active = true
    void ipc.invokeWithProjectSession(session, 'db:annotation-history-list', draftId, projectKey).then(rows => {
      if (active && isProjectSessionCurrent(session)) setLoaded({ key, entries: rows.map(({ before, after, ...row }) => ({ ...row, diff: diffProse(before, after) })) })
    }).catch(() => { if (active && isProjectSessionCurrent(session)) setLoaded({ key, failed: true }) })
    return () => { active = false }
  }, [draftId, projectKey, key])
  if (!loaded || loaded.key !== key) return null
  if ('failed' in loaded) return <p className="annotation-revision-history" role="alert">
    {text('正文不受影响，批注历史没读出来。', "Your chapter is fine; the annotation history didn't load.")}
    <Button variant="text" size="sm" onClick={() => setAttempt(value => value + 1)}>{text('重试', 'Retry')}</Button>
  </p>
  if (loaded.entries.length === 0) return null
  return <details className="stage-ch-passed annotation-revision-history"><summary>{text(`批注历史版本（${loaded.entries.length}）`, `Annotation history (${loaded.entries.length})`)}</summary>
    {loaded.entries.map(({ diff, ...entry }) => {
      return <details key={entry.id} className="stage-ch-passed"><summary>{sqliteTime(entry.createdAt).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · {text(`新增 ${diff.added} 处，删除 ${diff.removed} 处`, `${diff.added} added, ${diff.removed} removed`)}</summary>
        {entry.annotations.map(note => <div key={note.id} className="cm-annotation"><span className="cm-annotation-quote">{note.selectedText}</span><p>{note.instruction}</p></div>)}
        <div className="inline-annotation-prose">{diff.paragraphs.map((paragraph, i) => <p key={i}>{paragraph.map((part, j) => part.kind === 'added' ? <ins key={j}>{part.text}</ins> : part.kind === 'removed' ? <del key={j}>{part.text}</del> : <span key={j}>{part.text}</span>)}</p>)}</div>
      </details>
    })}
  </details>
}
