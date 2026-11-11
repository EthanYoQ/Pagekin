import { create } from 'zustand'
import { useLLMStore } from '../../../../stores/llm-store'
import type { LLMFinishReason, ModelExecutionLeaseReceipt, TokenUsage } from '../../../../shared/ipc-channels'
import type { CreativeStrategy, GenerationReasoningStage } from '../../../../shared/reasoning-types'
import type { GenerationRuntime } from '../../../generation/generation-runtime'
import { createGenerationHarness, type CompletionPort, type GenerationMessage } from '../../../generation/generation-harness'
import type { WorkflowGenerationRuntimeDependencies } from '../base-command'

export type FakeGenerateStream = (
  messages: GenerationMessage[],
  callbacks: {
    onChunk?: (chunk: string) => void
    onDone?: (fullText: string, usage: TokenUsage | undefined, finishReason: LLMFinishReason) => void
    onError?: (error: string) => void
  },
  modelId?: string,
  options?: {
    modelExecutionLeaseId?: string
    purpose?: string
    creativeStrategy?: CreativeStrategy
    reasoningStage?: GenerationReasoningStage
    maxTokens?: number
    responseFormat?: { type: string }
  },
) => Promise<string>

export const useFakeModelStream = create<{ generateStream: FakeGenerateStream }>()(() => ({
  generateStream: async (_messages, callbacks) => {
    callbacks.onError?.('FAKE_MODEL_STREAM_NOT_SCRIPTED')
    return ''
  },
}))

const DEFAULT_CAPABILITY_EVIDENCE: ModelExecutionLeaseReceipt['capabilityEvidence'] = {
  source: {
    contextWindowTokens: 'unknown',
    maxOutputTokens: 'user-operational-cap',
    featureFlags: 'unknown',
  },
  subjectFingerprint: 'c'.repeat(64),
  contextWindowTokens: null,
  maxOutputTokens: 8192,
  reasoning: null,
  structuredOutput: true,
  usage: null,
}

export function fakeModelExecutionLeaseId(modelId: string): string {
  return `test-workflow-lease-${modelId}`
}

export function fakeRuntimeDependencies(
  complete: CompletionPort['complete'],
  capabilityEvidence: ModelExecutionLeaseReceipt['capabilityEvidence'] = DEFAULT_CAPABILITY_EVIDENCE,
): WorkflowGenerationRuntimeDependencies {
  return {
    async createRuntime(options): Promise<GenerationRuntime> {
      const frozenModelId = useLLMStore.getState().defaultModelId ?? 'test-model'
      const harness = createGenerationHarness({
        modelSource: {
          snapshotDefaultModel: () => ({
            revision: 'a'.repeat(64),
            model: {
              id: frozenModelId,
              provider: 'custom',
              protocol: 'openai',
              modelName: frozenModelId,
              baseUrl: '',
              maxTokens: capabilityEvidence.maxOutputTokens,
            },
            modelExecutionLeaseId: fakeModelExecutionLeaseId(frozenModelId),
            endpointFingerprint: 'b'.repeat(64),
            resolvedCapabilities: { ...capabilityEvidence, source: { ...capabilityEvidence.source } },
          }),
        },
        completionPort: { complete },
        policy: options.budget,
        creativeStrategy: options.creativeStrategy ?? 'auto',
      })
      const session = harness.openSession()
      return {
        execute: operation => operation({ session }),
        close: async () => {},
      }
    },
  }
}

export function createWorkflowRuntimeDependencies(
  capabilityEvidence: ModelExecutionLeaseReceipt['capabilityEvidence'] = DEFAULT_CAPABILITY_EVIDENCE,
): WorkflowGenerationRuntimeDependencies {
  return {
    createRuntime(options) {
      const frozenModelId = useLLMStore.getState().defaultModelId ?? 'test-model'
      return fakeRuntimeDependencies(request => new Promise((resolve, reject) => {
        useFakeModelStream.getState().generateStream(
          [...request.messages],
          {
            onDone: (content, usage, finishReason) => resolve({ content, usage, finishReason }),
            onError: error => reject(new Error(error)),
          },
          frozenModelId,
          {
            modelExecutionLeaseId: request.modelExecutionLeaseId ?? undefined,
            purpose: request.purpose,
            creativeStrategy: request.creativeStrategy,
            reasoningStage: request.reasoningStage,
            maxTokens: request.plan.maxOutputTokens,
            responseFormat: request.plan.responseFormat,
          },
        ).catch(reject)
      }), capabilityEvidence).createRuntime(options)
    },
  }
}

/** Default test adapter for ordinary workflow-command fixtures. */
export const workflowRuntimeDependencies = createWorkflowRuntimeDependencies()
