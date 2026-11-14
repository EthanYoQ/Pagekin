import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkflowStore, type WorkflowDefinition } from '../workflow-store'
import { useProjectStore } from '../project-store'
import { useLocaleStore } from '../locale-store'
import { createReviewOnlyWorkflow, createChapterWorkflow, createRepairFinalizeWorkflow } from '../../services/workflows/chapter-workflow'
import { createBatchChapterWorkflow } from '../../services/workflows/batch-chapter-workflow'

const projectPath = 'C:\\test-project'
const session = { projectId: 'test-project', leaseId: 'lease-test-project', projectPath }
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'skills:list-user') return []
    if (channel === 'fs:check-exists') return false
    if (channel === 'window:notify-stage') return { shown: true }
    throw new Error(`测试未配置桌面调用：${channel}`)
  })
  vi.stubGlobal('window', { aiNovelAPI: { invoke, on: vi.fn(() => () => {}), once: vi.fn() } })
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, currentRun: null, waitingForConfirm: false, waitingAfterStepIndex: -1 })
  useProjectStore.setState({ currentProject: { id: 'test-project', name: 'Test', path: projectPath, sessionLease: 'lease-test-project', novelConfig: {} } as never })
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
})

function withStep(definition: WorkflowDefinition, executor: () => Promise<string>): WorkflowDefinition {
  return { ...definition, onComplete: undefined, steps: [{ ...definition.steps[0], executor }] }
}

const review = () => createReviewOnlyWorkflow({
  projectPath, chapterNumber: 3, chapterTitle: '雨夜', draftPath: 'ai-novel://draft/ch3/v1', draftContent: '正文',
  sourceDraft: { id: 1, chapterNumber: 3, version: 1, status: 'draft', contentRevision: 0 },
}, session)

const notices = () => invoke.mock.calls.filter(([channel]) => channel === 'window:notify-stage').map(([, notice]) => notice)

describe('阶段结束时请求系统通知', () => {
  it('审稿完成时发一条「第 N 章审稿完成」', async () => {
    await useWorkflowStore.getState().startWorkflow(withStep(review(), async () => 'ok'))
    expect(notices()).toEqual([{ title: '第 3 章审稿完成', body: '回到书童查看结果。' }])
  })

  it('审稿失败时发一条「第 N 章审稿没完成」', async () => {
    await useWorkflowStore.getState().startWorkflow(withStep(review(), async () => { throw new Error('模型超时') }))
    expect(notices()).toEqual([{ title: '第 3 章审稿没完成', body: '回到书童查看原因。' }])
  })

  it('英文界面用英文文案', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    const definition = createChapterWorkflow({ projectPath, chapterNumber: 2, title: 'Rain', role: '', purpose: '', characters: [], keyEvents: '' }, session, { uiLocale: 'en-US' })
    await useWorkflowStore.getState().startWorkflow(withStep(definition, async () => 'ok'))
    expect(notices()).toEqual([{ title: 'Chapter 2 draft finished', body: 'Return to Pagekin to see the result.' }])
  })

  it('作者取消的运行不发', async () => {
    const definition = withStep(review(), async () => {
      useWorkflowStore.getState().cancelWorkflow(useWorkflowStore.getState().activeRuns[0].id)
      return 'ok'
    })
    await useWorkflowStore.getState().startWorkflow(definition)
    expect(useWorkflowStore.getState().history[0].status).toBe('cancelled')
    expect(notices()).toEqual([])
  })

  it('修复后处理不发', async () => {
    await useWorkflowStore.getState().startWorkflow(withStep(createRepairFinalizeWorkflow(3, projectPath, session), async () => 'ok'))
    expect(useWorkflowStore.getState().history[0].status).toBe('completed')
    expect(notices()).toEqual([])
  })
})

const batch = (completionMode: 'auto_finalize' | 'draft_review', ...executors: Array<() => Promise<string>>): WorkflowDefinition => {
  const definition = createBatchChapterWorkflow({
    projectPath, projectSession: session, startChapterNumber: 5, chapterCount: executors.length, locale: 'zh-CN', generationModelId: 'model', completionMode,
  })
  return { ...definition, steps: definition.steps.map((step, index) => ({ ...step, executor: executors[index] })) }
}

describe('批量创作整批结束时发一次通知', () => {
  it('整批完成发一条「批量创作完成」，不按章发', async () => {
    await useWorkflowStore.getState().startWorkflow(batch('auto_finalize', async () => 'ok', async () => 'ok', async () => 'ok'))
    expect(notices()).toEqual([{ title: '第 5 至 7 章批量创作完成', body: '回到书童查看结果。' }])
  })

  it('草稿待审模式同样只发一条', async () => {
    await useWorkflowStore.getState().startWorkflow(batch('draft_review', async () => 'ok', async () => 'ok'))
    expect(notices()).toEqual([{ title: '第 5 至 6 章批量创作完成', body: '回到书童查看结果。' }])
  })

  it('中途停下时写停在哪一章、已完成几章', async () => {
    await useWorkflowStore.getState().startWorkflow(batch('auto_finalize', async () => 'ok', async () => { throw new Error('后处理失败') }, async () => 'ok'))
    expect(notices()).toEqual([{ title: '批量创作停在第 6 章', body: '已完成 1 章，回到书童查看原因。' }])
  })

  it('第一章就停下时不说已完成', async () => {
    await useWorkflowStore.getState().startWorkflow(batch('auto_finalize', async () => { throw new Error('模型超时') }, async () => 'ok'))
    expect(notices()).toEqual([{ title: '批量创作停在第 5 章', body: '回到书童查看原因。' }])
  })

  it('英文界面用英文文案', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    const definition = batch('auto_finalize', async () => 'ok', async () => { throw new Error('timeout') })
    await useWorkflowStore.getState().startWorkflow({ ...definition, uiLocale: 'en-US' })
    expect(notices()).toEqual([{ title: 'Batch writing stopped at chapter 6', body: '1 chapter is done. Return to Pagekin to see why.' }])
  })

  it('作者取消整批不发', async () => {
    await useWorkflowStore.getState().startWorkflow(batch('auto_finalize', async () => 'ok', async () => {
      useWorkflowStore.getState().cancelWorkflow(useWorkflowStore.getState().activeRuns[0].id)
      return 'ok'
    }, async () => 'ok'))
    expect(useWorkflowStore.getState().history[0].status).toBe('cancelled')
    expect(notices()).toEqual([])
  })
})
