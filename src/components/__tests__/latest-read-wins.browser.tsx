import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import type { ChapterDeletionOperation, TrashedChapter } from '../../shared/chapter-deletion'
import type { ReplacementImpact } from '../../shared/chapter-reopen'
import { globalEventBus } from '../../shared/event-bus'
import type { ProjectData } from '../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import { useProjectStore } from '../../stores/project-store'
import { useIncompleteDeletions } from '../panels/sidebar/use-incomplete-deletions'
import { useReplacementImpacts } from '../stage/chapter/use-replacement-impacts'
import { useShelfOverview } from '../stage/library/use-shelf-overview'
import { useChapterTrash } from '../stage/trash/use-chapter-trash'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Call { channel: string; args: unknown[]; resolve: (value: unknown) => void }
const win = window as unknown as { aiNovelAPI?: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown>; on: () => () => void } }

const projectA = { id: '雨夜列车', path: 'C:/novels/night-train', sessionLease: '第一次打开' }
const projectB = { id: '雪国', path: 'C:/novels/snow-country', sessionLease: '第一次打开' }
const sessionOf = (project: typeof projectA) => ({ projectId: project.id, projectPath: project.path, leaseId: project.sessionLease })
const restoreProjectStore = (() => {
  const state = (useProjectStore as StoreApi<unknown>).getState()
  return () => (useProjectStore as StoreApi<unknown>).setState(state, true)
})()

let calls: Call[]
let root: Root | undefined
let host: HTMLDivElement | undefined

function openProject(project: typeof projectA) {
  setActiveProjectSessionContext(sessionOf(project))
  useProjectStore.setState({ currentProject: { ...project, name: project.id } as unknown as ProjectData })
}

function pending(channel: string): Call[] {
  return calls.filter(call => call.channel === channel)
}

async function answer(call: Call | undefined, value: unknown) {
  expect(call, '有一次待回复的读取').toBeTruthy()
  await act(async () => { call!.resolve(value) })
  await act(async () => { await Promise.resolve() })
}

async function renderHook<T>(use: () => T, { strict = false } = {}): Promise<() => T> {
  let latest!: T
  function Probe() {
    latest = use()
    return null
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(strict ? <StrictMode><Probe /></StrictMode> : <Probe />))
  return () => latest
}

beforeEach(() => {
  calls = []
  win.aiNovelAPI = {
    invoke: (channel, ...args) => new Promise(resolve => { calls.push({ channel, args, resolve }) }),
    on: () => () => undefined,
  }
  openProject(projectA)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  delete win.aiNovelAPI
  setActiveProjectSessionContext(null)
  restoreProjectStore()
})

const operation = (operationId: string) => ({ operationId, chapterNumber: 3, chapterTitle: '雨夜车站' }) as ChapterDeletionOperation
const impact = (chapterNumber: number) => ({ chapterNumber, finalizationId: `final-${chapterNumber}`, laterChapters: [chapterNumber + 1],
  blueprintOnlyChapters: [], characters: [], unmovedConfirmations: [] }) as ReplacementImpact
const trashed = (chapterNumber: number) => ({ deletionId: `deleted-${chapterNumber}`, chapterNumber, chapterTitle: `第${chapterNumber}章` }) as TrashedChapter

describe('同一资源连读两次，先发的读取后回来', () => {
  it('没做完的正文删除：显示后一次读到的列表', async () => {
    const result = await renderHook(() => useIncompleteDeletions(projectA.path))
    await act(async () => globalEventBus.emit('CHAPTER_DELETION_UPDATED', { projectPath: projectA.path, projectSession: sessionOf(projectA) }))
    const [older, newer] = pending('chapter:list-incomplete-deletions')

    await answer(newer, { success: true, operations: [operation('清理已重试')] })
    await answer(older, { success: true, operations: [operation('清理失败'), operation('待核对')] })

    expect(result().operations.map(item => item.operationId)).toEqual(['清理已重试'])
  })

  it('替换定稿的后续影响：显示后一次读到的影响', async () => {
    const result = await renderHook(() => useReplacementImpacts(projectA.path))
    await act(async () => globalEventBus.emit('REFRESH_RESOURCE', { resources: ['drafts'], projectPath: projectA.path, projectSession: sessionOf(projectA) }))
    const [older, newer] = pending('chapter:replacement-impacts')

    await answer(newer, { success: true, impacts: [impact(5)] })
    await answer(older, { success: true, impacts: [impact(2), impact(3)] })

    expect(result().impacts.map(item => item.chapterNumber)).toEqual([5])
  })

  it('回收站：显示后一次读到的条目', async () => {
    const result = await renderHook(() => useChapterTrash())
    await act(async () => globalEventBus.emit('CHAPTER_DELETION_UPDATED', { projectPath: projectA.path, projectSession: sessionOf(projectA) }))
    const [older, newer] = pending('chapter:trash-list')

    await answer(newer, { success: true, entries: [], damaged: [] })
    await answer(older, { success: true, entries: [trashed(4)], damaged: [] })

    expect(result()?.entries).toEqual([])
  })

  it('书房预览：先点的书后读到，概览仍是后点的那本', async () => {
    useProjectStore.setState({ currentProject: null, recentProjects: [
      { ...projectA, name: '雨夜列车', previewCapabilityId: 'peek-a' },
      { ...projectB, name: '雪国', previewCapabilityId: 'peek-b' },
    ] as unknown as ProjectData[] })
    setActiveProjectSessionContext(null)
    const result = await renderHook(() => useShelfOverview())
    const [bookA] = result().recentProjects
    await act(async () => bookA!.onPreview())
    await act(async () => result().recentProjects[1]!.onPreview())
    const [older, newer] = pending('project:peek-overview')

    await answer(newer, { state: 'ready', title: '雪国' })
    await answer(older, { state: 'ready', title: '雨夜列车' })

    expect(result().selectedId).toBe('peek-b')
    expect(result().overview).toEqual({ state: 'ready', title: '雪国' })
  })

  it('书房当前作品：换了作品后，前一部作品的概览晚到也不显示', async () => {
    const result = await renderHook(() => useShelfOverview())
    openProject(projectB)
    await act(async () => { await Promise.resolve() })
    const [older, newer] = pending('project:overview-current')

    await answer(newer, { state: 'ready', title: '雪国' })
    await answer(older, { state: 'ready', title: '雨夜列车' })

    expect(result().overview).toEqual({ state: 'ready', title: '雪国' })
  })

  it('书房当前作品：同一会话读了两次（StrictMode 重放），先发的那次后回来也不盖掉后一次', async () => {
    const result = await renderHook(() => useShelfOverview(), { strict: true })
    const [older, newer] = pending('project:overview-current')

    await answer(newer, { state: 'ready', title: '雨夜列车 · 新' })
    await answer(older, { state: 'ready', title: '雨夜列车 · 旧' })

    expect(result().overview).toEqual({ state: 'ready', title: '雨夜列车 · 新' })
  })
})
