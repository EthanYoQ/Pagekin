import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipcMocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../ipc-client', () => ({ ipc: { invokeWithProjectSession: ipcMocks.invoke } }))

import { createImportWorkflow } from '../import-workflow'
import type { ImportRunSnapshot } from '../../../shared/import-run'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useWorkflowStore, type WorkflowRun } from '../../../stores/workflow-store'
import { shown } from '../../../i18n/__tests__/shown-locale'
import { failureText, knownAppErrorMessage } from '../../../i18n/app-errors'
import { copyLocale, errorLocaleForRun } from '../../../i18n/core'
import type { InterfaceLocale, Locale } from '../../../i18n/types'
import { expectEndedWith } from '../../../stores/__tests__/run-failure-expect'

const session = { projectId: 'test-project', leaseId: 'lease-test-project', projectPath: 'C:\\test-project' }
const executionOwner = 'test-import-executor'
const originalLocale = useLocaleStore.getState()

function snapshotFor(locale: Locale): ImportRunSnapshot {
  return {
    id: 'import-run-1', purpose: 'reference', rootRunId: 'import-run-1', effectNamespace: 'import:reference:import-run-1',
    sourceDisplay: [{ displayName: 'reference.txt', mediaType: 'text/plain', size: 20 }],
    locale, stage: 'knowledge', status: 'running', completedBatches: {},
    lastError: '', resumable: true, cancelRequested: false, totalChapters: 2,
    totalContentSize: 20, manifestChapterCount: 2, manifestContentSize: 20,
    manifestWordCount: 20, completedChapters: 0,
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
  }
}

async function importTwoChapters(reply: object, options: { runLocale?: Locale; interfaceLocale?: InterfaceLocale; cancelFirst?: boolean } = {}) {
  const snapshot = snapshotFor(options.runLocale ?? 'zh-CN')
  const execution = { owner: executionOwner, epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
  ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
    switch (channel) {
      case 'db:import-run-get': return snapshot
      case 'db:import-run-start-resume': return { success: true, start: { run: snapshot, execution } }
      case 'db:import-run-renew-execution': return { success: true, execution }
      case 'db:import-run-list-chapters': return args[1] === 0 ? [1, 2].map(number => ({
        number, title: `第${number}章`, content: '参照正文', contentFingerprint: 'c'.repeat(64), contentSize: 12,
      })) : []
      case 'kb:import-reference-text':
        if (args[0] === 1) {
          if (options.cancelFirst) useWorkflowStore.getState().cancelWorkflow(snapshot.id)
          return { success: true, docId: 'stable-1', idempotent: false }
        }
        return reply
      case 'db:import-run-request-cancel': return { success: true, run: { ...snapshot, cancelRequested: true } }
      case 'db:import-run-cancel-at-boundary': return { success: true, run: { ...snapshot, status: 'cancelled' } }
      case 'db:import-run-fail': return { success: true, run: { ...snapshot, status: 'failed' } }
      case 'fs:check-exists': return false
      default: throw new Error(`测试未配置桌面调用：${channel}`)
    }
  })
  const shownLocale = options.interfaceLocale ?? 'zh-CN'
  useLocaleStore.setState({ locale: copyLocale(shownLocale), interfaceLocale: shownLocale })
  vi.stubGlobal('window', { aiNovelAPI: { invoke: vi.fn(async (channel: string) => channel === 'skills:list-user' ? [] : false), on: vi.fn(() => () => {}), once: vi.fn() } })
  try {
    await useWorkflowStore.getState().startWorkflow(createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner }))
  } finally {
    vi.unstubAllGlobals()
  }
  const ended = useWorkflowStore.getState().history[0]!
  return { ended, channels: ipcMocks.invoke.mock.calls.map(call => call[1]) }
}

function shownOnRunCard(run: WorkflowRun, interfaceLocale: InterfaceLocale): string {
  const step = run.steps[0]!
  return step.failure ? failureText(errorLocaleForRun(run.uiLocale, shown(interfaceLocale)), step.failure) : ''
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {} })
  useProjectStore.setState({
    currentProject: {
      id: 'test-project', sessionLease: 'lease-test-project', name: '测试项目', path: session.projectPath,
      novelConfig: {} as never, characterStates: '', createdAt: '', updatedAt: '',
    },
  })
})

afterEach(() => {
  useProjectStore.setState({ currentProject: null })
  useLocaleStore.setState(originalLocale, true)
  vi.restoreAllMocks()
})

describe('参照导入失败过 IPC 的形状（#844 PR-B）', () => {
  it('带已登记码的参照导入失败不显示旧 error 字段里的原文', async () => {
    const raw = 'SqliteError: database is locked'
    const { ended } = await importTwoChapters({ success: false, error: raw, errorCode: 'EMBEDDING_SPACE_BUSY', failure: { code: 'EMBEDDING_SPACE_BUSY' } })

    expect(shownOnRunCard(ended, 'zh-CN')).toBe(knownAppErrorMessage(shown('zh-CN'), 'EMBEDDING_SPACE_BUSY'))
  })

  it.each([
    ['zh-CN', 'zh-CN'],
    ['en-US', 'zh-CN'],
    ['zh-CN', 'en-US'],
  ] as const)('参照导入失败显示专用说明且随运行语言（运行 %s、界面 %s）', async (runLocale, interfaceLocale) => {
    const dedicated = knownAppErrorMessage(shown(runLocale), 'EMBEDDING_SPACE_REINDEX_REQUIRED')!
    const { ended } = await importTwoChapters(
      { success: false, error: dedicated, errorCode: 'EMBEDDING_SPACE_REINDEX_REQUIRED', failure: { code: 'EMBEDDING_SPACE_REINDEX_REQUIRED' } },
      { runLocale, interfaceLocale },
    )

    expect(shownOnRunCard(ended, interfaceLocale)).toBe(dedicated)
  })

  it('参照导入失败的 error.code 与 master 相同，取消判定不变', async () => {
    const cancelled = await importTwoChapters(
      { success: false, error: '导入已取消。', errorCode: 'IMPORT_RUN_CANCELLED', failure: { code: 'IMPORT_RUN_CANCELLED' } },
      { cancelFirst: true },
    )
    expect(cancelled.ended).toMatchObject({ status: 'cancelled' })
    expect(cancelled.channels).toContain('db:import-run-cancel-at-boundary')
    expect(cancelled.channels).not.toContain('db:import-run-fail')

    const failedAfterCancel = await importTwoChapters(
      { success: false, error: '检索索引正在建立，请稍后再试。', errorCode: 'EMBEDDING_SPACE_BUSY', failure: { code: 'EMBEDDING_SPACE_BUSY' } },
      { cancelFirst: true },
    )
    expectEndedWith(failedAfterCancel.ended, 'failed', 'EMBEDDING_SPACE_BUSY')
    expectEndedWith(failedAfterCancel.ended.steps[0], 'failed', 'EMBEDDING_SPACE_BUSY')
    expect(failedAfterCancel.channels).toContain('db:import-run-fail')

    const generic = await importTwoChapters({ success: false, error: 'IPC_HANDLER_FAILED' })
    expect(generic.ended.steps[0]).toMatchObject({ status: 'failed' })
    expect(shownOnRunCard(generic.ended, 'zh-CN')).toBe(knownAppErrorMessage(shown('zh-CN'), 'IPC_HANDLER_FAILED'))
  })
})
