import { describe, expect, it, vi } from 'vitest'
import type { CompletionPort } from '../../../generation/generation-harness'
import { WORKFLOW_GENERATION_BUDGETS } from '../base-command'
import { fakeRuntimeDependencies } from './workflow-generation-runtime.fixture'

describe('fake workflow generation runtime', () => {
  it('issues a distinct lease to every runtime, even for the same model', async () => {
    const complete = vi.fn<CompletionPort['complete']>().mockResolvedValue({ content: '{}', finishReason: 'stop' })
    const dependencies = fakeRuntimeDependencies(complete)

    for (let index = 0; index < 2; index += 1) {
      const runtime = await dependencies.createRuntime({ budget: WORKFLOW_GENERATION_BUDGETS.structured, modelId: 'same-model' })
      await runtime.execute(({ session }) => session.complete({
        purpose: 'fixture-lease-probe',
        output: 'structured-data',
        messages: [{ role: 'user', content: 'probe' }],
      }))
    }

    const leaseIds = complete.mock.calls.map(([request]) => request.modelExecutionLeaseId)
    expect(leaseIds).toHaveLength(2)
    expect(new Set(leaseIds).size).toBe(2)
  })
})
