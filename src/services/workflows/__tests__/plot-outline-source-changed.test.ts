import { afterEach, expect, it, vi } from 'vitest'

import type { MainGenerationRunView } from '../../generation/generation-runtime'
import { useLLMStore } from '../../../stores/llm-store'
import { useProjectStore } from '../../../stores/project-store'
import { GeneratePlotArchitectureCommand, PlotOutlineSourceChangedError } from '../commands/architecture.command'
import { PLOT_OUTLINE_CONTENT, PLOT_OUTLINE_PROTOCOL, renderPlotOutlineSynopsis, type PlotOutlineProgress } from '../../../shared/plot-outline-contract'
import type { NovelConfig } from '../../../shared/ipc-channels'
import { shown } from '../../../i18n/__tests__/shown-locale'
import { runFailure } from '../../../components/run/run-failure'
import { useWorkflowStore } from '../../../stores/workflow-store'

const originalDefaultModelId = useLLMStore.getState().defaultModelId
afterEach(() => {
  useProjectStore.setState({ currentProject: null })
  useLLMStore.setState({ defaultModelId: originalDefaultModelId })
  vi.unstubAllGlobals()
})

/** 与用户现场一致：第 6–10 章一批，第 6 章已接受，正要请求第 7 章时主进程拒绝。 */
function arrangeOutlineRejectedAtChapter7(rejection: string, lastChapterDone = false, { locale = 'zh-CN', stoppedAt = 7 }: { locale?: 'zh-CN' | 'en-US'; stoppedAt?: number } = {}) {
  const projectSession = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/失乐园' }
  const novelConfig = { totalChapters: 20, wordsPerChapter: 3000, genre: '悬疑' } as NovelConfig
  useProjectStore.setState({ currentProject: { id: projectSession.projectId, path: projectSession.projectPath,
    sessionLease: projectSession.leaseId, name: '失乐园', novelConfig, characterStates: '', createdAt: '', updatedAt: '' } })
  useLLMStore.setState({ models: [{ id: 'model', purposes: ['generation'] }] as never, defaultModelId: 'model' })
  const handle = { projectId: projectSession.projectId, epoch: projectSession.leaseId, rootActionId: '大纲根', runId: '大纲运行' }
  const sourceExpected = { synopsis: renderPlotOutlineSynopsis([1, 2, 3, 4, 5].map(chapter => `## 第${chapter}章：起\n……`).join('\n\n'), 5, { totalChapters: 20, writingLanguage: 'zh-CN' }), premise: '前提', charactersArch: '角色', worldbuilding: '世界',
    genre: '悬疑', totalChapters: 20, wordsPerChapter: 3000, writingLanguage: 'zh-CN' as const, plotStructure: 'three_act',
    narrativePov: 'third_limited', globalGuidance: '' }
  const chapters = lastChapterDone ? [6, 7, 8, 9, 10] : [6, 7, 8, 9].filter(chapter => chapter < stoppedAt)
  const plotOutline: PlotOutlineProgress = { protocol: PLOT_OUTLINE_PROTOCOL, content: PLOT_OUTLINE_CONTENT, range: { from: 6, to: 10 },
    targetUnits: 300, cursor: lastChapterDone ? { kind: 'complete' } : { kind: 'request', chapterNumber: stoppedAt, attempt: 'normal' }, sourceExpected,
    confirmedPrefix: sourceExpected.synopsis,
    composition: { artifactIds: chapters.map(chapter => `第${chapter}章`), text: chapters.map(chapter => `## 第${chapter}章：雨夜\n林岚确认证词。`).join('\n\n'),
      textHash: 'a'.repeat(64), revision: 1 } as unknown as PlotOutlineProgress['composition'] }
  const view = { handle, status: 'running', operation: 'generate-plot-outline', nonReplayable: false, artifacts: [], plotOutline,
    budget: { maxAttempts: 32, maxRequestedOutputTokens: 2097152, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: 9999999999999 } } as MainGenerationRunView
  const execute = vi.fn(async () => { throw new Error(`Error invoking remote method 'generation:execute': Error: ${rejection}`) })
  // 写库通道把已登记的码收成失败值（db-controller 的 MUTATING_DATABASE_CHANNELS），不会让 invoke 拒绝。
  const commit = vi.fn(async () => ({ success: false, failure: { code: rejection } }))
  const invoke = vi.fn(async (channel: string): Promise<unknown> => {
    if (channel === 'generation:begin' || channel === 'generation:read') return structuredClone(view)
    if (channel === 'generation:read-context') return { handle, modelId: 'model', operation: 'generate-plot-outline', plotOutline: structuredClone(plotOutline),
      authorInputs: [{ id: 'architecture:author-config', text: JSON.stringify(novelConfig) }] }
    if (channel === 'generation:execute') return execute()
    if (channel === 'db:project-core-synopsis-commit') return commit()
    if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
    if (channel === 'skills:list-user') return []
    if (channel === 'fs:check-exists') return false
    if (channel === 'fs:read-json') return { success: true, data: {} }
    if (channel === 'fs:write-file' || channel === 'fs:write-json') return { success: true }
    throw new Error(`unexpected IPC ${channel}`)
  })
  vi.stubGlobal('window', { aiNovelAPI: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn() } })
  const command = new GeneratePlotArchitectureCommand(['synopsis'], { expectedProjectPath: projectSession.projectPath, novelConfig }, undefined,
    { synopsisRange: { from: 6, to: 10 } })
  const context = { runId: 'architecture-run', projectPath: projectSession.projectPath, projectSession,
    writingLanguage: 'zh-CN' as const, uiLocale: locale, interfaceLocale: shown(locale), data: {}, cancelled: false }
  const callbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }
  return { run: () => command.execute({ step: {}, context, callbacks }), execute, commit }
}

async function failure(run: () => Promise<unknown>) {
  const error = await run().then(() => null, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(Error)
  return error as Error & { code?: string }
}

it('途中改了模型设置：说清楚停在第 7 章、第 6 章还在恢复稿、正式大纲没动，并给出去架构页重新生成的入口', async () => {
  const journey = arrangeOutlineRejectedAtChapter7('GENERATION_SOURCE_CHANGED_MODEL')
  const error = await failure(journey.run)
  expect(journey.execute).toHaveBeenCalledTimes(1)
  expect(error).toBeInstanceOf(PlotOutlineSourceChangedError)
  expect(error.code).toBe('GENERATION_SOURCE_CHANGED_MODEL')
  expect(error.message).not.toContain('GENERATION_SOURCE_CHANGED')
  expect(error.message).toContain('模型设置')
  expect(error.message).toContain('第 7 章')
  expect(error.message).toContain('第 6 章')
  // 运行侧页直接显示这段原因，口径与架构页的恢复稿提示一致：恢复稿不能覆盖正式内容。
  expect(error.message).toContain('不能覆盖正式内容')
  expect(error.message).toContain('正式大纲未被改动')
  expect(error.message).toContain('从第 6 章')
})

it('途中改了作品设定：同样可读，并说是作品设定或模板变了而不是模型', async () => {
  const journey = arrangeOutlineRejectedAtChapter7('GENERATION_SOURCE_CHANGED')
  const error = await failure(journey.run)
  expect(error).toBeInstanceOf(PlotOutlineSourceChangedError)
  expect(error.code).toBe('GENERATION_SOURCE_CHANGED')
  expect(error.message).not.toContain('GENERATION_SOURCE_CHANGED')
  expect(error.message).not.toContain('模型设置')
  expect(error.message).toContain('作品设定')
  expect(error.message).toContain('第 7 章')
})

it('与来源无关的失败照原样抛出，不被误报成来源变化', async () => {
  const journey = arrangeOutlineRejectedAtChapter7('GENERATION_PROVIDER_FAILED')
  const error = await failure(journey.run)
  expect(error).not.toBeInstanceOf(PlotOutlineSourceChangedError)
  expect(error.message).toContain('GENERATION_PROVIDER_FAILED')
})

it('前缀更长的其他错误码（定稿生成的来源变化）照原样抛出，不被误报成大纲来源变化', async () => {
  const journey = arrangeOutlineRejectedAtChapter7('FINALIZATION_GENERATION_SOURCE_CHANGED')
  const error = await failure(journey.run)
  expect(error).not.toBeInstanceOf(PlotOutlineSourceChangedError)
  expect(error.message).toContain('FINALIZATION_GENERATION_SOURCE_CHANGED')
})

it('最后一章生成完、正式保存时被来源检查拒绝：不出原始错误码，说清这批没写入正式大纲，从第 6 章重新生成', async () => {
  const journey = arrangeOutlineRejectedAtChapter7('GENERATION_SOURCE_CHANGED', true)
  const error = await failure(journey.run)
  expect(journey.execute).not.toHaveBeenCalled()
  expect(journey.commit).toHaveBeenCalledTimes(1)
  expect(error).toBeInstanceOf(PlotOutlineSourceChangedError)
  expect(error.code).toBe('GENERATION_SOURCE_CHANGED')
  expect(error.message).not.toContain('GENERATION_SOURCE_CHANGED')
  expect(error.message).toContain('第 6–10 章')
  expect(error.message).toContain('不能覆盖正式内容')
  expect(error.message).toContain('正式大纲未被改动')
  expect(error.message).toContain('从第 6 章')
})

async function failedRunFrom(thrown: unknown) {
  const runId = await useWorkflowStore.getState().startWorkflow({
    type: 'architecture_generation', title: '生成故事架构', projectPath: 'C:/projects/失乐园',
    projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/失乐园' },
    steps: [{ name: '情节大纲', description: '情节大纲', executor: async () => { throw thrown } }],
  })
  return useWorkflowStore.getState().history.find(run => run.id === runId)!
}

it.each([
  ['途中改了模型设置', 'GENERATION_SOURCE_CHANGED_MODEL', false],
  ['途中改了作品设定', 'GENERATION_SOURCE_CHANGED', false],
  ['保存前来源变了', 'GENERATION_SOURCE_CHANGED', true],
] as const)('情节大纲途中来源被改时出「去架构页重新生成」，并保留原因码（%s）', async (_name, upstream, lastChapterDone) => {
  const error = await failure(arrangeOutlineRejectedAtChapter7(upstream, lastChapterDone).run)
  const run = await failedRunFrom(error)
  const shownFailure = runFailure(run, shown('zh-CN'))
  expect([shownFailure.canRestartOutline, shownFailure.canResumeOutline]).toEqual([true, false])
  expect(shownFailure.presentation.reason).toBe(error.message)
  expect(shownFailure.presentation.reason).toContain('请到「架构」页重新生成情节大纲，从第 6 章开始。')
  expect(shownFailure.presentation.reason).not.toMatch(/[A-Z]+_[A-Z_]+|architecture-synopsis/u)
  expect([run.errorCode, run.steps[0].errorCode]).toEqual([upstream, upstream])
})

it.each([
  ['GENERATION_SOURCE_CHANGED_MODEL', false, 'zh-CN', 6, 
    '生成途中模型设置被修改，这批大纲已在第 6 章停止，没有再发送请求。正式大纲未被改动。请到「架构」页重新生成情节大纲，从第 6 章开始。'],
  ['GENERATION_SOURCE_CHANGED_MODEL', false, 'zh-CN', 7, 
    '生成途中模型设置被修改，这批大纲已在第 7 章停止，没有再发送请求。本批已生成的第 6 章保留在「大纲恢复稿」中，只能查看或复制，不能覆盖正式内容。正式大纲未被改动。请到「架构」页重新生成情节大纲，从第 6 章开始。'],
  ['GENERATION_SOURCE_CHANGED', false, 'zh-CN', 9, 
    '生成途中作品设定、提示词模板或写作 Skill 被修改，这批大纲已在第 9 章停止，没有再发送请求。本批已生成的第 6–8 章保留在「大纲恢复稿」中，只能查看或复制，不能覆盖正式内容。正式大纲未被改动。请到「架构」页重新生成情节大纲，从第 6 章开始。'],
  ['GENERATION_SOURCE_CHANGED', false, 'en-US', 6, 
    'The book settings, a prompt template or a writing skill changed during generation, so this outline batch stopped at chapter 6 without sending another request. The saved outline was not changed. Open Architecture and generate the plot outline again from chapter 6.'],
  ['GENERATION_SOURCE_CHANGED_MODEL', false, 'en-US', 7, 
    'The model settings were changed during generation, so this outline batch stopped at chapter 7 without sending another request. Chapter 6, already generated in this batch, is kept in the outline recovery draft, which can be viewed or copied but cannot replace saved content. The saved outline was not changed. Open Architecture and generate the plot outline again from chapter 6.'],
  ['GENERATION_SOURCE_CHANGED_MODEL', false, 'en-US', 9, 
    'The model settings were changed during generation, so this outline batch stopped at chapter 9 without sending another request. Chapters 6–8, already generated in this batch, are kept in the outline recovery draft, which can be viewed or copied but cannot replace saved content. The saved outline was not changed. Open Architecture and generate the plot outline again from chapter 6.'],
  ['GENERATION_SOURCE_CHANGED', true, 'zh-CN', 7, 
    '本批第 6–10 章大纲已生成完，但保存前模型设置、作品设定、提示词模板或写作 Skill 改过，正式保存被拒绝。这批大纲保留在「大纲恢复稿」中，只能查看或复制，不能覆盖正式内容。正式大纲未被改动。请到「架构」页重新生成情节大纲，从第 6 章开始。'],
  ['GENERATION_SOURCE_CHANGED', true, 'en-US', 7, 
    'The outline for chapters 6–10 finished, but the model settings, book settings, a prompt template, or a writing skill changed before saving, so saving was refused. The batch is kept in the outline recovery draft, which can be viewed or copied but cannot replace saved content. The saved outline was not changed. Open Architecture and generate the plot outline again from chapter 6.'],
] as const)('来源改动的说明与 master 逐字相同（%s，保存时 %s，%s，第 %s 章）', async (upstream, lastChapterDone, locale, stoppedAt, expected) => {
  const error = await failure(arrangeOutlineRejectedAtChapter7(upstream, lastChapterDone, { locale, stoppedAt }).run)
  expect(error.message).toBe(expected)
})
