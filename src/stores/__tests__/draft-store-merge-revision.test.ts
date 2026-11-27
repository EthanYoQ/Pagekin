import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  invokeWithProjectSession,
  syncTabContent,
  markTabSaved,
  settleMergedRevision,
  startWorkflow,
  editorTabs,
  workflowHistory,
  interfaceLocale,
} = vi.hoisted(() => ({
  interfaceLocale: { current: 'zh-CN' as 'zh-CN' | 'en-US' },
  invokeWithProjectSession: vi.fn(),
  syncTabContent: vi.fn(),
  markTabSaved: vi.fn(),
  settleMergedRevision: vi.fn(),
  startWorkflow: vi.fn(),
  workflowHistory: [] as Array<{ id: string; status: string }>,
  editorTabs: [] as Array<{
    id: string
    filePath: string
    projectKey: string
    content: string
    contentRevision: number
    dirty: boolean
  }>,
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: { invokeWithProjectSession },
}))

vi.mock('../project-store', () => ({
  useProjectStore: {
    getState: () => ({
      currentProject: {
        id: 'project-a',
        name: '隔离测试项目',
        path: 'C:\\novels\\project-a',
        sessionLease: 'lease-a',
      },
    }),
  },
}))

vi.mock('../editor-store', () => ({
  useEditorStore: {
    getState: () => ({
      tabs: editorTabs,
      syncTabContent,
      markTabSaved,
      settleMergedRevision,
    }),
  },
}))

vi.mock('../workflow-store', () => ({
  useWorkflowStore: { getState: () => ({ startWorkflow, history: workflowHistory }) },
  workflowResourceKey: (...parts: unknown[]) => parts.join(':'),
}))

vi.mock('../locale-store', () => ({
  useLocaleStore: { getState: () => ({ locale: interfaceLocale.current, text: (zh: string, en: string) => interfaceLocale.current === 'en-US' ? en : zh }) },
  currentInterfaceLocale: () => interfaceLocale.current,
}))

import { useDraftStore } from '../draft-store'
import { failureText } from '../../i18n/app-errors'
import { note } from '../../shared/failure'
import { shown } from '../../i18n/__tests__/shown-locale'

const projectPath = 'C:\\novels\\project-a'
const projectSession = {
  projectId: 'project-a',
  leaseId: 'lease-a',
  projectPath,
}

describe('draft-store merged revision persistence', () => {
  beforeEach(() => {
    workflowHistory.length = 0
    invokeWithProjectSession.mockReset()
    syncTabContent.mockReset()
    markTabSaved.mockReset()
    settleMergedRevision.mockReset()
    startWorkflow.mockReset()
    editorTabs.splice(0)
    startWorkflow.mockResolvedValue('recheck')

    invokeWithProjectSession.mockImplementation(async (_session: unknown, channel: string) => {
      if (channel === 'db:draft-list') {
        return [{
          id: 11,
          chapterNumber: 1,
          version: 1,
          status: 'draft',
          wordCount: 0,
          source: 'write',
          createdAt: '2026-08-22T00:00:00.000Z',
        }]
      }
      if (channel === 'db:revision-merge') {
        return {
          success: true,
          receipt: {
            revisionId: 1,
            targetDraftId: 11,
            status: 'revised',
            wordCount: 9,
            idempotent: false,
          },
        }
      }
      return { success: true }
    })

    useDraftStore.setState({
      draftsByChapter: {},
      loading: false,
      dataProjectKey: null,
      dataProjectSession: null,
      loadingProjectKey: null,
      loadingProjectSession: null,
    })
  })

  it('marks the direct vela revision URI as merged after its target draft is updated', async () => {
    const result = await useDraftStore.getState().applyMergedRevision(
      'ai-novel://draft/ch1',
      1,
      'ai-novel://draft/11',
      'ai-novel://revision/1',
      '已人工合并的修订稿',
      '原稿',
      projectPath,
      projectSession,
    )

    expect(result).toMatchObject({ success: true, receipt: { revisionId: 1, targetDraftId: 11 } })
    expect(invokeWithProjectSession).toHaveBeenCalledWith(
      projectSession,
      'db:revision-merge',
      {
        revisionId: 1,
        targetDraftId: 11,
        expectedDraftContent: '原稿',
        mergedContent: '已人工合并的修订稿',
        wordCount: 9,
      },
      projectPath,
    )
    expect(invokeWithProjectSession).not.toHaveBeenCalledWith(
      projectSession,
      'db:draft-update-content',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      projectPath,
    )
  })

  it('keeps the main-process code readable when the merge is rejected (#474)', async () => {
    invokeWithProjectSession.mockRejectedValueOnce(
      new Error("Error invoking remote method 'db:revision-merge': Error: REVISION_TARGET_CHANGED"),
    )
    const result = await useDraftStore.getState().applyMergedRevision(
      'ai-novel://draft/ch1', 1, 'ai-novel://draft/11', 'ai-novel://revision/1', '合并稿', '原稿', projectPath, projectSession,
    )

    expect(result.success).toBe(false)
    expect(failureText(shown('en-US'), result.failure)).toBe('The text or status of this draft changed. Reopen the revision comparison, then merge again.')
    expect(failureText(shown('zh-CN'), result.failure)).toBe('这一稿的正文或状态已经变化。请重新打开修订对比后再合并。')
  })

  it('英文界面合并修订失败时显示原因', async () => {
    interfaceLocale.current = 'en-US'
    try {
      invokeWithProjectSession.mockResolvedValueOnce({ success: false, failure: { code: 'REVISION_NOT_PENDING' } })
      const result = await useDraftStore.getState().applyMergedRevision(
        'ai-novel://draft/ch1', 1, 'ai-novel://draft/11', 'ai-novel://revision/1', '合并稿', '原稿', projectPath, projectSession,
      )

      expect(result.success).toBe(false)
      const shownText = (locale: 'en-US' | 'zh-CN') => failureText(shown(locale), { note: note('合并失败', 'Could not merge the revision.'), because: result.failure })
      expect(shownText('en-US')).not.toBe('Could not merge the revision.')
      expect(shownText('en-US')).toContain(failureText(shown('en-US'), { code: 'REVISION_NOT_PENDING' }))
      expect(shownText('zh-CN')).toContain(failureText(shown('zh-CN'), { code: 'REVISION_NOT_PENDING' }))
    } finally {
      interfaceLocale.current = 'zh-CN'
    }
  })

  it('freezes the editor snapshot before awaiting the merge receipt', async () => {
    let releaseMerge!: () => void
    const mergePending = new Promise<void>(resolve => { releaseMerge = resolve })
    editorTabs.push({
      id: 'draft-11',
      filePath: 'ai-novel://draft/11',
      projectKey: projectPath,
      content: '原稿',
      contentRevision: 3,
      dirty: false,
    })
    invokeWithProjectSession.mockImplementation(async (_session: unknown, channel: string) => {
      if (channel === 'db:revision-merge') {
        await mergePending
        return { success: true, receipt: { idempotent: false } }
      }
      if (channel === 'db:draft-list') return []
      return { success: true }
    })

    const merging = useDraftStore.getState().applyMergedRevision(
      'ai-novel://draft/ch1',
      1,
      'ai-novel://draft/11',
      'ai-novel://revision/1',
      '合并正文',
      '原稿',
      projectPath,
      projectSession,
    )
    editorTabs[0].content = '提交等待期间继续输入 C'
    editorTabs[0].contentRevision = 4
    editorTabs[0].dirty = true
    releaseMerge()

    await expect(merging).resolves.toMatchObject({ success: true, receipt: { idempotent: false } })
    expect(settleMergedRevision).toHaveBeenCalledWith(
      'draft-11',
      { content: '原稿', contentRevision: 3 },
      '合并正文',
    )
  })

  it('starts exactly one targeted recheck only when the merge receipt requires it', async () => {
    startWorkflow.mockImplementation(async definition => {
      definition.onStarted()
      return new Promise<string>(() => {})
    })
    editorTabs.push({ id: 'draft-11', filePath: 'ai-novel://draft/11', projectKey: projectPath,
      content: '原稿', contentRevision: 2, dirty: false })
    invokeWithProjectSession.mockImplementation(async (_session: unknown, channel: string) => {
      if (channel === 'db:revision-merge') return { success: true, receipt: { revisionId: 1, targetDraftId: 11,
        status: 'revised', wordCount: 4, idempotent: false, chapterNumber: 1, version: 1,
        reviewCycle: { cycleId: 'cycle-1', mergedHash: 'a'.repeat(64), disposition: 'required' } } }
      if (channel === 'db:draft-list') return []
      return { success: true }
    })
    const result = await useDraftStore.getState().applyMergedRevision('ai-novel://draft/ch1', 1,
      'ai-novel://draft/11', 'ai-novel://revision/1', '合并正文', '原稿', projectPath, projectSession)
    expect(result.failure).toBeUndefined()
    expect(result).toMatchObject({ success: true, receipt: { reviewCycle: { disposition: 'required' } } })
    expect(startWorkflow).toHaveBeenCalledTimes(1)
    expect(startWorkflow.mock.calls[0]?.[0]).toMatchObject({ projectPath, steps: [{ name: expect.any(String) }] })
    expect(startWorkflow.mock.calls[0]?.[1]).toBe(false)
  })

  it.each(['reject', 'failed-history'] as const)('reports a post-commit recheck launch %s without claiming the durable merge failed', async failure => {
    editorTabs.push({ id: 'draft-11', filePath: 'ai-novel://draft/11', projectKey: projectPath,
      content: '原稿', contentRevision: 2, dirty: false })
    invokeWithProjectSession.mockImplementation(async (_session: unknown, channel: string) => {
      if (channel === 'db:revision-merge') return { success: true, receipt: { revisionId: 1, targetDraftId: 11,
        status: 'revised', wordCount: 4, idempotent: false, chapterNumber: 1, version: 1,
        reviewCycle: { cycleId: 'cycle-1', mergedHash: 'a'.repeat(64), disposition: 'required' } } }
      if (channel === 'db:draft-list') return []
      return { success: true }
    })
    if (failure === 'reject') startWorkflow.mockRejectedValue(new Error('synthetic recheck launch failure'))
    else workflowHistory.push({ id: 'recheck', status: 'failed' })

    await expect(useDraftStore.getState().applyMergedRevision('ai-novel://draft/ch1', 1,
      'ai-novel://draft/11', 'ai-novel://revision/1', '合并正文', '原稿', projectPath, projectSession))
      .resolves.toMatchObject({ success: true, receipt: { reviewCycle: { disposition: 'required' } },
        postCommitError: expect.any(String) })
  })
})
