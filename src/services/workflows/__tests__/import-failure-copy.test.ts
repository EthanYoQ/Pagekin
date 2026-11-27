import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipcMocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../ipc-client', () => ({ ipc: { invokeWithProjectSession: ipcMocks.invoke, invoke: vi.fn() } }))

import { createImportWorkflow } from '../import-workflow'
import { InferBlueprintsPerChapterCommand } from '../commands/import-novel.command'
import { GenerationHarnessError } from '../../generation/generation-harness'
import { isWorkflowCancellation } from '../workflow-cancellation'
import type { ImportRunSnapshot } from '../../../shared/import-run'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useWorkflowStore, type WorkflowContext, type WorkflowRun } from '../../../stores/workflow-store'
import { runFailure } from '../../../components/run/run-failure'
import { shown } from '../../../i18n/__tests__/shown-locale'
import { failureText } from '../../../i18n/app-errors'
import { copyLocale, errorLocaleForRun } from '../../../i18n/core'
import type { InterfaceLocale, Locale } from '../../../i18n/types'

const session = { projectId: 'test-project', leaseId: 'lease-test-project', projectPath: 'C:\\test-project' }
const originalLocale = useLocaleStore.getState()
const originalDefaultModelId = useLLMStore.getState().defaultModelId
const HAN = /\p{Script=Han}/u
const BARE_CODE = /\b[a-z]+_[a-z_]+\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/u

function snapshotFor(locale: Locale, stage: ImportRunSnapshot['stage']): ImportRunSnapshot {
  return {
    id: 'import-run-1', purpose: 'reference', rootRunId: 'import-run-1', effectNamespace: 'import:reference:import-run-1',
    sourceDisplay: [{ displayName: 'reference.txt', mediaType: 'text/plain', size: 20 }],
    locale, stage, status: 'running', completedBatches: {},
    lastError: '', resumable: true, cancelRequested: false, totalChapters: 1,
    totalContentSize: 20, manifestChapterCount: 1, manifestContentSize: 20,
    manifestWordCount: 20, completedChapters: 0,
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
  }
}

function useInterface(locale: InterfaceLocale) {
  useLocaleStore.setState({ locale: copyLocale(locale), interfaceLocale: locale })
}

/** 主进程在生成开始前就以码拒绝这一步；cancelFirst 时作者先点了取消。 */
async function importStopsAtGenerationBegin(rejection: string, options: { runLocale: Locale; interfaceLocale: InterfaceLocale; cancelFirst?: boolean }) {
  const snapshot = snapshotFor(options.runLocale, 'global')
  const execution = { owner: 'test-import-executor', epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
  const failed: string[] = []
  ipcMocks.invoke.mockImplementation(async (_session, channel: string, ...args: unknown[]) => {
    switch (channel) {
      case 'db:import-run-get': return snapshot
      case 'db:import-run-start-resume': return { success: true, start: { run: snapshot, execution } }
      case 'db:import-run-renew-execution': return { success: true, execution }
      case 'db:import-run-list-chapters': return args[1] === 0 ? [{ number: 1, title: '第1章', content: '参照正文', contentFingerprint: 'c'.repeat(64), contentSize: 12 }] : []
      case 'import-generation:read':
        if (options.cancelFirst) useWorkflowStore.getState().cancelWorkflow(snapshot.id)
        throw new Error(`Error invoking remote method 'import-generation:read': Error: ${rejection}`)
      case 'db:import-run-request-cancel': return { success: true, run: { ...snapshot, cancelRequested: true } }
      case 'db:import-run-cancel-at-boundary': return { success: true, run: { ...snapshot, status: 'cancelled' } }
      case 'db:import-run-fail':
        failed.push(String(args[2]))
        return { success: true, run: { ...snapshot, status: 'failed' } }
      default: return undefined
    }
  })
  useInterface(options.interfaceLocale)
  vi.stubGlobal('window', { aiNovelAPI: { invoke: vi.fn(async (channel: string) => channel === 'skills:list-user' ? [] : false), on: vi.fn(() => () => {}), once: vi.fn() } })
  try {
    await useWorkflowStore.getState().startWorkflow(createImportWorkflow({ projectPath: session.projectPath, projectSession: session, run: snapshot, executionOwner: 'test-import-executor' }))
  } finally {
    vi.unstubAllGlobals()
  }
  const ended = useWorkflowStore.getState().history[0]!
  return { ended, failed, channels: ipcMocks.invoke.mock.calls.map(call => call[1]) }
}

/** 运行卡片上作者看到的失败：步骤详情、失败提示，按运行语言与当前界面语言取显示语言。 */
function shownOnRunCard(run: WorkflowRun, interfaceLocale: InterfaceLocale): string[] {
  const step = run.steps.find(candidate => candidate.status === 'failed')!
  const locale = errorLocaleForRun(run.uiLocale, shown(interfaceLocale))
  return [step.error ?? '', step.failure ? failureText(locale, step.failure) : '', runFailure(run, shown(interfaceLocale)).presentation.reason ?? '']
    .filter(Boolean)
}

async function onRunCard(thrown: unknown, runLocale: Locale, interfaceLocale: InterfaceLocale): Promise<string[]> {
  useInterface(interfaceLocale)
  const runId = await useWorkflowStore.getState().startWorkflow({
    type: 'novel_import', title: '导入', projectPath: session.projectPath, projectSession: session, uiLocale: runLocale,
    steps: [{ name: '蓝图', description: '蓝图', executor: async () => { throw thrown } }],
  })
  return shownOnRunCard(useWorkflowStore.getState().history.find(run => run.id === runId)!, interfaceLocale)
}

function blueprintContext(runLocale: Locale, interfaceLocale: InterfaceLocale): WorkflowContext {
  return {
    runId: 'blueprint-run', projectPath: session.projectPath, projectSession: session,
    writingLanguage: runLocale, uiLocale: runLocale, interfaceLocale: errorLocaleForRun(runLocale, shown(interfaceLocale)),
    data: { novelConfigSummary: 'summary', chapters: [{ number: 1, title: 'One', content: 'The hero leaves home.', wordCount: 4 }] },
    cancelled: false,
  }
}

/** 结构化批次的会话在发请求时就抛出：蓝图推演按批次失败收尾。 */
async function blueprintFailure(rejection: () => unknown, context: WorkflowContext, cancelFirst = false): Promise<unknown> {
  const sessionStub = { complete: vi.fn(async () => { if (cancelFirst) context.cancelled = true; throw rejection() }) }
  const runtime = { execute: (operation: (scope: { session: typeof sessionStub }) => Promise<unknown>) => operation({ session: sessionStub }) }
  return new InferBlueprintsPerChapterCommand({ createRuntime: async () => runtime } as never)
    .execute({ step: {} as never, context, callbacks: { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() } })
    .catch((error: unknown) => error)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {} })
  useLLMStore.setState({ defaultModelId: 'model-a' })
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
  useLLMStore.setState({ defaultModelId: originalDefaultModelId })
  vi.restoreAllMocks()
})

describe('导入停下的原因随导入运行语言', () => {
  it.each([
    ['zh-CN', 'en-US', '这次导入的请求次数或运行时长已到上限，这一批没有发送。在导入对话框里点「继续导入」，已提交的批次不会重做。'],
    ['en-US', 'zh-CN', 'This import reached its limit on model requests or running time, so this batch was not sent. To finish, choose Continue import in the import dialog; batches already committed are not redone.'],
    ['en-US', 'ja-JP', 'この取り込みはモデルへのリクエスト数または実行時間の上限に達したため、このバッチは送信されませんでした。完了するには、取り込みダイアログで「Continue import」を選んでください。コミット済みのバッチはやり直されません。'],
  ] as const)('运行 %s、界面 %s：运行卡片、存下的失败原因都是这句', async (runLocale, interfaceLocale, expected) => {
    const { ended, failed } = await importStopsAtGenerationBegin('ROOT_BUDGET_EXHAUSTED', { runLocale, interfaceLocale })

    expect(ended.status).toBe('failed')
    for (const line of shownOnRunCard(ended, interfaceLocale)) expect(line).toBe(expected)
    expect(failed).toEqual([expected])
  })

  it.each([
    ['zh-CN', 'en-US', '这次导入的请求次数或运行时长已到上限，这一批没有发送。原稿正文已经导入并保存，只是 AI 反推的设定、文风或蓝图没有做完，可以在设定页和蓝图页手动补齐。'],
    ['en-US', 'zh-CN', 'This import reached its limit on model requests or running time, so this batch was not sent. The manuscript text is imported and saved; only the AI-inferred settings, writing style, or blueprints are unfinished. You can fill them in on the Setup and Blueprint pages.'],
  ] as const)('作者原稿反推的蓝图批次停下（运行 %s、界面 %s）', async (runLocale, interfaceLocale, expected) => {
    const context = blueprintContext(runLocale, interfaceLocale)
    context.data.importRunPurpose = 'author-manuscript'

    const thrown = await blueprintFailure(() => new Error('ROOT_BUDGET_EXHAUSTED'), context)

    const summary = runLocale === 'zh-CN' ? '蓝图推演失败：' : 'Blueprint inference failed'
    for (const line of await onRunCard(thrown, runLocale, interfaceLocale)) {
      expect(line.startsWith(summary)).toBe(true)
      expect(line.endsWith(expected)).toBe(true)
    }
  })
})

describe('导入取消判定不变', () => {
  it('作者取消后生成以取消码收尾：记为取消，不写失败', async () => {
    const { ended, channels } = await importStopsAtGenerationBegin('GENERATION_ACTION_CANCELLED', { runLocale: 'zh-CN', interfaceLocale: 'zh-CN', cancelFirst: true })

    expect(ended.status).toBe('cancelled')
    expect(channels).toContain('db:import-run-cancel-at-boundary')
    expect(channels).not.toContain('db:import-run-fail')
  })

  it('作者取消后遇到真实的预算用完：仍记为失败', async () => {
    const { ended, channels, failed } = await importStopsAtGenerationBegin('ROOT_BUDGET_EXHAUSTED', { runLocale: 'zh-CN', interfaceLocale: 'zh-CN', cancelFirst: true })

    expect(ended.status).toBe('failed')
    expect(channels).not.toContain('db:import-run-cancel-at-boundary')
    expect(failed).toEqual(['这次导入的请求次数或运行时长已到上限，这一批没有发送。在导入对话框里点「继续导入」，已提交的批次不会重做。'])
  })

  it.each([
    ['会话因取消中止', () => new GenerationHarnessError('CANCELLED', '生成请求已取消。'), true],
    ['预算用完', () => new Error('ROOT_BUDGET_EXHAUSTED'), false],
    ['请求次数用完', () => new GenerationHarnessError('ATTEMPT_BUDGET_EXHAUSTED', '生成会话已用尽请求次数。'), false],
  ] as const)('取消请求之后蓝图推演%s：是否算取消与 master 相同', async (_label, rejection, cancellation) => {
    expect(isWorkflowCancellation(await blueprintFailure(rejection, blueprintContext('zh-CN', 'zh-CN'), true))).toBe(cancellation)
  })
})

describe('导入失败的英文说明不含中文原因或裸码', () => {
  it.each(['en-US', 'ja-JP'] as const)('英文运行、界面 %s：蓝图推演用尽请求次数', async interfaceLocale => {
    const thrown = await blueprintFailure(() => new GenerationHarnessError('ATTEMPT_BUDGET_EXHAUSTED', '生成会话已用尽请求次数。'), blueprintContext('en-US', interfaceLocale))

    const lines = await onRunCard(thrown, 'en-US', interfaceLocale)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).toMatch(/^Blueprint inference failed/u)
      expect(line).not.toMatch(HAN)
      expect(line).not.toMatch(BARE_CODE)
    }
  })

  it('英文运行：生成开始前的预算用完', async () => {
    const thrown = await blueprintFailure(() => new Error('ROOT_BUDGET_EXHAUSTED'), blueprintContext('en-US', 'en-US'))

    for (const line of await onRunCard(thrown, 'en-US', 'en-US')) {
      expect(line).not.toMatch(HAN)
      expect(line).not.toMatch(BARE_CODE)
    }
  })
})
