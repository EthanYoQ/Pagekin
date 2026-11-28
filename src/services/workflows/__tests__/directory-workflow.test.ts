import type { DirectoryGenerationProgress } from '../../../shared/generation-owner-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  resolveDirectoryContinuation,
  terminalDirectoryProgress,
  commitDirectoryBlueprintRange,
  parseTextBlueprints,
  parseTextBlueprintsStrict,
  createDirectoryWorkflow,
  saveAllBlueprints,
  saveChapterBlueprint,
  type ChapterBlueprint,
} from '../directory-workflow'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import type { ProjectData } from '../../../shared/ipc-channels'
import type { StepCallbacks, WorkflowContext } from '../../../stores/workflow-store'
import { StructuredContractDiagnostic } from '../../../shared/structured-contract-diagnostic'
import { globalEventBus } from '../../../shared/event-bus'
import { TerminalProviderFailureError } from '../../generation/generation-harness'
import { isWorkflowCancellation } from '../workflow-cancellation'
import { shown } from '../../../i18n/__tests__/shown-locale'
import { expectEndedWith, shownFailure } from '../../../stores/__tests__/run-failure-expect'

const blueprint: ChapterBlueprint = {
  chapterNumber: 1,
  title: '启程',
  role: '建置',
  purpose: '引出主角目标',
  keyEvents: '主角发现异常',
  characters: ['主角'],
  relationshipHints: [],
  suspenseHook: '门外传来敲门声',
  userGuidance: '',
  notes: '',
  notesUpdatedAt: '',
}

function stubIpcInvoke(result: unknown) {
  const invoke = vi.fn().mockResolvedValue(result)
  vi.stubGlobal('window', {
    aiNovelAPI: {
      invoke,
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(),
    },
  })
  return invoke
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useProjectStore.setState({ currentProject: null })
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useWorkflowStore.setState({
    activeRuns: [],
    history: [],
    globalLogs: [],
    waitingRuns: {},
    currentRun: null,
    waitingForConfirm: false,
    waitingAfterStepIndex: -1,
  })
})

function project(path: string): ProjectData {
  return {
    id: path,
    name: path,
    path,
    sessionLease: `lease-${path}`,
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

function workflowStep(name: string) {
  return {
    id: name,
    name,
    description: name,
    status: 'running' as const,
    logs: [],
  }
}

describe('parseTextBlueprints', () => {
  it('parses object responses with a blueprints array', () => {
    const result = parseTextBlueprints(
      JSON.stringify({
        blueprints: [
          {
            chapterNumber: 1,
            title: '启程',
            role: '建置',
            purpose: '引出主角目标',
            keyEvents: '主角发现异常',
            characters: ['主角'],
            relationships: [],
            suspenseHook: '门外传来敲门声',
          },
        ],
      }),
      1,
      3,
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      chapterNumber: 1,
      title: '启程',
      role: '建置',
      purpose: '引出主角目标',
      keyEvents: '主角发现异常',
      characters: ['主角'],
      suspenseHook: '门外传来敲门声',
    })
  })

  it('parses bare array responses', () => {
    const result = parseTextBlueprints(
      JSON.stringify([
        {
          chapter_number: 2,
          title: '暗线',
          role: '铺垫',
          purpose: '让主角发现反派留下的暗线',
          key_events: '反派留下线索',
          characters: ['主角'],
          relationships: [],
          suspense_hook: '线索指向故人',
        },
      ]),
      1,
      3,
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      chapterNumber: 2,
      title: '暗线',
      role: '铺垫',
      keyEvents: '反派留下线索',
      suspenseHook: '线索指向故人',
    })
  })

  it('parses fenced JSON responses', () => {
    const result = parseTextBlueprints(
      [
        '```json',
        '[',
        '{"chapterNumber":3,"title":"交锋","role":"高潮","purpose":"迫使主角正面抉择","keyEvents":"主角正面迎敌","characters":["主角"],"relationships":[],"suspenseHook":"敌人揭下面具"}',
        ']',
        '```',
      ].join('\n'),
      1,
      3,
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      chapterNumber: 3,
      title: '交锋',
      keyEvents: '主角正面迎敌',
    })
  })

  it('returns an empty array for bad JSON in non-strict parsing', () => {
    expect(parseTextBlueprints('{not json', 1, 3)).toEqual([])
  })

  it('rejects repeated chapters instead of choosing one model answer', () => {
    const result = parseTextBlueprints(
      JSON.stringify({
        blueprints: [
          { ...blueprint, chapterNumber: 1, title: '第一版', relationships: [] },
          { ...blueprint, chapterNumber: 1, title: '第二版', relationships: [] },
          { ...blueprint, chapterNumber: 2, title: '第二章', relationships: [] },
        ],
      }),
      1,
      3,
    )

    expect(result).toEqual([])
  })

  it('filters chapters outside the requested range', () => {
    const result = parseTextBlueprints(
      JSON.stringify([
        { ...blueprint, chapterNumber: 1, title: '范围外', relationships: [] },
        { ...blueprint, chapterNumber: 2, title: '范围内', relationships: [] },
        { ...blueprint, chapterNumber: 4, title: '范围外', relationships: [] },
      ]),
      2,
      3,
    )

    expect(result.map((item) => item.chapterNumber)).toEqual([2])
  })

  it('returns an empty array when no chapters survive filtering', () => {
    expect(parseTextBlueprints(JSON.stringify([{ ...blueprint, chapterNumber: 9, relationships: [] }]), 1, 3)).toEqual([])
  })
})

describe('parseTextBlueprintsStrict', () => {
  it('preserves author recovery fields exactly while model parsing retains its existing persistence boundary', () => {
    const fields = { userGuidance: '  作者指导。\r\n', notes: '<think>作者原文</think>', notesUpdatedAt: '2026-10-04T13:00:00.000Z' }
    const raw = JSON.stringify([{ ...blueprint, ...fields }])
    expect(parseTextBlueprintsStrict(raw, 1, 1, shown('zh-CN'), 'author')[0]).toMatchObject(fields)
    expect(parseTextBlueprintsStrict(raw, 1, 1, shown('zh-CN'))[0]).toMatchObject({ userGuidance: '', notes: '', notesUpdatedAt: '' })
    expect(() => parseTextBlueprintsStrict(JSON.stringify([{ ...blueprint, notes: 123 }]), 1, 1, shown('zh-CN'), 'author')).toThrow('invalid_type')
  })
  it('returns parsed blueprints for valid array input', () => {
    const result = parseTextBlueprintsStrict(JSON.stringify([{ ...blueprint, relationships: [] }]), 1, 1, shown('zh-CN'))

    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('启程')
  })

  it('throws when JSON is malformed', () => {
    try {
      parseTextBlueprintsStrict('{not json', 1, 3, shown('zh-CN'))
      expect.unreachable('expected typed structured diagnostic')
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredContractDiagnostic)
      expect(error).toMatchObject({ code: 'invalid_json', path: '$', field: '$' })
    }
  })

  it('rejects an out-of-range chapter instead of silently filtering it', () => {
    expect(() => parseTextBlueprintsStrict(
      JSON.stringify([{ ...blueprint, chapterNumber: 9, relationships: [] }]),
      1,
      3,
      shown('zh-CN'),
    )).toThrow('结构化合同诊断 code=unexpected_item path=blueprints field=blueprints')
  })

  it('rejects duplicate chapter numbers instead of hiding them during normalization', () => {
    expect(() => parseTextBlueprintsStrict(
      JSON.stringify([
        { ...blueprint, chapterNumber: 1, title: '第一次', relationships: [] },
        { ...blueprint, chapterNumber: 1, title: '第二次', relationships: [] },
      ]),
      1,
      1,
      shown('zh-CN'),
    )).toThrow('结构化合同诊断 code=duplicate_item path=blueprints field=blueprints')
  })

  it('rejects a structurally valid JSON blueprint when required semantic facts are missing', () => {
    const incomplete = { ...blueprint } as Record<string, unknown>
    delete incomplete.relationshipHints

    expect(() => parseTextBlueprintsStrict(JSON.stringify([incomplete]), 1, 1, shown('zh-CN')))
      .toThrow('结构化合同诊断 code=missing_field path=blueprints[0].relationships field=relationships')
  })
})

describe('blueprint persistence helpers', () => {
  const session = { projectId: 'NovelA', leaseId: 'lease-NovelA', projectPath: 'C:/NovelA' }

  it('throws when saving one blueprint returns an IPC failure', async () => {
    stubIpcInvoke({ success: false, failure: { code: 'PROJECT_NOT_OPEN' } })

    await expect(saveChapterBlueprint(blueprint, 'C:/NovelA', session, shown('zh-CN'))).rejects.toThrow(/^请先打开项目。$/u)
  })

  it('英文界面下主进程拒绝保存蓝图：报英文说明，不转出主进程的中文原文（#471）', async () => {
    stubIpcInvoke({ success: false, failure: { code: 'BLUEPRINT_WRITE_FAILED', note: { key: 'error.blueprintWriteFailed' } } })

    const english = /^Your existing chapter blueprints are all still there\. This change could not be saved to the project\. Try again\.$/u
    await expect(saveChapterBlueprint(blueprint, 'C:/NovelA', session, shown('en-US'))).rejects.toThrow(english)
    await expect(saveAllBlueprints([blueprint], 'C:/NovelA', session, shown('en-US'))).rejects.toThrow(english)
  })

  it('throws when saving many blueprints returns an IPC failure', async () => {
    stubIpcInvoke({ success: false, failure: { code: 'BLUEPRINT_WRITE_FAILED', note: { key: 'error.blueprintWriteFailed' } } })

    await expect(saveAllBlueprints([blueprint], 'C:/NovelA', session, shown('zh-CN'))).rejects.toThrow(/^已有的章节蓝图都还在。这次修改没能写进作品，请再试一次。$/u)
  })

  it('日文界面下保存蓝图失败用目录里的日文说明；主进程回的原文不显示（#939）', async () => {
    const japanese = /^既存の章のブループリントはすべて残っています。この変更はプロジェクトに保存できませんでした。もう一度お試しください。$/u
    stubIpcInvoke({ success: false, failure: { code: 'BLUEPRINT_WRITE_FAILED', note: { key: 'error.blueprintWriteFailed' } } })
    await expect(saveChapterBlueprint(blueprint, 'C:/NovelA', session, shown('ja-JP'))).rejects.toThrow(japanese)

    stubIpcInvoke({ success: false, error: '数据库已锁定' })
    await expect(saveAllBlueprints([blueprint], 'C:/NovelA', session, shown('ja-JP'))).rejects.toThrow(japanese)
  })

  it('resolves when the IPC save succeeds', async () => {
    const invoke = stubIpcInvoke({ success: true })

    await expect(saveAllBlueprints([blueprint], 'C:/NovelA', session, shown('zh-CN'))).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('db:blueprint-upsert-many', [blueprint], 'C:/NovelA', session)
  })

  it('returns the atomic range-commit receipt from the main-process seam', async () => {
    const receipt = {
      mode: 'replace-range',
      operationId: 'directory-run-1',
      payloadHash: 'a'.repeat(64),
      idempotent: false,
      startChapter: 1,
      endChapter: 1,
      chapterNumbers: [1],
      snapshot: [blueprint],
      characterSyncInput: [blueprint],
    }
    const invoke = stubIpcInvoke({ success: true, receipt })
    const refreshEvents: unknown[] = []
    const unsubscribe = globalEventBus.on('REFRESH_RESOURCE', payload => refreshEvents.push(payload))

    await expect(commitDirectoryBlueprintRange(
      [blueprint],
      'C:/NovelA',
      { mode: 'replace-range', startChapter: 1, endChapter: 1 },
      'directory-run-1',
      session,
      shown('zh-CN'),
    )).resolves.toEqual(receipt)
    expect(invoke).toHaveBeenCalledWith(
      'db:blueprint-commit-range',
      {
        mode: 'replace-range',
        operationId: 'directory-run-1',
        startChapter: 1,
        endChapter: 1,
        blueprints: [blueprint],
      },
      'C:/NovelA',
      session,
    )
    unsubscribe()
    expect(refreshEvents).toEqual([{
      resources: ['blueprints'],
      projectPath: 'C:/NovelA',
      projectSession: session,
    }])
  })

  it.each([
    [{ success: false, failure: { code: 'BLUEPRINT_WRITE_FAILED', note: { key: 'error.blueprintWriteFailed' } } }],
    [{ success: true }],
  ])('does not announce blueprint refresh without a committed receipt', async (result) => {
    stubIpcInvoke(result)
    const refreshEvents: unknown[] = []
    const unsubscribe = globalEventBus.on('REFRESH_RESOURCE', payload => refreshEvents.push(payload))

    await expect(commitDirectoryBlueprintRange(
      [blueprint],
      'C:/NovelA',
      { mode: 'replace-range', startChapter: 1, endChapter: 1 },
      'directory-run-1',
      session,
      shown('zh-CN'),
    )).rejects.toThrow()
    unsubscribe()

    expect(refreshEvents).toEqual([])
  })

  it('英文界面下提交蓝图被主进程拒绝：报英文说明（#471）', async () => {
    stubIpcInvoke({ success: false, failure: { code: 'BLUEPRINT_WRITE_FAILED', note: { key: 'error.blueprintWriteFailed' } } })

    await expect(commitDirectoryBlueprintRange(
      [blueprint],
      'C:/NovelA',
      { mode: 'replace-range', startChapter: 1, endChapter: 1 },
      'directory-run-1',
      session,
      shown('en-US'),
    )).rejects.toThrow(/^Could not commit the chapter blueprints\.$/u)
  })
})

describe('directory workflow project context', () => {
  it('uses the requested English locale when launch validation fails', () => {
    useProjectStore.setState({ currentProject: project('C:\\novels\\Other') })

    expect(() => createDirectoryWorkflow(
      { mode: 'full' },
      'C:\\novels\\Expected',
      {
        projectId: 'C:\\novels\\Expected',
        leaseId: 'lease-C:\\novels\\Expected',
        projectPath: 'C:\\novels\\Expected',
      },
      'en-US',
    )).toThrow('The project changed, so chapter-blueprint generation could not start.')
  })

  it('freezes the chapter word target used by the directory command at launch', async () => {
    const projectA = project('C:\\novels\\Frozen-capacity')
    projectA.novelConfig.wordsPerChapter = 900
    useProjectStore.setState({ currentProject: projectA })
    const projectSession = {
      projectId: projectA.id,
      leaseId: projectA.sessionLease!,
      projectPath: projectA.path,
    }
    const directoryCommand = await import('../commands/directory.command')
    const execute = vi.spyOn(directoryCommand.GenerateDirectoryCommand.prototype, 'execute')
      .mockImplementation(async function (this: unknown) {
        const snapshot = (this as unknown as {
          projectSnapshot: { novelConfig: { wordsPerChapter?: number } }
        }).projectSnapshot
        expect(snapshot.novelConfig.wordsPerChapter).toBe(900)
        return []
      })
    const workflow = createDirectoryWorkflow({ mode: 'full' }, projectA.path, projectSession)
    useProjectStore.setState({
      currentProject: {
        ...projectA,
        novelConfig: { ...projectA.novelConfig, wordsPerChapter: 6000 },
      },
    })

    await expect(workflow.steps[1].executor(
      workflowStep('生成蓝图'),
      {
        runId: 'frozen-capacity-run',
        projectPath: projectA.path,
        projectSession,
        writingLanguage: 'zh-CN',
        uiLocale: 'zh-CN', interfaceLocale: shown('zh-CN'),
        data: {},
        cancelled: false,
      },
      { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
    )).resolves.toBe('已生成 0 章蓝图')
    expect(execute).toHaveBeenCalledOnce()
  })

  it('keeps architecture validation errors in the locale frozen at launch', async () => {
    const projectA = project('C:\\novels\\English-errors')
    const projectSession = {
      projectId: projectA.id,
      leaseId: projectA.sessionLease!,
      projectPath: projectA.path,
    }
    useProjectStore.setState({ currentProject: projectA })
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    const invoke = stubIpcInvoke(null)
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:project-core-get') return null
      return []
    })
    const workflow = createDirectoryWorkflow({ mode: 'full' }, projectA.path, projectSession)
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })

    await expect(workflow.steps[0].executor(
      workflowStep('Read architecture'),
      {
        runId: 'english-error-run',
        projectPath: projectA.path,
        projectSession,
        writingLanguage: 'zh-CN',
        uiLocale: 'en-US', interfaceLocale: shown('en-US'),
        data: {},
        cancelled: false,
      },
      { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
    )).rejects.toThrow('Project core data has not been initialized.')
  })

  it('does not expose a directory command failure through the frozen English workflow UI', async () => {
    const projectA = project('C:\\novels\\English-command-error')
    const projectSession = {
      projectId: projectA.id,
      leaseId: projectA.sessionLease!,
      projectPath: projectA.path,
    }
    useProjectStore.setState({ currentProject: projectA })
    const directoryCommand = await import('../commands/directory.command')
    vi.spyOn(directoryCommand.GenerateDirectoryCommand.prototype, 'execute')
      .mockRejectedValue(new Error('provider-secret-directory-failure'))
    const workflow = createDirectoryWorkflow(
      { mode: 'full' },
      projectA.path,
      projectSession,
      'en-US',
    )

    let failure: unknown
    try {
      await workflow.steps[1].executor(
        workflowStep('Generate blueprints'),
        {
          runId: 'english-command-error-run',
          projectPath: projectA.path,
          projectSession,
          writingLanguage: 'zh-CN',
          uiLocale: 'en-US', interfaceLocale: shown('en-US'),
          data: {},
          cancelled: false,
        },
        { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
      )
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('Your existing blueprints are unchanged. Generation failed. Click Generate blueprints to try again.')
    expect((failure as Error).message).not.toContain('provider-secret-directory-failure')
  })

  it('passes a provider context-length rejection through instead of asking to retry', async () => {
    const projectA = project('C:\\novels\\English-context-length')
    const projectSession = { projectId: projectA.id, leaseId: projectA.sessionLease!, projectPath: projectA.path }
    useProjectStore.setState({ currentProject: projectA })
    const directoryCommand = await import('../commands/directory.command')
    vi.spyOn(directoryCommand.GenerateDirectoryCommand.prototype, 'execute').mockRejectedValue(new TerminalProviderFailureError('GENERATION_CONTEXT_LENGTH_EXCEEDED', {} as never))
    const workflow = createDirectoryWorkflow({ mode: 'full' }, projectA.path, projectSession, 'en-US')
    await expect(workflow.steps[1].executor(workflowStep('Generate blueprints'), { runId: 'context-length-run', projectPath: projectA.path, projectSession,
      writingLanguage: 'zh-CN', uiLocale: 'en-US', interfaceLocale: shown('en-US'), data: {}, cancelled: false }, { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }))
      .rejects.toThrow(/^GENERATION_CONTEXT_LENGTH_EXCEEDED$/u)
  })

  it('取消请求之后蓝图生成真的失败了：照常报生成失败，不改写成取消', async () => {
    const projectA = project('C:\\novels\\cancel-window-failure')
    const projectSession = { projectId: projectA.id, leaseId: projectA.sessionLease!, projectPath: projectA.path }
    useProjectStore.setState({ currentProject: projectA })
    const context: WorkflowContext = { runId: 'cancel-window-failure-run', projectPath: projectA.path, projectSession,
      writingLanguage: 'zh-CN', uiLocale: 'zh-CN', interfaceLocale: shown('zh-CN'), data: {}, cancelled: false }
    const directoryCommand = await import('../commands/directory.command')
    vi.spyOn(directoryCommand.GenerateDirectoryCommand.prototype, 'execute').mockImplementation(async () => {
      context.cancelled = true
      throw Object.assign(new Error('蓝图提交失败'), { code: 'GENERATION_STORAGE_FAILED' })
    })
    const workflow = createDirectoryWorkflow({ mode: 'full' }, projectA.path, projectSession, 'zh-CN')
    const failure = await workflow.steps[1].executor(workflowStep('生成蓝图'), context, { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() })
      .then(() => new Error('generation did not fail'), (error: unknown) => error)
    expect(isWorkflowCancellation(failure)).toBe(false)
    expect((failure as Error).message).toBe('原有蓝图未改动。蓝图生成失败，请点「AI 生成蓝图」重试。')
  })

  it.each(['GENERATION_STORAGE_FAILED', 'ROOT_BUDGET_EXHAUSTED'])('取消请求之后蓝图批次以 %s 失败：运行和这一步都记失败并带原码，说明不转出原文', async code => {
    const projectA = project('C:\\novels\\cancel-window-coded-failure')
    const projectSession = { projectId: projectA.id, leaseId: projectA.sessionLease!, projectPath: projectA.path }
    useProjectStore.setState({ currentProject: projectA })
    stubIpcInvoke([]).mockImplementation(async (channel: string) => channel === 'fs:check-exists' ? false : [])
    const directoryCommand = await import('../commands/directory.command')
    vi.spyOn(directoryCommand.GenerateDirectoryCommand.prototype, 'execute').mockImplementation(async () => {
      useWorkflowStore.getState().cancelWorkflow('cancel-window-coded-failure-run')
      throw Object.assign(new Error('provider-secret-blueprint-failure'), { code })
    })
    const workflow = createDirectoryWorkflow({ mode: 'full' }, projectA.path, projectSession, 'zh-CN')
    await useWorkflowStore.getState().startWorkflow({ ...workflow, runId: 'cancel-window-coded-failure-run', steps: [workflow.steps[1]] })

    const finished = useWorkflowStore.getState().history[0]
    expectEndedWith(finished, 'failed', code)
    expect(shownFailure(finished)).toBe('原有蓝图未改动。蓝图生成失败，请点「AI 生成蓝图」重试。')
    expectEndedWith(finished.steps[0], 'failed', code)
  })

  describe('一章都没提交时的失败说明写明保住了什么（#903）', () => {
    const runHandle = { projectId: 'p', rootActionId: 'root-903', runId: 'run-903', epoch: 'lease-903' }
    const readContext = (draft: string) => ({
      modelId: 'm', handle: runHandle, operation: 'chapter-blueprint-directory',
      planningContinuation: { sourceHandle: runHandle, remainingRange: { from: 13, to: 16 }, targetUnits: 1000, state: 'ready' },
      blueprintRecovery: { sourceHandle: runHandle, leaseEpoch: 'lease-903', draft, editRange: { from: 13, to: 16 }, saved: null, writeState: 'ready' },
      authorInputs: [], selectedDraftIds: [], selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: [], composition: null,
      lastCompositionFinishReason: null, attemptedPurposes: ['chapter-blueprint-directory'],
    })

    async function failGeneration(locale: 'zh-CN' | 'en-US' | 'ja-JP', options: { draft?: string; opened?: boolean; committed?: boolean; readFails?: boolean } = {}) {
      const projectA = project(`C:\\novels\\903-${locale}`)
      const projectSession = { projectId: projectA.id, leaseId: projectA.sessionLease!, projectPath: projectA.path }
      useProjectStore.setState({ currentProject: projectA })
      const invoke = stubIpcInvoke(null).mockImplementation(async (channel: string) => {
        if (channel === 'generation:read-context' && !options.readFails) return readContext(options.draft ?? '')
        throw new Error('GENERATION_LEDGER_UNREADABLE')
      })
      const context: WorkflowContext = { runId: `903-${locale}`, projectPath: projectA.path, projectSession, writingLanguage: 'zh-CN',
        uiLocale: locale === 'en-US' ? 'en-US' : 'zh-CN', interfaceLocale: shown(locale), data: {}, cancelled: false }
      const directoryCommand = await import('../commands/directory.command')
      vi.spyOn(directoryCommand.GenerateDirectoryCommand.prototype, 'execute').mockImplementation(async () => {
        if (options.opened !== false) context.mainGenerationRunHandle = runHandle
        if (options.committed) context.data.blueprintCommitReceipt = { startChapter: 13, endChapter: 16 }
        throw Object.assign(new Error('provider-secret-blueprint-failure'), { code: 'GENERATION_STORAGE_FAILED' })
      })
      const workflow = createDirectoryWorkflow({ mode: 'full' }, projectA.path, projectSession, locale === 'en-US' ? 'en-US' : 'zh-CN')
      const failure = await workflow.steps[1].executor(workflowStep('生成蓝图'), context, { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() })
        .then(() => new Error('generation did not fail'), (error: unknown) => error)
      return { failure: failure as Error & { code?: string }, invoke }
    }

    it('候选已进恢复稿：写明原有蓝图未改动、内容在恢复稿里，并带上稳定错误码', async () => {
      const { failure } = await failGeneration('zh-CN', { draft: '{"blueprints":[{"chapterNumber":13' })
      expect(failure.message).toBe('原有蓝图未改动，已生成的内容存入了恢复稿。蓝图生成失败，可点「编辑恢复稿」或重新生成。')
      expect(failure.message).not.toContain('provider-secret')
      expect(failure.code).toBe('GENERATION_STORAGE_FAILED')
    })

    it('英文、日文界面同样写明内容在恢复稿里', async () => {
      expect((await failGeneration('en-US', { draft: 'candidate' })).failure.message)
        .toBe('Your existing blueprints are unchanged, and the generated text is in the recovery draft. Generation failed. Click Edit recovery draft, or generate again.')
      expect((await failGeneration('ja-JP', { draft: 'candidate' })).failure.message)
        .toBe('既存のブループリントは変更されていません。生成した内容は復元稿にあります。生成に失敗したため、「Edit recovery draft」で編集するか、もう一度生成してください。')
    })

    it('恢复稿里没有内容：只写原有蓝图未改动、可重试，不提恢复稿', async () => {
      const { failure } = await failGeneration('zh-CN', { draft: '  ' })
      expect(failure.message).toBe('原有蓝图未改动。蓝图生成失败，请点「AI 生成蓝图」重试。')
      expect(failure.code).toBe('GENERATION_STORAGE_FAILED')
      expect((await failGeneration('en-US')).failure.message)
        .toBe('Your existing blueprints are unchanged. Generation failed. Click Generate blueprints to try again.')
      expect((await failGeneration('ja-JP')).failure.message)
        .toBe('既存のブループリントは変更されていません。生成に失敗しました。「Generate blueprints」からもう一度お試しください。')
    })

    it('运行没开起来：不读恢复稿，只写原有蓝图未改动', async () => {
      const { failure, invoke } = await failGeneration('zh-CN', { opened: false })
      expect(failure.message).toBe('原有蓝图未改动。蓝图生成失败，请点「AI 生成蓝图」重试。')
      expect(invoke).not.toHaveBeenCalled()
    })

    it('读恢复稿出错：不声称有恢复稿', async () => {
      const { failure } = await failGeneration('zh-CN', { readFails: true })
      expect(failure.message).toBe('原有蓝图未改动。蓝图生成失败，请点「AI 生成蓝图」重试。')
    })

    it('蓝图已提交后才失败：不说原有蓝图未改动', async () => {
      const { failure } = await failGeneration('zh-CN', { draft: 'candidate', committed: true })
      expect(failure.message).not.toMatch(/未改动|恢复稿/u)
      expect(failure.code).toBe('GENERATION_STORAGE_FAILED')
    })

    it('已部分提交：原样报出已保存的章节，不改写', async () => {
      const projectA = project('C:\\novels\\903-partial')
      const projectSession = { projectId: projectA.id, leaseId: projectA.sessionLease!, projectPath: projectA.path }
      useProjectStore.setState({ currentProject: projectA })
      stubIpcInvoke(null)
      const directoryCommand = await import('../commands/directory.command')
      const partial = new directoryCommand.DirectoryPartialCommitError({ startChapter: 13, endChapter: 14 } as never, { startChapter: 15, endChapter: 16 },
        {} as never, { code: 'DIRECTORY_PARTIAL_COMMIT' }, '已保存第 13–14 章完整蓝图；第 15–16 章未完成。原运行的候选与失败原因已保留。')
      vi.spyOn(directoryCommand.GenerateDirectoryCommand.prototype, 'execute').mockRejectedValue(partial)
      const workflow = createDirectoryWorkflow({ mode: 'full' }, projectA.path, projectSession, 'zh-CN')
      await expect(workflow.steps[1].executor(workflowStep('生成蓝图'), { runId: '903-partial', projectPath: projectA.path, projectSession, writingLanguage: 'zh-CN',
        uiLocale: 'zh-CN', interfaceLocale: shown('zh-CN'), data: {}, cancelled: false }, { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }))
        .rejects.toBe(partial)
    })
  })

  it('蓝图已提交后作者取消：运行记已取消，已取消的那一步写明蓝图已保存、角色同步可能未完成', async () => {
    const projectA = project('C:\\novels\\post-commit-cancel')
    const projectSession = { projectId: projectA.id, leaseId: projectA.sessionLease!, projectPath: projectA.path }
    useProjectStore.setState({ currentProject: projectA })
    stubIpcInvoke([]).mockImplementation(async (channel: string) => channel === 'fs:check-exists' ? false : [])
    const directoryCommand = await import('../commands/directory.command')
    vi.spyOn(directoryCommand.GenerateDirectoryCommand.prototype, 'execute').mockImplementation(async () => {
      useWorkflowStore.getState().cancelWorkflow('post-commit-cancel-run')
      throw new directoryCommand.DirectoryPostCommitCancellationError({
        startChapter: 1, endChapter: 3, characterSyncOperation: { operationId: 'sync-1' },
      } as never)
    })
    const workflow = createDirectoryWorkflow({ mode: 'full' }, projectA.path, projectSession, 'zh-CN')
    await useWorkflowStore.getState().startWorkflow({ ...workflow, runId: 'post-commit-cancel-run', steps: [workflow.steps[1]] })

    const finished = useWorkflowStore.getState().history[0]
    expect(finished).toMatchObject({ id: 'post-commit-cancel-run', status: 'cancelled' })
    expect(finished.steps[0]).toMatchObject({ status: 'cancelled' })
    expect(shownFailure(finished.steps[0])).toBe('章节蓝图已保存，但任务取消后角色同步可能未完成。')
  })

  it('freezes English workflow labels and user-visible logs at launch', async () => {
    const projectA = project('C:\\novels\\English')
    const projectSession = {
      projectId: projectA.id,
      leaseId: projectA.sessionLease!,
      projectPath: projectA.path,
    }
    useProjectStore.setState({ currentProject: projectA })
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    const invoke = stubIpcInvoke([])
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'fs:check-exists') return false
      if (channel === 'db:project-core-get') {
        return { premise: 'Story premise. '.repeat(12), charactersArch: '', worldbuilding: '', synopsis: '' }
      }
      return []
    })

    const definition = createDirectoryWorkflow({ mode: 'full' }, projectA.path, projectSession)
    await useWorkflowStore.getState().startWorkflow({ ...definition, steps: [definition.steps[0]] })

    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      uiLocale: 'en-US',
      title: 'Generate chapter blueprints (all)',
      status: 'completed',
      steps: [{
        name: 'Read architecture',
        description: 'Load the project architecture from SQLite',
        status: 'completed',
        result: 'Architecture loaded (1 section)',
        logs: [expect.stringContaining('Loading project architecture...')],
      }],
    })
    const messages = useWorkflowStore.getState().globalLogs.map(entry => entry.message).join('\n')
    expect(messages).toContain('[Started] Workflow "Generate chapter blueprints (all)" started')
    expect(messages).toContain('  Loading project architecture...')
    expect(messages).not.toMatch(/读取架构|生成蓝图|读取项目架构/u)
  })

  it('freezes the launch project and does not schedule a duplicate post-command save step', async () => {
    const projectA = project('C:\\novels\\A')
    useProjectStore.setState({ currentProject: projectA })
    const invoke = stubIpcInvoke({ success: true })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:project-core-get') {
        return {
          premise: '故事前提'.repeat(30),
          charactersArch: '',
          worldbuilding: '',
          synopsis: '',
        }
      }
      return []
    })
    const workflow = createDirectoryWorkflow({ mode: 'full' }, projectA.path, {
      projectId: projectA.id,
      leaseId: projectA.sessionLease!,
      projectPath: projectA.path,
    })
    expect(workflow.resourceKeys).toEqual(['blueprints', 'character-roster'])
    expect(workflow.readResourceKeys).toEqual(['novel-config', 'architecture'])
    const context: WorkflowContext = {
      runId: 'test-run',
      projectPath: projectA.path,
      projectSession: {
        projectId: projectA.id,
        leaseId: projectA.sessionLease!,
        projectPath: projectA.path,
      },
      writingLanguage: 'zh-CN',
      uiLocale: 'zh-CN', interfaceLocale: shown('zh-CN'),
      data: {
        newBlueprints: [blueprint],
        existingBlueprints: [],
      },
      cancelled: false,
    }
    const callbacks: StepCallbacks = {
      log: vi.fn(),
      setProgress: vi.fn(),
      appendText: vi.fn(),
    }

    await expect(workflow.steps[0].executor(workflowStep('读取架构'), context, callbacks))
      .resolves.toContain('架构加载完成')
    expect(invoke).toHaveBeenCalledWith('db:project-core-get', projectA.path, context.projectSession)

    expect(workflow.steps.map(step => step.name)).toEqual(['读取架构', '生成蓝图'])
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-upsert-many')
  })
})


describe('durable directory continuation selection', () => {
  const session = { projectId: '目录合成项目', leaseId: '重新打开会话', projectPath: 'C:/目录合成项目' }
  const handle = { projectId: session.projectId, epoch: '旧会话', rootActionId: '原预算根', runId: '原运行' }
  const base: DirectoryGenerationProgress = { authorInputs: [{ id: 'directory:pacing-guidance', text: '  缓慢递进。\r\n' }, { id: 'directory:author-config', text: JSON.stringify({ totalChapters: 200 }) }], operationId: '已保存范围', payloadHash: 'a'.repeat(64), sourceHandle: handle,
    requestedRange: { startChapter: 1, endChapter: 200 }, committedRange: { startChapter: 1, endChapter: 160 }, remainingRange: { startChapter: 161, endChapter: 200 } }
  function arrange(all: DirectoryGenerationProgress[]) {
    useProjectStore.setState({ currentProject: { ...project(session.projectPath), id: session.projectId, sessionLease: session.leaseId } })
    const invoke = stubIpcInvoke({ progress: all, diagnostics: [] })
    return invoke
  }
  it('overrides caller range from the exact committed receipt and retains the operation root', async () => {
    const invoke = arrange([base])
    await expect(resolveDirectoryContinuation({ mode: 'full', startChapter: 1, count: 200, continueDirectoryOperationId: base.operationId }, session, 'zh-CN'))
      .resolves.toMatchObject({ mode: 'append', pacingGuidance: '  缓慢递进。\r\n', startChapter: 161, count: 40, continueDirectoryOperationId: base.operationId })
    expect(invoke).toHaveBeenCalledWith('generation:list-directory-progress', session)
  })
  it('uses an issued exact handle after restart instead of starting the continuation twice', async () => {
    const continuationHandle = { ...handle, runId: '已有剩余运行' }
    arrange([{ ...base, continuationHandle }])
    await expect(resolveDirectoryContinuation({ mode: 'full', continueDirectoryOperationId: base.operationId }, session, 'zh-CN'))
      .resolves.toMatchObject({ startChapter: 161, count: 40, resumeHandle: continuationHandle, continueDirectoryOperationId: undefined })
  })
  it('follows only the explicit chain and never regenerates the already committed child prefix', async () => {
    const continuationHandle = { ...handle, runId: '已有剩余运行' }
    const parent = { ...base, continuationHandle }
    const child: DirectoryGenerationProgress = { ...base, operationId: '后续已保存', sourceHandle: { ...continuationHandle, epoch: session.leaseId },
      requestedRange: { startChapter: 161, endChapter: 200 }, committedRange: { startChapter: 161, endChapter: 180 }, remainingRange: { startChapter: 181, endChapter: 200 } }
    arrange([parent, child])
    expect(terminalDirectoryProgress(parent, [parent, child])).toEqual(child)
    await expect(resolveDirectoryContinuation({ mode: 'full', continueDirectoryOperationId: parent.operationId }, session, 'zh-CN'))
      .resolves.toMatchObject({ startChapter: 181, count: 20, continueDirectoryOperationId: child.operationId })
    arrange([parent, { ...child, remainingRange: null }])
    await expect(resolveDirectoryContinuation({ mode: 'full', continueDirectoryOperationId: parent.operationId }, session, 'zh-CN')).rejects.toThrow('DIRECTORY_PROGRESS_COMPLETE')
  })
  it('英文界面下旧进度缺少冻结作者输入：说明是英文（#471）', async () => {
    arrange([{ ...base, authorInputs: [] }])
    await expect(resolveDirectoryContinuation({ mode: 'full', continueDirectoryOperationId: base.operationId }, session, 'en-US'))
      .rejects.toThrow(/^This older blueprint progress has no frozen author input/u)
  })
})
