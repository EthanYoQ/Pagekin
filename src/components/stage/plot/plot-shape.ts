import type { NarrativeThreadEventType, NarrativeThreadView } from '../../../shared/narrative-thread'
import type { PlotTreeSnapshot } from '../../../shared/plot-tree'

export function plotChapters(snapshot: PlotTreeSnapshot | null, currentChapter: number): number[] {
  const values = new Set<number>()
  const add = (chapter: number) => {
    if (Number.isSafeInteger(chapter) && chapter >= 1) values.add(chapter)
  }
  add(currentChapter)
  for (const track of snapshot?.tracks ?? []) {
    add(track.startChapter)
    add(track.endChapter)
    for (const event of track.events) add(event.chapterNumber)
  }
  return [...values].sort((left, right) => left - right)
}

export function chapterWindow(chapters: readonly number[], currentChapter: number, size: number, requestedStart: number | null) {
  const currentIndex = chapters.findIndex(chapter => chapter >= currentChapter)
  const centered = Math.max(0, currentIndex - Math.floor(size / 2))
  const maximum = Math.max(0, chapters.length - size)
  const start = Math.min(requestedStart ?? centered, maximum)
  return { start, maximum, visible: chapters.slice(start, start + size) }
}

export type RouteState = 'done' | 'late' | 'todo' | 'none'

export interface RouteStop {
  kind: 'planted' | 'progressing' | 'resolved'
  chapter: number | null
  state: RouteState
}

const lastOf = (thread: NarrativeThreadView, type: NarrativeThreadEventType) =>
  thread.events.filter(event => event.type === type).at(-1)?.chapterNumber

export function threadRoute(thread: NarrativeThreadView): RouteStop[] {
  const planted = lastOf(thread, 'planted')
  const progressing = lastOf(thread, 'progressing')
  const resolved = lastOf(thread, 'resolved')
  const stops: RouteStop[] = [
    { kind: 'planted', chapter: planted ?? thread.targetStartChapter, state: planted !== undefined ? 'done' : 'todo' },
    { kind: 'progressing', chapter: progressing ?? null, state: progressing !== undefined ? 'done' : 'none' },
    { kind: 'resolved', chapter: resolved ?? thread.targetEndChapter, state: resolved !== undefined ? 'done' : 'todo' },
  ]
  if (thread.overdue && thread.status !== 'resolved' && thread.status !== 'abandoned') {
    const next = stops.find(stop => stop.state === 'todo')
    if (next) next.state = 'late'
  }
  return stops
}
