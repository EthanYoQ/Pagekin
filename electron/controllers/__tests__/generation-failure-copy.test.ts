import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { MainGenerationRunHandle } from '../../../src/services/generation/generation-runtime'
import type { GenerationAttemptReceipt } from '../../../src/services/generation/generation-harness'
import { ipc } from '../../../src/services/ipc-client'
import { classifyGenerationFailure } from '../../../src/services/generation/prompt-budget-failure'
import { presentWorkflowFailure } from '../../../src/components/panels/ai-output-failure-presentation'
import { displayedErrorMessage } from '../../../src/i18n/app-errors'
import { shown } from '../../../src/i18n/__tests__/shown-locale'
import { isWorkflowCancellation } from '../../../src/services/workflows/workflow-cancellation'
import { createStructuredBatchExecutor, type StructuredBatchContract } from '../../../src/services/workflows/structured-batch-executor'
import { projectAccess } from '../../services/project-access'
import { createProjectDatabase, initProjectDatabase, closeProjectDatabase, getProjectDb } from '../../database'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
type OwnerOverrides = Partial<Record<'resume' | 'cancel', (...args: unknown[]) => unknown>>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '', overrides: {} as OwnerOverrides }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => null, getRerankConfig: () => ({ kind: 'none', reason: 'not-configured' }) }))
vi.mock('../../services/main-generation-owner', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/main-generation-owner')>()
  return { ...actual, createMainGenerationOwner: (...args: Parameters<typeof actual.createMainGenerationOwner>) =>
    new Proxy(actual.createMainGenerationOwner(...args), { get: (owner, key, receiver) =>
      mocks.overrides[key as keyof OwnerOverrides] ?? Reflect.get(owner, key, receiver) }) }
})

import { registerGenerationController } from '../generation-controller'

const model: ModelProfile = { id: 'fixture', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-only', maxTokens: 16_384, temperature: 0.7, purposes: ['generation'] }
const sender = { isDestroyed: () => false, send: vi.fn() }
let root = '', session: ProjectSessionContext
const selection: BeginGenerationRequest = { operation: 'draft', uiActionNonce: '作者点击', modelId: 'fixture', chapterNumber: 1,
  selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['first_chapter_draft'], skillStages: [], output: 'visible-text',
  outputOverrides: [{ purpose: 'chapter:structured', output: 'structured-data' }] }

/** 渲染端经 Electron 收到的样子：只有 message 过 IPC，前面加上调用通道。 */
function invokeOverElectron(channel: string, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve(mocks.handlers.get(channel)!({ sender }, ...args)).catch((error: unknown) => {
    throw new Error(`Error invoking remote method '${channel}': ${String(error)}`)
  })
}
function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  return promise.then(() => { throw new Error('EXPECTED_REJECTION') }, (reason: unknown) => reason as Error)
}

beforeAll(() => {
  registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, rememberContextWindow: () => {} })
})
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'an-gen-copy-'))
  mocks.globalRoot = path.join(root, 'global'); fs.mkdirSync(mocks.globalRoot)
  const project = projectAccess.createProject(root, '合成小说')
  createProjectDatabase(project.rootPath); initProjectDatabase(project.rootPath)
  getProjectDb()!.exec("INSERT INTO project_core(id,project_name,global_guidance) VALUES('main','合成小说','保留作者事实'); INSERT INTO blueprints(chapter_number,title) VALUES(1,'第一章')")
  const lease = projectAccess.beginSession(project)
  session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: lease.leaseId }
  vi.stubGlobal('window', { aiNovelAPI: { invoke: invokeOverElectron } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  mocks.overrides = {}
  closeProjectDatabase(); projectAccess.invalidateCurrentSession(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  if (root) fs.rmSync(root, { recursive: true, force: true }); root = ''
})

async function begin(): Promise<MainGenerationRunHandle> {
  const view = await ipc.invokeWithProjectSession(session, 'generation:begin', selection)
  return view.handle
}
const missingRun = (handle: MainGenerationRunHandle): MainGenerationRunHandle => ({ ...handle, rootActionId: 'missing-root', runId: 'missing-run' })
const overBudget = (handle: MainGenerationRunHandle) => ipc.invokeWithProjectSession(session, 'generation:execute', { handle, invocationNonce: '超限拆分',
  task: { purpose: 'chapter:structured', output: 'structured-data', messages: [{ role: 'user', content: '保留作者事实。' }],
    budgetDemand: { kind: 'structured-items', writingLanguage: 'zh-CN', requestedItems: 10 } } })

const chapterTitles: StructuredBatchContract<number, { chapterNumber: number; title: string }> = {
  buildTask: ({ items }) => ({ purpose: 'chapter-blueprints', output: 'structured-data', messages: [{ role: 'user', content: JSON.stringify({ items }) }] }),
  buildCompactSingleTask: ({ item }) => ({ purpose: 'chapter-blueprints:compact-single', output: 'structured-data', messages: [{ role: 'user', content: JSON.stringify({ items: [item] }) }] }),
  inputKey: chapterNumber => chapterNumber,
  outputKey: blueprint => blueprint.chapterNumber,
  decode: content => JSON.parse(content) as { chapterNumber: number; title: string }[],
  validateItem: blueprint => blueprint.title.trim() ? undefined : '标题不能为空',
}
const receipt = (attempt: number): GenerationAttemptReceipt => ({
  model: { id: 'fixture', configurationRevision: 'revision-1', endpointFingerprint: 'openai|custom|test|model' },
  capabilities: { contextWindowTokens: 32_768, maxOutputTokens: 1000, reasoning: null, structuredOutput: true, usage: true,
    source: { contextWindowTokens: 'verified-provider-preset', maxOutputTokens: 'user-operational-cap', featureFlags: 'verified-provider-preset' } },
  budget: { attempt, maxAttempts: 20, requestedOutputTokens: 1000, cumulativeRequestedOutputTokens: attempt * 1000,
    maxRequestedOutputTokens: 100_000, maxRequestedOutputTokensPerAttempt: 1000, deadlineAt: 10_000 },
  finishReason: 'stop',
})

function authorTexts(message: string): string[] {
  return (['zh-CN', 'en-US'] as const).flatMap(locale => [
    presentWorkflowFailure(undefined, message, shown(locale), false).reason,
    displayedErrorMessage(shown(locale), new Error(message)),
  ])
}

it('生成通道失败时作者看不到主进程原文', async () => {
  const handle = await begin()
  const failures = [
    await rejectionOf(ipc.invokeWithProjectSession(session, 'generation:read', missingRun(handle))),
    await rejectionOf(ipc.invokeWithProjectSession(session, 'generation:pause', missingRun(handle))),
    await rejectionOf(overBudget(handle)),
  ]
  for (const failure of failures) {
    for (const text of authorTexts(failure.message)) {
      expect(text, failure.message).not.toMatch(/Error invoking|[A-Z][A-Z0-9]*_[A-Z0-9_]+|generation:/u)
      expect(text.trim(), failure.message).not.toBe('')
    }
  }
})

it('生成的取消、重试与预算判定与 master 相同', async () => {
  const handle = await begin()

  const split = await rejectionOf(overBudget(handle))
  expect(classifyGenerationFailure(split.message, null)).toBe('capacity-preflight')
  const sent: number[][] = []
  const executor = createStructuredBatchExecutor({ contract: chapterTitles, writingLanguage: 'zh-CN', session: { async complete(task) {
    const { items } = JSON.parse(task.messages[0]!.content) as { items: number[] }
    sent.push(items)
    if (sent.length === 1) throw split
    return { status: 'completed', finishReason: 'stop', content: JSON.stringify(items.map(chapterNumber => ({ chapterNumber, title: '完整章节' }))),
      receipt: receipt(sent.length) }
  } } })
  const result = await executor.execute({ items: Array.from({ length: 10 }, (_, index) => index + 1), limits: { maxBatchItems: 10 } })
  expect(result.ok).toBe(true)
  expect(result.receipt.splitCount).toBe(1)
  expect(sent[1]!.length + sent[2]!.length).toBe(10)
  expect(sent[1]!.length).toBeLessThan(10)

  mocks.overrides.cancel = () => { throw new Error('GENERATION_ACTION_CANCELLED') }
  expect(isWorkflowCancellation(await rejectionOf(ipc.invokeWithProjectSession(session, 'generation:cancel', handle)))).toBe(true)

  mocks.overrides.resume = () => { throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID') }
  const resumed = await rejectionOf(ipc.invokeWithProjectSession(session, 'generation:resume', handle))
  expect(resumed.message).toContain('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
})
