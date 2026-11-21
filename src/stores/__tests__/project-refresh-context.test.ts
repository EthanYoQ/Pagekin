import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectData } from '../../shared/ipc-channels'
import { checkArchStatus, getBlueprintCount } from '../../services/architecture-service'
import { useDraftStore } from '../draft-store'
import { useLayoutStore } from '../layout-store'
import { navigate } from '../navigation/navigation-intents'
import { useStageStore } from '../navigation/stage-store'
import { useProjectStore } from '../project-store'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../services/ipc-client', () => ({
  ipc: {
    invoke,
    invokeWithProjectSession: (_context: unknown, channel: string, ...args: unknown[]) => (
      invoke(channel, ...args)
    ),
  },
}))

vi.mock('../../services/project-service', () => ({
  onProjectOpening: vi.fn(),
  onProjectOpened: vi.fn(async () => undefined),
  onProjectClosed: vi.fn(),
}))

function project(key: 'A' | 'B'): ProjectData {
  return {
    id: key,
    name: key,
    path: `C:\\novels\\${key}`,
    sessionLease: `lease-${key}`,
    novelConfig: {
      genre: '玄幻',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 3,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '',
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  invoke.mockReset()
  useProjectStore.setState({
    currentProject: project('A'),
    projectSessionEpoch: 0,
    loading: false,
  })
  useDraftStore.setState({
    draftsByChapter: {},
    loading: false,
    dataProjectKey: null,
    loadingProjectKey: null,
  })
})

describe('project refresh context', () => {
  describe('新外壳：打开作品的默认落点在提交时就落下，之后作者的导航不被收尾改回', () => {
    async function openBWithSlowRecentList(before: () => void, during: () => void) {
      const originals = [useLayoutStore.getState(), useStageStore.getState()] as const
      const recent = deferred<unknown[]>()
      const recentRequested = deferred<void>()
      useStageStore.setState({ sheet: null, focus: false })
      before()
      invoke.mockImplementation((channel: string, targetPath: string, requestToken: string) => {
        if (channel === 'project:open') return Promise.resolve({
          success: true, project: project('B'), requestToken, activeProjectPath: targetPath, databaseRestored: true, dbReady: true,
        })
        if (channel === 'project:recent-list') {
          recentRequested.resolve()
          return recent.promise
        }
        return Promise.resolve([])
      })
      try {
        const opening = useProjectStore.getState().openProject(project('B').path)
        await Promise.race([recentRequested.promise, opening])
        expect(invoke).toHaveBeenCalledWith('project:recent-list')
        during()
        recent.resolve([])
        await expect(opening).resolves.toBe(true)
        return { layout: useLayoutStore.getState(), sheet: useStageStore.getState().sheet }
      } finally {
        recent.resolve([])
        useLayoutStore.setState(originals[0], true)
        useStageStore.setState(originals[1], true)
      }
    }

    it('从书房打开后进了作品又立刻回到书房：留在书房，不被换回作品', async () => {
      const after = await openBWithSlowRecentList(
        () => useLayoutStore.setState({ sidebarView: 'home', settingsOpen: false }),
        () => {
          navigate({ kind: 'stage' })
          useLayoutStore.getState().setSidebarView('home')
        },
      )
      expect(after.layout.sidebarView).toBe('home')
    })

    it('加载完成前打开的运行侧页留着', async () => {
      const after = await openBWithSlowRecentList(
        () => useLayoutStore.setState({ sidebarView: 'project', settingsOpen: false }),
        () => navigate({ kind: 'run', facet: 'tasks' }),
      )
      expect(after.sheet).toEqual({ kind: 'run', tab: 'active', runId: undefined })
    })
  })

  it('commits only the latest project-open request when IPC replies out of order', async () => {
    const openAResult = deferred<unknown>()
    const openBResult = deferred<unknown>()
    const requestTokens = new Map<string, string>()
    const openARequested = deferred<void>()
    const openBRequested = deferred<void>()
    invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'project:open') {
        const [projectPath, requestToken] = args as [string, string]
        requestTokens.set(projectPath, requestToken)
        if (projectPath === project('A').path) {
          openARequested.resolve()
          return openAResult.promise
        }
        openBRequested.resolve()
        return openBResult.promise
      }
      if (channel === 'project:get-runtime-context') {
        return Promise.resolve({ activeProjectPath: project('B').path, dbReady: true })
      }
      return Promise.resolve([])
    })

    const openingA = useProjectStore.getState().openProject(project('A').path)
    await Promise.race([openARequested.promise, openingA])
    expect(requestTokens.get(project('A').path)).toBeTypeOf('string')
    const openingB = useProjectStore.getState().openProject(project('B').path)

    await Promise.race([openBRequested.promise, openingB])
    expect(requestTokens.get(project('B').path)).toBeTypeOf('string')
    openBResult.resolve({
      success: true,
      project: project('B'),
      requestToken: requestTokens.get(project('B').path),
      activeProjectPath: project('B').path,
      databaseRestored: true,
      dbReady: true,
    })
    await expect(openingB).resolves.toBe(true)
    openAResult.resolve({
      success: false,
      project: null,
      requestToken: requestTokens.get(project('A').path),
      stale: true,
      activeProjectPath: project('B').path,
      databaseRestored: true,
      dbReady: true,
    })
    await expect(openingA).resolves.toBe(false)

    expect(useProjectStore.getState().currentProject?.path).toBe(project('B').path)
    expect(useProjectStore.getState().loading).toBe(false)
    const openCalls = invoke.mock.calls.filter(([channel]) => channel === 'project:open')
    expect(openCalls).toHaveLength(2)
    expect(openCalls[0]?.[3]).toBe(project('A').path)
    expect(openCalls[1]?.[3]).toBe(project('A').path)
  })

  it('does not settle a save after a same-path reopen has issued a new lease', async () => {
    const saveA = deferred<{ success: boolean }>()
    invoke.mockImplementation((channel: string) => {
      if (channel === 'project:save') return saveA.promise
      return Promise.resolve([])
    })

    const saving = useProjectStore.getState().saveProject()
    useProjectStore.setState({
      currentProject: {
        ...project('A'),
        path: 'c:/NOVELS/A/',
        sessionLease: 'lease-A-reopened',
      },
    })
    saveA.resolve({ success: true })

    await expect(saving).resolves.toBe(false)
  })

  it('does not let a delayed project A open failure clear project B', async () => {
    const recentA = deferred<unknown[]>()
    const recentARequested = deferred<void>()
    let recentListCalls = 0
    invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'project:open') {
        const [projectPath, requestToken] = args as [string, string]
        return Promise.resolve({
          success: true,
          project: projectPath === project('A').path ? project('A') : project('B'),
          requestToken,
          activeProjectPath: projectPath,
        })
      }
      if (channel === 'project:recent-list' && ++recentListCalls === 1) {
        recentARequested.resolve()
        return recentA.promise
      }
      return Promise.resolve([])
    })

    const openingA = useProjectStore.getState().openProject(project('A').path)
    await Promise.race([recentARequested.promise, openingA])
    expect(invoke).toHaveBeenCalledWith('project:recent-list')
    const openingB = useProjectStore.getState().openProject(project('B').path)
    await expect(openingB).resolves.toBe(true)
    recentA.reject(new Error('late A recent-list failure'))
    await expect(openingA).resolves.toBe(false)

    expect(useProjectStore.getState().currentProject?.path).toBe(project('B').path)
  })

  it('does not commit delayed project A drafts after switching to project B', async () => {
    const draftsA = deferred<unknown[]>()
    invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'db:draft-list-all' && args[0] === project('A').path) {
        return draftsA.promise
      }
      return Promise.resolve([])
    })

    const refreshA = useDraftStore.getState().loadAllDrafts(project('A').path)
    useProjectStore.setState({ currentProject: project('B') })
    const projectBDraft = {
      id: 2,
      chapterNumber: 2,
      chapterTitle: '项目 B 标题',
      version: 1,
      status: 'finalized',
      source: 'write',
      wordCount: 8,
      createdAt: '2026-08-29T00:00:00.000Z',
      fileName: 'draft_v1.md',
      filePath: 'ai-novel://draft/2',
    } as const
    useDraftStore.setState({ draftsByChapter: { 2: [projectBDraft] } })
    draftsA.resolve([{
      ...projectBDraft,
      id: 1,
      chapterNumber: 1,
      chapterTitle: '迟到的项目 A 标题',
    }])
    await refreshA

    expect(useDraftStore.getState().draftsByChapter).toEqual({ 2: [projectBDraft] })
    expect(invoke).toHaveBeenCalledWith('db:draft-list-all', project('A').path)
  })

  it('discovers finalized author manuscript chapters even when the project has no blueprints', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'db:draft-list-all') {
        return Promise.resolve([
          {
            id: 1,
            chapterNumber: 1,
            chapterTitle: '蓝镜初亮',
            version: 1,
            status: 'finalized',
            source: 'write',
            wordCount: 18,
            createdAt: '2026-08-29T00:00:00.000Z',
          },
          {
            id: 2,
            chapterNumber: 2,
            chapterTitle: '潮线回声',
            version: 1,
            status: 'finalized',
            source: 'write',
            wordCount: 18,
            createdAt: '2026-08-29T00:00:00.000Z',
          },
        ])
      }
      return Promise.resolve([])
    })

    await useDraftStore.getState().loadAllDrafts(project('A').path)

    expect(invoke).toHaveBeenCalledWith('db:draft-list-all', project('A').path)
    expect(invoke).not.toHaveBeenCalledWith('db:blueprint-get-all', project('A').path)
    expect(useDraftStore.getState().draftsByChapter).toMatchObject({
      1: [{ id: 1, chapterNumber: 1, chapterTitle: '蓝镜初亮', status: 'finalized', filePath: 'ai-novel://draft/1' }],
      2: [{ id: 2, chapterNumber: 2, chapterTitle: '潮线回声', status: 'finalized', filePath: 'ai-novel://draft/2' }],
    })
  })

  it('unbinds project A drafts synchronously and rejects its delayed response', async () => {
    const draftsA = deferred<unknown[]>()
    invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'db:draft-list-all' && args[0] === project('A').path) {
        return draftsA.promise
      }
      return Promise.resolve([])
    })
    useDraftStore.setState({
      draftsByChapter: { 1: [] },
      dataProjectKey: project('A').path,
    })

    const refreshA = useDraftStore.getState().loadAllDrafts(project('A').path)
    useDraftStore.getState().beginProjectLoad(project('B').path)

    expect(useDraftStore.getState()).toMatchObject({
      draftsByChapter: {},
      loading: true,
      dataProjectKey: null,
      loadingProjectKey: project('B').path,
    })

    draftsA.resolve([])
    await refreshA
    expect(useDraftStore.getState()).toMatchObject({
      draftsByChapter: {},
      dataProjectKey: null,
      loadingProjectKey: project('B').path,
    })
  })

  it('passes the frozen project path through architecture and blueprint status reads', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'db:project-core-get') {
        return Promise.resolve({
          premise: 'A'.repeat(51),
          charactersArch: '',
          worldbuilding: '',
          synopsis: '',
        })
      }
      if (channel === 'db:character-roster-read') {
        return Promise.resolve({ status: 'empty', renderedMarkdown: '' })
      }
      if (channel === 'db:blueprint-get-all') return Promise.resolve([{ chapterNumber: 1 }])
      return Promise.resolve(null)
    })

    const projectA = project('A')
    const projectSession = {
      projectId: projectA.id,
      leaseId: projectA.sessionLease!,
      projectPath: projectA.path,
    }
    await expect(checkArchStatus(projectSession)).resolves.toMatchObject({ premise: true })
    await expect(getBlueprintCount(projectSession)).resolves.toBe(1)
    expect(invoke).toHaveBeenCalledWith('db:project-core-get', project('A').path)
    expect(invoke).toHaveBeenCalledWith('db:character-roster-read', project('A').path)
    expect(invoke).toHaveBeenCalledWith('db:blueprint-get-all', project('A').path)
  })
})
