import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import type { TaskBudgetDecision } from '../../../src/services/generation/task-budget-planner'
import { ipc } from '../../../src/services/ipc-client'
import { classifyGenerationFailure } from '../../../src/services/generation/prompt-budget-failure'
import { presentWorkflowFailure } from '../../../src/components/panels/ai-output-failure-presentation'
import { plotTreeErrorMessage } from '../../../src/components/stage/plot/use-plot-threads'
import { displayedErrorMessage, errorCodeOf, importStopFailure } from '../../../src/i18n/app-errors'
import { describeFinalizationStepError, planFinalizationRetry } from '../../../src/shared/finalization-step-error'
import { PlotTreeInputLimitError, PlotTreeSourceError, PlotTreeSourceLimitError } from '../../../src/shared/plot-tree-generation-pure'
import { shown } from '../../../src/i18n/__tests__/shown-locale'
import { isWorkflowCancellation } from '../../../src/services/workflows/workflow-cancellation'
import { TaskBudgetPreflightError } from '../../services/main-generation-plan'
import { projectAccess } from '../../services/project-access'
import { createProjectDatabase, initProjectDatabase, closeProjectDatabase } from '../../database'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '', overrides: {} as Record<string, unknown> }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => null, getRerankConfig: () => ({ kind: 'none', reason: 'not-configured' }) }))
vi.mock('../../services/main-generation-owner', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/main-generation-owner')>()
  return { ...actual, createMainGenerationOwner: (...args: Parameters<typeof actual.createMainGenerationOwner>) =>
    new Proxy(actual.createMainGenerationOwner(...args), { get: (owner, key, receiver) =>
      mocks.overrides[key as string] ?? Reflect.get(owner, key, receiver) }) }
})

import { registerGenerationController } from '../generation-controller'

const model: ModelProfile = { id: 'fixture', name: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-only', maxTokens: 16_384, temperature: 0.7, purposes: ['generation'] }
const sender = { isDestroyed: () => false, send: vi.fn() }
let root = '', session: ProjectSessionContext

/** 渲染端经 Electron 收到的样子：只有 message 过 IPC，前面加上调用通道。 */
function invokeOverElectron(channel: string, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve(mocks.handlers.get(channel)!({ sender }, ...args)).catch((error: unknown) => {
    throw new Error(`Error invoking remote method '${channel}': ${String(error)}`)
  })
}

async function failureOf(channel: string, method: string, thrown: unknown): Promise<Error> {
  const fail = () => { throw thrown }
  mocks.overrides[method] = method === 'agents' ? new Proxy({}, { get: () => fail }) : fail
  return (ipc.invokeWithProjectSession as (...args: unknown[]) => Promise<unknown>)(session, channel, {})
    .then(() => { throw new Error('EXPECTED_REJECTION') }, (reason: unknown) => reason as Error)
}
const coded = (channel: string, code: string) => new Error(`Error invoking remote method '${channel}': Error: ${code}`)

beforeAll(() => {
  registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, rememberContextWindow: () => {} })
})
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'an-gen-rest-copy-'))
  mocks.globalRoot = path.join(root, 'global'); fs.mkdirSync(mocks.globalRoot)
  const project = projectAccess.createProject(root, '合成小说')
  createProjectDatabase(project.rootPath); initProjectDatabase(project.rootPath)
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

function authorTexts(message: string): string[] {
  return (['zh-CN', 'en-US'] as const).flatMap(locale => [
    presentWorkflowFailure(undefined, message, shown(locale), false).reason,
    displayedErrorMessage(shown(locale), new Error(message)),
  ])
}

it('生成控制器剩余通道失败时作者看不到主进程原文', async () => {
  const failures = [
    await failureOf('agent-generation:read', 'agents', new Error('GENERATION_AGENT_NONCE_CONFLICT')),
    await failureOf('graph-generation:begin', 'beginGraphGeneration', new Error('GENERATION_GRAPH_CONTEXT_INVALID')),
    await failureOf('finalization-generation:commit', 'commitFinalizationGeneration', new Error('GENERATION_FINALIZATION_EFFECT_CONFLICT')),
    await failureOf('import-generation:execute', 'executeImportGeneration', new Error('GENERATION_IMPORT_EFFECT_SOURCE_CHANGED')),
    await failureOf('editor-inline:execute', 'executeEditorInline', new Error('GENERATION_EDITOR_CONTEXT_INVALID')),
  ]
  for (const failure of failures) {
    for (const text of authorTexts(failure.message)) {
      expect(text, failure.message).not.toMatch(/Error invoking|[A-Z][A-Z0-9]*_[A-Z0-9_]+|-generation:|editor-inline:/u)
      expect(text.trim(), failure.message).not.toBe('')
    }
  }
})

it('生成的取消、重试与预算判定与 master 相同', async () => {
  const finalization = 'finalization-generation:commit'
  for (const code of ['GENERATION_FINALIZATION_PREDECESSOR_REQUIRED', 'GENERATION_FINALIZATION_IDENTITY_CHANGED', 'GENERATION_FINALIZATION_ARTIFACT_INVALID',
    'GENERATION_FINALIZATION_NOTES_CHANGED', 'GENERATION_DISPATCH_BLOCKED']) {
    const received = (await failureOf(finalization, 'commitFinalizationGeneration', new Error(code))).message
    const master = coded(finalization, code).message
    const steps = (error: string) => ({ kb_import: { ok: true }, chapter_notes: { ok: true }, character_cards: { ok: false, error } })
    expect(planFinalizationRetry(steps(received)), code).toEqual(planFinalizationRetry(steps(master)))
    expect(describeFinalizationStepError(received, (zh: string) => zh), code).toBe(describeFinalizationStepError(master, (zh: string) => zh))
  }

  const text = (zh: string) => zh
  const blueprint = await failureOf('graph-generation:begin', 'beginGraphGeneration', new Error('GENERATION_GRAPH_BLUEPRINT_REQUIRED'))
  expect(errorCodeOf(blueprint)).toBe('GENERATION_GRAPH_BLUEPRINT_REQUIRED')
  for (const thrown of [new PlotTreeSourceError(), new PlotTreeSourceLimitError(1), new PlotTreeInputLimitError(1)]) {
    const received = await failureOf('graph-generation:execute', 'executeGraphGeneration', thrown)
    expect(plotTreeErrorMessage(received, text, ['剧情树生成失败。', 'x'])).toBe(plotTreeErrorMessage(coded('graph-generation:execute', thrown.code), text, ['剧情树生成失败。', 'x']))
  }

  expect(isWorkflowCancellation(await failureOf('graph-generation:cancel', 'cancelGraphGeneration', new Error('GENERATION_ACTION_CANCELLED')))).toBe(true)
  expect(isWorkflowCancellation(await failureOf('editor-inline:cancel', 'cancelEditorInline', new Error('GENERATION_CANCELLED')))).toBe(true)

  const split = await failureOf('import-generation:execute', 'executeImportGeneration', new TaskBudgetPreflightError({ selectedQuantity: 3 } as TaskBudgetDecision))
  expect(split.message).toMatch(/TASK_BUDGET_SCOPE_SPLIT_REQUIRED:3$/u)
  expect(classifyGenerationFailure(split.message, null)).toBe('capacity-preflight')
  for (const code of ['ROOT_BUDGET_EXHAUSTED', 'GENERATION_DISPATCH_BLOCKED', 'GENERATION_STORAGE_FAILED', 'GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE']) {
    const stopped = await failureOf('import-generation:execute', 'executeImportGeneration', new Error(code))
    expect(importStopFailure(errorCodeOf(stopped) ?? '')).toEqual(importStopFailure(code))
  }
})
