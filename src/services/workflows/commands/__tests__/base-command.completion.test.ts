import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ModelExecutionLeaseReceipt } from '../../../../shared/ipc-channels'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import type { CompletionPort } from '../../../generation/generation-harness'
import {
  BaseWorkflowCommand,
  WORKFLOW_GENERATION_BUDGETS,
  type CommandExecuteParams,
  type WorkflowGenerationIntent,
  type WorkflowGenerationRuntimeDependencies,
} from '../base-command'
import { fakeLeaseModelId, fakeRuntimeDependencies } from './workflow-generation-runtime.fixture'
import { useLLMStore } from '../../../../stores/llm-store'

type ProbeStep =
  | { kind: 'single' }
  | { kind: 'bounded'; contaminateOptions?: boolean }
  | { kind: 'exhaust'; commit: () => void }

class CompletionProbeCommand extends BaseWorkflowCommand<string> {
  constructor(
    dependencies?: WorkflowGenerationRuntimeDependencies,
    private readonly intent: WorkflowGenerationIntent = 'structured',
  ) {
    super(dependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    const step = params.step as ProbeStep
    return this.executeWithGenerationRuntime(this.intent, params, async () => {
      if (step.kind === 'single') {
        return this.callLLM(
          '普通 JSON 工作流',
          'system',
          params.callbacks,
          { responseFormat: { type: 'json_object' } },
          params.context,
        )
      }
      if (step.kind === 'bounded') {
        const options = step.contaminateOptions
          ? ({
              responseFormat: { type: 'json_object' },
              temperature: 0.01,
              maxTokens: 999_999,
            } as unknown as { responseFormat: { type: string } })
          : { responseFormat: { type: 'json_object' } }
        return this.callLLMWithBoundedCompletion(
          '返回目录 JSON',
          'system',
          params.callbacks,
          { mode: 'replace-structured-output', maxContinuations: 2 },
          options,
          params.context,
        )
      }

      for (let index = 0; index <= WORKFLOW_GENERATION_BUDGETS.structured.maxAttempts; index += 1) {
        await this.callLLM(
          `structured request ${index}`,
          'system',
          params.callbacks,
          { responseFormat: { type: 'json_object' } },
          params.context,
        )
      }
      step.commit()
      return 'committed'
    })
  }
}

const context: WorkflowContext = {
  runId: 'completion-probe',
  projectPath: 'C:\\novels\\probe',
  projectSession: { projectId: 'probe', leaseId: 'lease-probe', projectPath: 'C:\\novels\\probe' },
  writingLanguage: 'zh-CN',
  uiLocale: 'zh-CN',
  data: {},
  cancelled: false,
}

const callbacks: StepCallbacks = {
  log: vi.fn(),
  setProgress: vi.fn(),
  appendText: vi.fn(),
}

const capabilityEvidence: ModelExecutionLeaseReceipt['capabilityEvidence'] = {
  source: {
    contextWindowTokens: 'unknown',
    maxOutputTokens: 'user-operational-cap',
    featureFlags: 'unknown',
  },
  subjectFingerprint: 'c'.repeat(64),
  contextWindowTokens: null,
  maxOutputTokens: 2048,
  reasoning: null,
  structuredOutput: true,
  usage: null,
}

describe('BaseWorkflowCommand completion boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('refuses a production run without a main-process selection before any IPC', async () => {
    const invoke = vi.fn(async () => { throw new Error('IPC must not be reached') })
    vi.stubGlobal('window', { aiNovelAPI: { invoke, on: () => () => {} } })

    await expect(new CompletionProbeCommand().execute({
      step: { kind: 'single' },
      context: { ...context, generationModelId: 'model-a' },
      callbacks,
    })).rejects.toThrow('WORKFLOW_MAIN_GENERATION_REQUEST_REQUIRED')
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([
    { leasedCap: 16_384, expectedRequest: 8192 },
    { leasedCap: 8192, expectedRequest: 8192 },
  ])('keeps ordinary structured requests at $expectedRequest for a $leasedCap-capability lease', async ({ leasedCap, expectedRequest }) => {
    const complete = vi.fn<CompletionPort['complete']>()
      .mockResolvedValue({ content: '{"ok":true}', finishReason: 'stop' })
    const dependencies = fakeRuntimeDependencies(complete, { ...capabilityEvidence, maxOutputTokens: leasedCap })

    await expect(new CompletionProbeCommand(dependencies).execute({
      step: { kind: 'single' } satisfies ProbeStep,
      context,
      callbacks,
    })).resolves.toBe('{"ok":true}')

    expect(complete.mock.calls[0]?.[0].plan.maxOutputTokens).toBe(expectedRequest)
    expect(WORKFLOW_GENERATION_BUDGETS.structured.maxRequestedOutputTokens).toBe(131_072)
  })

  it.each([
    { leasedCap: 16_384, expectedRequest: 8192 },
    { leasedCap: 8192, expectedRequest: 8192 },
  ])('uses the bounded character-architecture policy without exceeding a $leasedCap-capability lease', async ({ leasedCap, expectedRequest }) => {
    const complete = vi.fn<CompletionPort['complete']>()
      .mockResolvedValue({ content: '{"ok":true}', finishReason: 'stop' })
    const dependencies = fakeRuntimeDependencies(complete, { ...capabilityEvidence, maxOutputTokens: leasedCap })

    await new CompletionProbeCommand(dependencies, 'character-architecture').execute({
      step: { kind: 'single' } satisfies ProbeStep,
      context,
      callbacks,
    })

    expect(complete.mock.calls[0]?.[0].plan.maxOutputTokens).toBe(expectedRequest)
    expect(WORKFLOW_GENERATION_BUDGETS['character-architecture']).toEqual({
      maxAttempts: 12,
      maxRequestedOutputTokens: 98_304,
      maxRequestedOutputTokensPerAttempt: 8192,
      deadlineMs: 20 * 60_000,
    })
    expect(12 * WORKFLOW_GENERATION_BUDGETS['character-architecture'].maxRequestedOutputTokensPerAttempt).toBe(98_304)
  })

  it('keeps ordinary generation single-shot and fail-closed while an unknown model uses its leased cap', async () => {
    const complete = vi.fn<CompletionPort['complete']>()
      .mockResolvedValue({ content: '半截结果', finishReason: 'length' })
    const dependencies = fakeRuntimeDependencies(complete, capabilityEvidence)

    await expect(new CompletionProbeCommand(dependencies).execute({
      step: { kind: 'single' } satisfies ProbeStep,
      context,
      callbacks,
    })).rejects.toThrow('AI 输出达到本次请求长度限制，尚未完整生成')

    expect(complete).toHaveBeenCalledOnce()
    expect(complete.mock.calls[0]?.[0].plan.maxOutputTokens).toBe(2048)
  })

  it('keeps a protocol-error candidate visible while rejecting it as a completed workflow result', async () => {
    const complete = vi.fn<CompletionPort['complete']>()
      .mockResolvedValue({ content: '可恢复候选正文', finishReason: 'error' })
    const dependencies = fakeRuntimeDependencies(complete, capabilityEvidence)
    const appendText = vi.fn()

    await expect(new CompletionProbeCommand(dependencies).execute({
      step: { kind: 'single' } satisfies ProbeStep,
      context,
      callbacks: { ...callbacks, appendText },
    })).rejects.toThrow()

    expect(appendText).toHaveBeenCalledWith('可恢复候选正文')
    expect(complete).toHaveBeenCalledOnce()
  })

  it('uses the frozen UI locale for an ordinary terminal failure', async () => {
    const complete = vi.fn<CompletionPort['complete']>()
      .mockResolvedValue({ content: '半截结果', finishReason: 'length' })
    const dependencies = fakeRuntimeDependencies(complete, capabilityEvidence)

    await expect(new CompletionProbeCommand(dependencies).execute({
      step: { kind: 'single' } satisfies ProbeStep,
      context: { ...context, uiLocale: 'en-US', writingLanguage: 'zh-CN' },
      callbacks,
    })).rejects.toThrow('AI output reached this request length limit and is not yet complete')
  })

  it('shares one frozen lease and budget across a structured continuation after the default changes', async () => {
    useLLMStore.setState({ defaultModelId: 'model-a' })
    const complete = vi.fn<CompletionPort['complete']>()
      .mockImplementation(async () => {
        const call = complete.mock.calls.length
        useLLMStore.setState({ defaultModelId: 'model-b' })
        return call === 1
          ? { content: '{"blueprints":[', finishReason: 'length' }
          : { content: '{"blueprints":[]}', finishReason: 'stop' }
      })
    const dependencies = fakeRuntimeDependencies(complete, capabilityEvidence)

    await expect(new CompletionProbeCommand(dependencies).execute({
      step: { kind: 'bounded' } satisfies ProbeStep,
      context,
      callbacks,
    })).resolves.toBe('{"blueprints":[]}')

    expect(complete).toHaveBeenCalledTimes(2)
    const leaseIds = complete.mock.calls.map(([request]) => request.modelExecutionLeaseId)
    expect(fakeLeaseModelId(leaseIds[0])).toBe('model-a')
    expect(leaseIds).toEqual([leaseIds[0], leaseIds[0]])
    useLLMStore.setState({ defaultModelId: null })
  })

  it('ignores forged physical request controls at the semantic command boundary', async () => {
    const complete = vi.fn<CompletionPort['complete']>()
      .mockResolvedValueOnce({ content: '{"blueprints":[', finishReason: 'length' })
      .mockResolvedValueOnce({ content: '{"blueprints":[]}', finishReason: 'stop' })
    const dependencies = fakeRuntimeDependencies(complete, capabilityEvidence)

    await new CompletionProbeCommand(dependencies).execute({
      step: { kind: 'bounded', contaminateOptions: true } satisfies ProbeStep,
      context,
      callbacks,
    })

    for (const [request] of complete.mock.calls) {
      expect(request.plan.maxOutputTokens).toBe(2048)
      expect(request).not.toHaveProperty('temperature')
      expect(request).not.toHaveProperty('maxTokens')
    }
  })

  it('exhausts the shared command budget before the domain commit callback', async () => {
    const commit = vi.fn()
    const complete = vi.fn<CompletionPort['complete']>()
      .mockResolvedValue({ content: '{"ok":true}', finishReason: 'stop' })
    const dependencies = fakeRuntimeDependencies(complete, capabilityEvidence)

    await expect(new CompletionProbeCommand(dependencies).execute({
      step: { kind: 'exhaust', commit } satisfies ProbeStep,
      context,
      callbacks,
    })).rejects.toMatchObject({ code: 'ATTEMPT_BUDGET_EXHAUSTED' })

    expect(complete).toHaveBeenCalledTimes(WORKFLOW_GENERATION_BUDGETS.structured.maxAttempts)
    expect(commit).not.toHaveBeenCalled()
  })
})
