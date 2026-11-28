import { describe, expect, it, vi } from 'vitest'

const ipcMocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../ipc-client', () => ({ ipc: { invokeWithProjectSession: ipcMocks.invoke, invoke: vi.fn() } }))

import { createImportWorkflow } from '../import-workflow'
import type { ImportRunSnapshot } from '../../../shared/import-run'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useWorkflowStore, type WorkflowRun } from '../../../stores/workflow-store'
import { runFailure } from '../../../components/run/run-failure'
import { shown } from '../../../i18n/__tests__/shown-locale'
import { failureText } from '../../../i18n/app-errors'
import { copyLocale, errorLocaleForRun } from '../../../i18n/core'
import type { InterfaceLocale, Locale } from '../../../i18n/types'

const session = { projectId: 'test-project', leaseId: 'lease-test-project', projectPath: 'C:\\test-project' }
const execution = { owner: 'test-import-executor', epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }

function snapshotFor(locale: Locale, stage: ImportRunSnapshot['stage']): ImportRunSnapshot {
  return {
    id: 'import-run-1', purpose: 'reference', rootRunId: 'import-run-1', effectNamespace: 'import:reference:import-run-1',
    coreWriteMode: 'replace',
    sourceDisplay: [{ displayName: 'reference.txt', mediaType: 'text/plain', size: 20 }],
    locale, stage, status: 'running', completedBatches: {},
    lastError: '', resumable: true, cancelRequested: false, totalChapters: 1,
    totalContentSize: 20, manifestChapterCount: 1, manifestContentSize: 20,
    manifestWordCount: 20, completedChapters: 0,
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
  }
}

/** master 上写通道失败时回的形状：句子、码，登记过的码另带 failure。 */
const masterFailure = (code: string, sentence: string) => ({ success: false, error: sentence, errorCode: code, failure: { code } })

async function runImport(snapshot: ImportRunSnapshot, interfaceLocale: InterfaceLocale, replies: Record<string, (...args: unknown[]) => unknown>) {
  ipcMocks.invoke.mockReset()
  ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
    if (replies[channel]) return replies[channel](...args)
    switch (channel) {
      case 'db:import-run-get': return snapshot
      case 'db:import-run-start-resume': return { success: true, start: { run: snapshot, execution } }
      case 'db:import-run-renew-execution': return { success: true, execution }
      case 'db:import-run-list-chapters': return args[1] === 0 ? [{ number: 1, title: '第1章', content: '参照正文', contentFingerprint: 'c'.repeat(64), contentSize: 12 }] : []
      case 'db:import-run-request-cancel': return { success: true, run: { ...snapshot, cancelRequested: true } }
      case 'db:import-run-cancel-at-boundary': return { success: true, run: { ...snapshot, status: 'cancelled' } }
      case 'db:import-run-fail': return { success: true, run: { ...snapshot, status: 'failed' } }
      default: return undefined
    }
  })
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {} })
  useProjectStore.setState({
    currentProject: {
      id: session.projectId, sessionLease: session.leaseId, name: '测试项目', path: session.projectPath,
      novelConfig: {} as never, characterStates: '', createdAt: '', updatedAt: '',
    },
  })
  useLocaleStore.setState({ locale: copyLocale(interfaceLocale), interfaceLocale })
  vi.stubGlobal('window', { aiNovelAPI: { invoke: vi.fn(async (channel: string) => channel === 'skills:list-user' ? [] : false), on: vi.fn(() => () => {}), once: vi.fn() } })
  try {
    await useWorkflowStore.getState().startWorkflow(createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner: execution.owner }))
  } finally {
    vi.unstubAllGlobals()
  }
  return { ended: useWorkflowStore.getState().history[0]!, channels: ipcMocks.invoke.mock.calls.map(call => call[1] as string) }
}

function shownOnRunCard(run: WorkflowRun, interfaceLocale: InterfaceLocale): string[] {
  const step = run.steps.find(candidate => candidate.status === 'failed')!
  const locale = errorLocaleForRun(run.uiLocale, shown(interfaceLocale))
  return [step.failure ? failureText(locale, step.failure) : '', runFailure(run, shown(interfaceLocale)).presentation.reason ?? '']
    .filter(line => line.trim())
}

describe('导入运行失败的说明与 master 逐字相同且随导入运行语言', () => {
  it.each([
    ['en-US', 'zh-CN', 'Another import is running in this book. Wait for it to finish, then continue this import.'],
    ['zh-CN', 'en-US', '这部作品里有另一个导入正在运行。请等它结束后再继续这次导入。'],
  ] as const)('%s 运行在 %s 界面下续跑被拒', async (runLocale, interfaceLocale, sentence) => {
    const { ended } = await runImport(snapshotFor(runLocale, 'knowledge'), interfaceLocale, {
      'db:import-run-start-resume': () => masterFailure('IMPORT_RUN_ANOTHER_RUNNING', sentence),
    })
    expect(ended.status).toBe('failed')
    const lines = shownOnRunCard(ended, interfaceLocale)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).toBe(sentence)
  })
})

describe('导入取消判定不变', () => {
  it('作者取消后检查点写入失败：记为失败，不记为取消', async () => {
    const snapshot = snapshotFor('zh-CN', 'knowledge')
    const { ended, channels } = await runImport(snapshot, 'zh-CN', {
      'kb:import-reference-text': () => {
        useWorkflowStore.getState().cancelWorkflow(snapshot.id)
        return { success: true, idempotent: false }
      },
      'db:import-run-complete-batch': () => masterFailure('IMPORT_RUN_EXECUTION_STALE', '这次导入已由别的窗口接手，或长时间没有响应已暂停，这个窗口不能再写入。请在导入对话框里继续。'),
    })
    expect(channels).toEqual(expect.arrayContaining(['db:import-run-request-cancel', 'db:import-run-complete-batch']))
    expect(ended.status).toBe('failed')
    expect(channels).not.toContain('db:import-run-cancel-at-boundary')
  })
})

describe('迁移后只回 failure 的写通道保留登记原因', () => {
  it.each([
    ['en-US', 'zh-CN', 'This import was taken over by another window, or it paused after going unresponsive, so this window can no longer write to it. Resume the import from the import dialog.'],
    ['zh-CN', 'en-US', '这次导入已由别的窗口接手，或长时间没有响应已暂停，这个窗口不能再写入。请在导入对话框里继续。'],
  ] as const)('%s 运行在 %s 界面下检查点保存失败', async (runLocale, interfaceLocale, sentence) => {
    const { ended } = await runImport(snapshotFor(runLocale, 'knowledge'), interfaceLocale, {
      'kb:import-reference-text': () => ({ success: true, idempotent: false }),
      'db:import-run-complete-batch': () => ({ success: false, failure: { code: 'IMPORT_RUN_EXECUTION_STALE' } }),
    })
    expect(ended.status).toBe('failed')
    for (const line of shownOnRunCard(ended, interfaceLocale)) expect(line).toBe(sentence)
  })
})
