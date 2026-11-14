import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkflowStore } from '../workflow-store'
import { useProjectStore } from '../project-store'
import { useLocaleStore } from '../locale-store'
import { createFinalizeWorkflow } from '../../services/workflows/chapter-workflow'

const finalizationClient = vi.hoisted(() => ({ commitFinalizationSnapshot: vi.fn() }))
vi.mock('../../services/finalization-client', () => finalizationClient)

const projectPath = 'C:\\finalize-notice'
const session = Object.freeze({ projectId: 'finalize-notice', leaseId: 'lease-finalize-notice', projectPath })
const content = '雨停了，钟声又响。'
const contentHash = createHash('sha256').update(content).digest('hex')
const source = { draftId: 41, finalizationId: 'finalization-4', chapterNumber: 4, contentHash }

let invoke: ReturnType<typeof vi.fn>

function stubIpc(failing: ReadonlySet<'kb_import' | 'chapter_notes'>) {
  const steps = new Map<string, { label: string; critical: boolean; ok: boolean }>()
  const created: Array<{ key: string; label: string; critical: boolean }> = []
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    switch (channel) {
      case 'skills:list-user': return []
      case 'fs:check-exists': return false
      case 'prompt:load-global': return { templates: [], diagnostics: [] }
      case 'window:notify-stage': return { shown: true }
      case 'db:draft-list': return []
      case 'db:blueprint-get': return { chapterNumber: 4, title: '钟声', characters: [] }
      case 'db:continuity-read-source':
        return { status: 'valid', snapshot: { source, chapterTitle: '钟声', content, projectionGeneration: 0 } }
      case 'db:post-process-get-latest-run': return null
      case 'db:post-process-create-run':
        created.push(...(args[0] as { steps: typeof created }).steps)
        return { success: true, id: 'post-process-4' }
      case 'db:post-process-get-steps':
        return created.filter(step => steps.has(step.key)).map((step, index) => ({
          id: index + 1, runId: 'post-process-4', stepKey: step.key, ...steps.get(step.key)!, attemptCount: 1, lastAttemptAt: '2026-11-14T00:00:00.000Z',
        }))
      case 'db:post-process-mark-step-ok':
      case 'db:post-process-mark-step-failed': {
        const key = String(args[1])
        const step = created.find(item => item.key === key)!
        steps.set(key, { label: step.label, critical: step.critical, ok: channel === 'db:post-process-mark-step-ok' })
        return { success: true }
      }
      case 'kb:import-text':
        return failing.has('kb_import') ? { success: false, error: 'KNOWLEDGE_BASE_VOLUME_UNSUPPORTED' } : { success: true, docId: 'knowledge-4', chunkCount: 1 }
      case 'db:finalization-link-knowledge-document': return { success: true }
      case 'finalization-generation:read': {
        const slot = (args[0] as { slot: { stepKey: string } }).slot
        if (slot.stepKey === 'chapter_notes' && failing.has('chapter_notes')) throw new Error('模型超时')
        return {
          view: { handle: { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: slot.stepKey }, artifacts: [], status: 'completed' },
          modelId: 'model', context: { slot }, sourceStatus: 'current',
          effect: slot.stepKey === 'chapter_notes'
            ? { success: true, stepKey: slot.stepKey, chapterNotes: content, factCount: 1, blueprintUpdated: true }
            : { success: true, stepKey: slot.stepKey, applied: 0, unchanged: 0, candidates: [], unresolved: [] },
        }
      }
      default: throw new Error(`测试未配置桌面调用：${channel}`)
    }
  })
  vi.stubGlobal('window', { aiNovelAPI: { invoke, on: vi.fn(() => () => {}), once: vi.fn() } })
}

beforeEach(() => {
  finalizationClient.commitFinalizationSnapshot.mockResolvedValue({
    success: true, committed: true, finalizationId: source.finalizationId, contentHash, contentRevision: 2, draftId: source.draftId, publicationStatus: 'published',
  })
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, currentRun: null, waitingForConfirm: false, waitingAfterStepIndex: -1 })
  useProjectStore.setState({
    currentProject: { id: session.projectId, name: 'Notice', path: projectPath, sessionLease: session.leaseId, novelConfig: {} } as never,
    refreshFileTree: vi.fn().mockResolvedValue(undefined),
  })
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
})

const finalize = () => createFinalizeWorkflow({
  projectPath, chapterNumber: 4, chapterTitle: '钟声', draftPath: 'ai-novel://draft/41', draftContent: content,
  snapshot: Object.freeze({ tabId: 'draft-41', projectPath, projectSession: session, draftId: 41, chapterNumber: 4, chapterTitle: '钟声', content, contentRevision: 2 }),
}, session)

const notices = () => invoke.mock.calls.filter(([channel]) => channel === 'window:notify-stage').map(([, notice]) => notice)

describe('定稿结束时的系统通知按后处理步骤结果写', () => {
  it('后处理全部完成时写「定稿完成」', async () => {
    stubIpc(new Set())
    await useWorkflowStore.getState().startWorkflow(finalize())
    expect(useWorkflowStore.getState().history[0].status).toBe('completed')
    expect(notices()).toEqual([{ title: '第 4 章定稿完成', body: '回到书童查看结果。' }])
  })

  it('导入知识库失败时写「已定稿，有一步没完成」', async () => {
    stubIpc(new Set(['kb_import']))
    await useWorkflowStore.getState().startWorkflow(finalize())
    expect(useWorkflowStore.getState().history[0].status).toBe('completed')
    expect(notices()).toEqual([{ title: '第 4 章已定稿，有一步没完成', body: '回到书童查看并重试。' }])
  })

  it('两步失败时写出步数，英文界面用英文', async () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    stubIpc(new Set(['kb_import', 'chapter_notes']))
    await useWorkflowStore.getState().startWorkflow(finalize())
    expect(notices()).toEqual([{ title: 'Chapter 4 finalized, but 2 steps didn\'t finish', body: 'Return to Pagekin to check and retry.' }])
  })
})
