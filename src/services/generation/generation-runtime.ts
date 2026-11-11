import type { FrozenInputFingerprint } from '../../shared/source-ref'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { CreativeStrategy } from '../../shared/reasoning-types'
import type { RootBudget } from '../../shared/generation-contract'
import { hashAuthorText, isContentHash } from '../../shared/source-ref'
import {
  GenerationHarnessError,
  throwIfTerminalProviderFailure,
  type GenerationHarnessPolicy,
  type GenerationOutcome,
  type GenerationTask,
  type GenerationSessionBudget,
  type GenerationSession,
} from './generation-harness'

export type GenerationRuntimeBudget = GenerationHarnessPolicy

export interface GenerationRuntimeScope {
  session: GenerationSession
}

export interface GenerationRuntime {
  execute<T>(operation: (scope: GenerationRuntimeScope) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export interface CreateGenerationRuntimeOptions {
  budget: GenerationRuntimeBudget
  /** Optional semantic model identity. */
  modelId?: string
  /** Project identity captured by the caller before any asynchronous lease work. */
  projectSession?: ProjectSessionContext
  /** Project writing policy captured by the caller before asynchronous preparation. */
  creativeStrategy?: CreativeStrategy
  /** Alternate physical budget inputs are forbidden; one budget owns both consumers. */
  policy?: never
  structuredLimits?: never
}

/** Opt-in S05 handle. Only the main-process begin action may issue this identity. */
export interface MainGenerationRunHandle {
  projectId: string
  epoch: string
  rootActionId: string
  runId: string
}
export interface MainGenerationSnapshot extends MainGenerationRunHandle {
  diagnostics?: import('../../shared/generation-contract').GenerationTransportDiagnostics
  artifactId: string
  attemptId: string
  revision: number
  durableRevision: number
  text: string
  textHash: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  /** Main-verified settled stop/length artifact; status alone never authorizes composition. */
  compositionEligible?: boolean
}
/** Provider reasoning is sent only to the active display and has no durable run projection. */
export interface MainGenerationReasoningEvent extends MainGenerationRunHandle {
  attemptId: string
  text: string
}
export interface MainGenerationRunView {
  plotOutline?: import('../../shared/plot-outline-contract').PlotOutlineProgress
  budgetDiagnostics?: readonly import('./task-budget-planner').GenerationBudgetDiagnostic[]
  operation?: string
  candidates?: readonly (MainGenerationSnapshot & { fingerprint: FrozenInputFingerprint; nonReplayable: true })[]
  unsavedTails?: readonly { attemptId: string; artifactId: string; durableRevision: number; text: string; failureCode: string }[]
  ledger?: { policy: RootBudget; tokenLiability: number; physicalRequests: number; activeElapsedMs: number; blockedCode: string | null }
  handle: MainGenerationRunHandle
  /** Read-only compatibility projection from the persistent main ledger. */
  budget: Readonly<GenerationSessionBudget>
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  nonReplayable: boolean
  artifacts: readonly MainGenerationSnapshot[]
}
/** 运行列表里的一项：只够认出是哪个运行、什么状态、做什么的；要候选与账本再按 handle 读。 */
export type MainGenerationRunSummary = Pick<MainGenerationRunView, 'handle' | 'status' | 'operation'>
export interface MainGenerationExecuteReceipt {
  outcome: GenerationOutcome
  run: MainGenerationRunView
}
/** No provider, model lease creation, reservation or root creation methods exist here. */
export interface MainGenerationTransport {
  execute(request: { handle: MainGenerationRunHandle; invocationNonce: string; task: GenerationTask }): Promise<MainGenerationExecuteReceipt>
  read(handle: MainGenerationRunHandle): Promise<MainGenerationRunView>
  cancel(handle: MainGenerationRunHandle): Promise<MainGenerationRunView>
  subscribe(handle: MainGenerationRunHandle, listener: (snapshot: MainGenerationSnapshot) => void): () => void
  subscribeReasoning?: (handle: MainGenerationRunHandle, listener: (event: MainGenerationReasoningEvent) => void) => () => void
}
export interface MainOwnedGenerationRuntimeOptions {
  runHandle: MainGenerationRunHandle
  onSnapshot?: (snapshot: Readonly<MainGenerationSnapshot>) => void
  budget?: never
  modelId?: never
  policy?: never
  structuredLimits?: never
}
export interface MainOwnedGenerationRuntime extends GenerationRuntime {
  read(): Promise<MainGenerationRunView>
  cancel(): Promise<MainGenerationRunView>
}
/** Pure read seam for F04; it neither creates roots nor resumes execution. */
export function readMainGenerationRun(transport: MainGenerationTransport, handle: MainGenerationRunHandle): Promise<MainGenerationRunView> {
  return transport.read({ ...handle })
}
let defaultMainTransport: MainGenerationTransport | undefined
/** Installed once by the central typed IPC adapter; absent wiring fails closed. */
export function installMainGenerationTransport(transport: MainGenerationTransport): void {
  if (defaultMainTransport && defaultMainTransport !== transport) throw new Error('GENERATION_TRANSPORT_ALREADY_INSTALLED')
  defaultMainTransport = transport
}
function sameHandle(left: MainGenerationRunHandle, right: MainGenerationRunHandle): boolean {
  return ['projectId', 'epoch', 'rootActionId', 'runId'].every(key => {
    const field = key as keyof MainGenerationRunHandle
    return typeof left[field] === 'string' && Boolean(left[field].trim()) && left[field] === right[field]
  })
}
export async function createMainOwnedGenerationRuntime(options: MainOwnedGenerationRuntimeOptions, injected?: MainGenerationTransport): Promise<MainOwnedGenerationRuntime> {
  const transport = injected ?? defaultMainTransport
  if (!transport) throw new Error('MAIN_GENERATION_TRANSPORT_REQUIRED')
  if (['budget', 'modelId', 'policy', 'structuredLimits'].some(key => Object.hasOwn(options, key))) throw new Error('MAIN_OWNER_CONTROLS_BUDGET_AND_MODEL')
  const handle = Object.freeze({ ...options.runHandle })
  if (!sameHandle(handle, handle)) throw new Error('INVALID_MAIN_RUN_HANDLE')
  let closed = false
  let projectionError: unknown
  let queue = Promise.resolve()
  const snapshots = new Map<string, MainGenerationSnapshot>()
  const assertView = (view: MainGenerationRunView) => {
    if (!sameHandle(handle, view.handle)) throw new Error('MAIN_RUN_IDENTITY_MISMATCH')
    return view
  }
  const accept = (snapshot: MainGenerationSnapshot) => {
    const captured = { ...snapshot }
    queue = queue.then(async () => {
      if (closed) return
      if (!sameHandle(handle, captured) || !captured.artifactId?.trim() || !captured.attemptId?.trim()
        || !Number.isSafeInteger(captured.revision) || captured.revision < 0
        || !Number.isSafeInteger(captured.durableRevision) || captured.durableRevision < 0 || captured.durableRevision > captured.revision
        || !['running', 'completed', 'failed', 'cancelled', 'unknown'].includes(captured.status)
        || typeof captured.text !== 'string' || !isContentHash(captured.textHash) || await hashAuthorText(captured.text) !== captured.textHash) throw new Error('INVALID_MAIN_SNAPSHOT')
      if (closed) return
      const previous = snapshots.get(captured.artifactId)
      if (previous) {
        if (previous.attemptId !== captured.attemptId) throw new Error('MAIN_ARTIFACT_ATTEMPT_CHANGED')
        // Delivery order can differ from commit order. Older acknowledged views never replace newer ones.
        if (captured.revision < previous.revision) return
        // A terminal read can overtake its last running notification without changing the artifact.
        if (previous.status !== 'running' && captured.status === 'running'
          && captured.revision === previous.revision && captured.durableRevision === previous.durableRevision
          && captured.text === previous.text && captured.textHash === previous.textHash) return
        const cancelledSettledArtifact = (previous.status === 'failed' || previous.status === 'unknown') && captured.status === 'cancelled'
          && captured.revision === previous.revision && captured.durableRevision === previous.durableRevision
          && captured.text === previous.text && captured.textHash === previous.textHash
        if (previous.status !== 'running' && !cancelledSettledArtifact && (captured.status !== previous.status || captured.textHash !== previous.textHash || captured.revision !== previous.revision)
          || captured.durableRevision < previous.durableRevision || !captured.text.startsWith(previous.text)
          || captured.revision === previous.revision && captured.textHash !== previous.textHash) throw new Error('MAIN_SNAPSHOT_REGRESSION')
        if (!captured.diagnostics || previous.diagnostics && captured.diagnostics.elapsedMs < previous.diagnostics.elapsedMs) captured.diagnostics = previous.diagnostics
        if (captured.revision === previous.revision && captured.durableRevision === previous.durableRevision && captured.status === previous.status
          && JSON.stringify(captured.diagnostics) === JSON.stringify(previous.diagnostics)) return
      }
      snapshots.set(captured.artifactId, Object.freeze(captured))
      options.onSnapshot?.(captured)
    }).catch(error => { projectionError = error })
  }
  const unsubscribe = transport.subscribe(handle, accept)
  let initial: MainGenerationRunView
  try {
    initial = assertView(await transport.read(handle))
    for (const snapshot of initial.artifacts) accept(snapshot)
    await queue
    if (projectionError) throw projectionError
  } catch (error) { closed = true; unsubscribe(); throw error }
  const assertOpen = () => {
    if (closed) throw new GenerationRuntimeError('RUNTIME_CLOSED', '模型生成运行时已关闭。')
    if (projectionError) throw projectionError
  }
  const read = async () => {
    assertOpen()
    const view = assertView(await transport.read(handle))
    for (const snapshot of view.artifacts) accept(snapshot)
    await queue
    assertOpen()
    return view
  }
  const session: GenerationSession = {
    budget: Object.freeze({ ...initial.budget }),
    async complete(task, execution) {
      assertOpen()
      const invocationNonce = execution?.invocationNonce
      if (!invocationNonce?.trim()) throw new Error('MAIN_INVOCATION_NONCE_REQUIRED')
      if (execution?.signal?.aborted) throw new GenerationHarnessError('CANCELLED', '生成请求已取消。')
      const view = await read()
      if (view.nonReplayable) throw new Error('MAIN_RUN_NON_REPLAYABLE')
      if (execution?.signal) throw new Error('MAIN_CANCEL_REQUIRES_EXPLICIT_ACTION')
      // Old onChunk cannot safely append independent attempts. Use full snapshot receipts instead.
      if (execution?.onChunk) throw new Error('MAIN_SNAPSHOT_CALLBACK_REQUIRED')
      const receipt = await transport.execute({ handle, invocationNonce, task: structuredClone(task) })
      assertView(receipt.run)
      for (const snapshot of receipt.run.artifacts) accept(snapshot)
      await queue
      if (projectionError) throw projectionError
      if (receipt.outcome.status === 'completed' && receipt.outcome.finishReason !== 'stop'
        || receipt.outcome.receipt.finishReason !== receipt.outcome.finishReason) throw new Error('INVALID_MAIN_OUTCOME')
      throwIfTerminalProviderFailure(receipt.outcome.receipt)
      return receipt.outcome
    },
  }
  return {
    execute: async operation => { assertOpen(); return operation({ session }) },
    close: async () => { if (!closed) { closed = true; unsubscribe() } },
    read,
    cancel: async () => { assertOpen(); const view = assertView(await transport.cancel(handle)); for (const snapshot of view.artifacts) accept(snapshot); await queue; if (projectionError) throw projectionError; return view },
  }
}

export class GenerationRuntimeError extends Error {
  constructor(
    readonly code: 'RUNTIME_CLOSED',
    message: string,
  ) {
    super(message)
    this.name = 'GenerationRuntimeError'
  }
}
