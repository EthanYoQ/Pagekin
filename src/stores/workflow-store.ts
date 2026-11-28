import { caughtFailure, displayedErrorMessage, failureText, authorError, reasonOf } from '../i18n/app-errors'
import { authorOwned, note, type Failure } from '../shared/failure'
import type { GenerationTransportDiagnostics } from '../shared/generation-contract'
import type { CharacterProposalBatch } from '../shared/character-proposal'
import type { CharacterProposalChoices } from '../services/character-proposal-choices'
import { create } from 'zustand'
import { randomUUID } from '../utils/id'
import { globalEventBus } from '../shared/event-bus'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { WritingLanguage } from '../shared/writing-language'
import { resolveWritingLanguage } from '../shared/writing-language'
import type { ErrorDisplayLocale, Locale } from '../i18n/types'
import { errorLocaleForRun } from '../i18n/core'
import {
  getBoundedCompletionFailureCode,
  type BoundedCompletionFailureCode,
} from '../services/workflows/bounded-completion'
import { isWorkflowCancellation, WorkflowCancelledError } from '../services/workflows/workflow-cancellation'
import {
  formatPromptBudgetFailure,
  promptBudgetFailureFromError,
  type PromptBudgetFailureCode,
} from '../services/generation/prompt-budget-failure'
import type { PromptBudgetReport } from '../services/generation/generation-harness'
import {
  isProjectSessionContext,
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import { useProjectStore } from './project-store'
import { currentInterfaceLocale, useLocaleStore } from './locale-store'
import { navigate } from './navigation/navigation-intents'
import {
  normalizeWorkflowResourceKeys,
  workflowResourceClaimsConflict,
  type WorkflowResourceKind,
} from '../shared/workflow-resource-claims'
import type { FrozenWritingSkillSnapshot } from '../services/agent/writing-skill-bindings'
import { freezeWritingSkillsSnapshot } from '../services/agent/writing-skill-bindings'
import { stageNotice, type BackgroundNotice } from '../services/workflows/stage-notice'
import { ipc } from '../services/ipc-client'
import type { WritingSkillStage } from '../shared/writing-skills'

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled'

export type WorkflowStatus =
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'waiting'

export type WorkflowFailureCode = BoundedCompletionFailureCode | PromptBudgetFailureCode

export interface WorkflowStep {
  id: string
  name: string
  description: string
  status: StepStatus
  progress?: number
  activityText?: string
  result?: string
  failure?: Failure
  failureCode?: WorkflowFailureCode
  promptBudgetReport?: PromptBudgetReport
  generationActivity?: { operation: string; diagnostics?: GenerationTransportDiagnostics }
  startedAt?: string
  completedAt?: string
  lastProgressAt?: string
  logs: string[]
}

export interface WorkflowRun {
  characterProposalBatch?: CharacterProposalBatch
  characterProposalChoices?: CharacterProposalChoices
  id: string
  projectPath: string
  projectSession: ProjectSessionContext | null
  generationModelId?: string
  chapterWordsTarget?: number
  resourceKeys?: readonly string[]
  readResourceKeys?: readonly string[]
  writingLanguage: WritingLanguage
  uiLocale: Locale
  writingSkills?: ReadonlyArray<{
    stage: WritingSkillStage
    skillId: string
    name: string
    source: 'builtin' | 'user' | 'project'
    utf8Bytes: number
  }>
  type: WorkflowType
  title: string
  status: WorkflowStatus
  steps: WorkflowStep[]
  currentStepIndex: number
  createdAt: string
  completedAt?: string
  failure?: Failure
  failureCode?: WorkflowFailureCode
  promptBudgetReport?: PromptBudgetReport
  pauseRequested?: boolean
}

export type WorkflowType =
  | 'new_project_setup'
  | 'architecture_generation'
  | 'directory'
  | 'chapter_creation'
  | 'batch_generate'
  | 'config_generation'
  | 'post_process'
  | 'novel_import'

export type StepExecutor = (
  step: WorkflowStep,
  context: WorkflowContext,
  callbacks: StepCallbacks,
) => Promise<string | void>

export interface WorkflowContext {
  mainGenerationRootHandle?: import('../services/generation/generation-runtime').MainGenerationRunHandle
  mainGenerationRunHandle?: import('../services/generation/generation-runtime').MainGenerationRunHandle
  agentWorkflowRegistrationId?: string
  requestMainGenerationCancellation?: () => Promise<void>
  runId: string
  projectPath: string
  projectSession: ProjectSessionContext
  generationModelId?: string
  chapterWordsTarget?: number
  writingLanguage: WritingLanguage
  uiLocale: Locale
  interfaceLocale: ErrorDisplayLocale
  writingSkills?: FrozenWritingSkillSnapshot
  data: Record<string, unknown>
  cancelled: boolean
  cancelRequested?: boolean
  cancellationRequest?: Promise<void>
  pauseRequested?: boolean
}

export interface StepCallbacks {
  log: (message: string) => void
  setProgress: (progress: number) => void
  setActivityText?: (activityText: string | undefined) => void
  setPromptBudgetReport?: (report: PromptBudgetReport) => void
  setGenerationActivity?: (activity: NonNullable<WorkflowStep['generationActivity']>) => void
  appendText: (text: string) => void
  replaceText?: (text: string) => void
}

export interface WorkflowCompleteAction {
  mode: 'open' | 'silent'
  message?: string
  openResult?: () => void | Promise<void>
}

export interface WorkflowDefinition {
  onStarted?: () => void
  runId?: string
  agentWorkflowRegistration?: import('../shared/agent-generation').AgentWorkflowRegistration
  type: WorkflowType
  title: string
  projectPath: string
  projectSession: ProjectSessionContext
  generationModelId?: string
  chapterWordsTarget?: number
  resourceKeys?: readonly string[]
  readResourceKeys?: readonly string[]
  uiLocale?: Locale
  steps: Array<{
    name: string
    description: string
    executor: StepExecutor
    requiresConfirmation?: boolean
  }>
  onCancelRequested?: (context: WorkflowContext) => void | Promise<void>
  onCancelledAtBoundary?: (context: WorkflowContext) => void | Promise<void>
  onComplete?: WorkflowCompleteAction
  backgroundNotice?: BackgroundNotice
  withoutWritingSkills?: true
}

function isCurrentWorkflowSession(
  projectPath: string,
  projectSession: ProjectSessionContext,
): boolean {
  if (!sameProjectPathKey(projectSession.projectPath, projectPath)) return false
  return sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )
}

function normalizeGenerationModelId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeChapterWordsTarget(value: unknown): number | undefined {
  const parsed = Math.trunc(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function workflowResourceKey(
  kind: WorkflowResourceKind,
  identifier?: string | number,
): string {
  return identifier === undefined ? kind : `${kind}:${identifier}`
}

export function workflowResourceConflict(activeTitle: string): Failure {
  return { note: note(
    '该项目的相同内容正在由「{activeTitle}」生成。请等待完成或取消任务后再试。',
    'The same project content is already being generated by "{activeTitle}". Wait for it to finish or cancel it before retrying.',
    { activeTitle: authorOwned(activeTitle) },
  ) }
}

export function workflowResourceConflictMessage(locale: Locale, activeTitle: string): string {
  return failureText(errorLocaleForRun(locale, currentInterfaceLocale()), workflowResourceConflict(activeTitle))
}

const cancelledRun = (): Failure => ({ note: note('工作流已取消', 'Workflow was cancelled.') })
const sessionChanged = (): Failure => ({ note: note('项目会话已切换或失效', 'The project session changed or expired.') })

function findResourceConflict(
  activeRuns: readonly WorkflowRun[],
  definition: Pick<WorkflowDefinition, 'projectPath' | 'resourceKeys' | 'readResourceKeys'>,
): WorkflowRun | null {
  return activeRuns.find(run => (
    sameProjectPathKey(run.projectPath, definition.projectPath)
    && workflowResourceClaimsConflict(run, definition)
  )) ?? null
}

function uiText(locale: Locale, zhCNText: string, enUSText: string): string {
  return locale === 'en-US' ? enUSText : zhCNText
}

interface WorkflowState {
  activeRuns: WorkflowRun[]
  history: WorkflowRun[]
  globalLogs: Array<{ time: string; level: 'info' | 'warn' | 'error'; message: string }>

  currentRun: WorkflowRun | null

  waitingRuns: Record<string, { waitingForConfirm: boolean; waitingAfterStepIndex: number }>

  waitingForConfirm: boolean
  waitingAfterStepIndex: number

  isTypeRunning: (type: WorkflowType) => boolean
  getResourceConflict: (definition: Pick<
    WorkflowDefinition,
    'projectPath' | 'resourceKeys' | 'readResourceKeys'
  >) => WorkflowRun | null
  hasActiveRun: () => boolean
  activeCount: () => number

  startWorkflow: (definition: WorkflowDefinition, stepByStep?: boolean) => Promise<string>
  setCharacterProposalChoices: (runId: string, choices: CharacterProposalChoices) => boolean
  confirmContinue: (runId?: string) => void
  cancelWorkflow: (runId?: string) => void
  cancelProjectWorkflowsAndWait: (projectPath: string, timeoutMs?: number) => Promise<void>
  pauseWorkflow: (runId: string) => void
  resumeWorkflow: (runId: string) => void
  recordRunGenerationModel: (runId: string, modelId: string) => void
  addLog: (level: 'info' | 'warn' | 'error', message: string, locale?: Locale) => void
  clearLogs: () => void
}

const activeContexts = new Map<string, WorkflowContext>()
const continueResolveRefs = new Map<string, () => void>()
const pauseResolveRefs = new Map<string, () => void>()
const cancelRequestedHooks = new Map<string, (context: WorkflowContext) => void | Promise<void>>()
const cancelBoundaryHooks = new Map<string, (context: WorkflowContext) => void | Promise<void>>()

function isTerminalRunStatus(status: WorkflowStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function isCancellationPending(context: WorkflowContext): boolean {
  return context.cancelled || context.cancelRequested === true
}

function stoppedByCancellation(context: WorkflowContext, error: unknown): boolean {
  return isCancellationPending(context) && isWorkflowCancellation(error)
}

function computeCompat(activeRuns: WorkflowRun[], waitingRuns: Record<string, { waitingForConfirm: boolean; waitingAfterStepIndex: number }>) {
  const currentRun = activeRuns.length > 0 ? activeRuns[0] : null
  const firstRunId = currentRun?.id ?? ''
  const firstWaiting = waitingRuns[firstRunId]
  return {
    currentRun,
    waitingForConfirm: firstWaiting?.waitingForConfirm ?? false,
    waitingAfterStepIndex: firstWaiting?.waitingAfterStepIndex ?? -1,
  }
}

function prependRunHistory(history: WorkflowRun[], run: WorkflowRun): WorkflowRun[] {
  return [run, ...history.filter(previous => previous.id !== run.id)].slice(0, 50)
}

export const useWorkflowStore = create<WorkflowState>()((set, get) => ({
  activeRuns: [],
  history: [],
  globalLogs: [],
  waitingRuns: {},

  currentRun: null,
  waitingForConfirm: false,
  waitingAfterStepIndex: -1,

  isTypeRunning: (type) => get().activeRuns.some(r =>
    r.type === type
    && (r.status === 'running' || r.status === 'waiting' || r.status === 'paused' || r.status === 'cancelling')
  ),
  getResourceConflict: (definition) => findResourceConflict(get().activeRuns, definition),
  hasActiveRun: () => get().activeRuns.length > 0,
  activeCount: () => get().activeRuns.length,

  setCharacterProposalChoices: (runId, choices) => {
    const run = get().activeRuns.find(candidate => candidate.id === runId)
    const context = activeContexts.get(runId)
    const batch = context?.data.characterProposalBatch as CharacterProposalBatch | undefined
    if (!run || run.status !== 'waiting' || !context || context.cancelled || !batch
      || !sameProjectSessionContext(run.projectSession, projectSessionContextFromProject(useProjectStore.getState().currentProject))
      || choices.proposalBatchId !== batch.proposalBatchId || choices.revision !== batch.revision) return false
    const keys = new Set(batch.items.map(item => item.selectionKey))
    if (choices.selections.length !== keys.size || new Set(choices.selections.map(choice => choice.selectionKey)).size !== keys.size
      || choices.selections.some(choice => !keys.has(choice.selectionKey))) return false
    const frozen = structuredClone(choices)
    context.data.characterProposalChoices = frozen
    updateRunById(set, runId, { characterProposalChoices: structuredClone(frozen) })
    return true
  },

  confirmContinue: (runId) => {
    const targetId = runId ?? Object.keys(get().waitingRuns).find(id => get().waitingRuns[id]?.waitingForConfirm)
    if (!targetId) return
    const run = get().activeRuns.find(candidate => candidate.id === targetId)
    if (run?.characterProposalBatch && !sameProjectSessionContext(run.projectSession, projectSessionContextFromProject(useProjectStore.getState().currentProject))) return
    const resolve = continueResolveRefs.get(targetId)
    if (resolve) {
      resolve()
      continueResolveRefs.delete(targetId)
    }
    set(s => {
      const newWaiting = { ...s.waitingRuns }
      delete newWaiting[targetId]
      const compat = computeCompat(s.activeRuns, newWaiting)
      return { waitingRuns: newWaiting, ...compat }
    })
  },

  startWorkflow: async (definition, stepByStep = false) => {
    if (definition.runId && get().activeRuns.some(run => run.id === definition.runId)) {
      return definition.runId
    }
    const currentProject = useProjectStore.getState().currentProject
    const currentProjectSession = projectSessionContextFromProject(currentProject)
    const suppliedProjectSession = definition.projectSession
    const projectSession = isProjectSessionContext(suppliedProjectSession)
      && currentProjectSession
      && sameProjectSessionContext(suppliedProjectSession, currentProjectSession)
      && sameProjectPathKey(suppliedProjectSession.projectPath, definition.projectPath)
      ? Object.freeze({ ...suppliedProjectSession })
      : null
    const runId = definition.runId ?? randomUUID()
    const generationModelId = normalizeGenerationModelId(definition.generationModelId)
    const chapterWordsTarget = normalizeChapterWordsTarget(definition.chapterWordsTarget)
    const resourceKeys = normalizeWorkflowResourceKeys(definition.resourceKeys)
    const readResourceKeys = normalizeWorkflowResourceKeys(definition.readResourceKeys)
    const writingLanguage = resolveWritingLanguage(currentProject?.novelConfig.writingLanguage)
    const uiLocale = definition.uiLocale ?? useLocaleStore.getState().locale

    if (!projectSession) {
      const rejectedRun: WorkflowRun = {
        id: runId,
        projectPath: definition.projectPath,
        projectSession: isProjectSessionContext(suppliedProjectSession)
          ? Object.freeze({ ...suppliedProjectSession })
          : null,
        writingLanguage,
        uiLocale,
        type: definition.type,
        title: definition.title,
        status: 'failed',
        currentStepIndex: 0,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        failure: { note: note(
          '工作流缺少有效的冻结项目会话，已拒绝启动',
          'The workflow is missing a valid frozen project session and was not started.',
        ) },
        steps: definition.steps.map((step) => ({
          id: randomUUID(),
          name: step.name,
          description: step.description,
          status: 'pending',
          logs: [],
        })),
      }
      set(state => ({
        history: prependRunHistory(state.history, rejectedRun),
      }))
      get().addLog('error', uiText(
        uiLocale,
        `[拒绝] 工作流「${definition.title}」缺少有效冻结项目会话`,
        `[Rejected] Workflow "${definition.title}" is missing a valid frozen project session`,
      ), uiLocale)
      return runId
    }
    const resourceConflict = findResourceConflict(get().activeRuns, definition)
    if (resourceConflict) {
      const failure = workflowResourceConflict(resourceConflict.title)
      const rejectedRun: WorkflowRun = {
        id: runId,
        projectPath: definition.projectPath,
        projectSession,
        writingLanguage,
        uiLocale,
        ...(generationModelId ? { generationModelId } : {}),
        ...(chapterWordsTarget ? { chapterWordsTarget } : {}),
        ...(resourceKeys ? { resourceKeys } : {}),
        ...(readResourceKeys ? { readResourceKeys } : {}),
        type: definition.type,
        title: definition.title,
        status: 'failed',
        currentStepIndex: 0,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        failure,
        steps: definition.steps.map(step => ({
          id: randomUUID(),
          name: step.name,
          description: step.description,
          status: 'pending',
          logs: [],
        })),
      }
      set(state => ({ history: prependRunHistory(state.history, rejectedRun) }))
      get().addLog('warn', failureText(errorLocaleForRun(uiLocale, currentInterfaceLocale()), failure), uiLocale)
      return runId
    }
    const run: WorkflowRun = {
      id: runId,
      projectPath: definition.projectPath,
      projectSession,
      writingLanguage,
      uiLocale,
      ...(generationModelId ? { generationModelId } : {}),
      ...(chapterWordsTarget ? { chapterWordsTarget } : {}),
      ...(resourceKeys ? { resourceKeys } : {}),
      ...(readResourceKeys ? { readResourceKeys } : {}),
      type: definition.type,
      title: definition.title,
      status: 'running',
      currentStepIndex: 0,
      createdAt: new Date().toISOString(),
      steps: definition.steps.map((s) => ({
        id: randomUUID(),
        name: s.name,
        description: s.description,
        status: 'pending',
        logs: [],
      })),
    }

    const context: WorkflowContext = {
      ...(definition.agentWorkflowRegistration ? { mainGenerationRootHandle: definition.agentWorkflowRegistration.parentHandle,
        agentWorkflowRegistrationId: definition.agentWorkflowRegistration.registrationId } : {}),
      runId: run.id,
      projectPath: definition.projectPath,
      projectSession,
      writingLanguage,
      uiLocale,
      interfaceLocale: errorLocaleForRun(uiLocale, currentInterfaceLocale()),
      ...(generationModelId ? { generationModelId } : {}),
      ...(chapterWordsTarget ? { chapterWordsTarget } : {}),
      data: {},
      cancelled: false,
      pauseRequested: false,
    }
    activeContexts.set(run.id, context)
    if (definition.onCancelRequested) cancelRequestedHooks.set(run.id, definition.onCancelRequested)
    if (definition.type !== 'novel_import' && definition.onCancelledAtBoundary) {
      cancelBoundaryHooks.set(run.id, definition.onCancelledAtBoundary)
    }
    set(s => {
      const newRuns = [...s.activeRuns, run]
      const newHistory = s.history.filter(previous => previous.id !== run.id)
      return {
        activeRuns: newRuns,
        history: newHistory,
        ...computeCompat(newRuns, s.waitingRuns),
      }
    })

    const cancellationRequestSettled = () => context.cancellationRequest?.catch(() => undefined)

    const endBeforeFirstStep = async (status: 'failed' | 'cancelled', failure: Failure) => {
      await cancellationRequestSettled()
      updateRunById(set, run.id, { status, completedAt: new Date().toISOString(), failure })
      set(s => {
        const endedRun = s.activeRuns.find(active => active.id === run.id)
        const newRuns = s.activeRuns.filter(active => active.id !== run.id)
        return {
          activeRuns: newRuns,
          history: endedRun ? prependRunHistory(s.history, endedRun) : s.history,
          ...computeCompat(newRuns, s.waitingRuns),
        }
      })
      activeContexts.delete(run.id)
      cancelRequestedHooks.delete(run.id)
      cancelBoundaryHooks.delete(run.id)
    }
    const cancelBeforeFirstStep = async () => {
      await endBeforeFirstStep('cancelled', cancelledRun())
      get().addLog('warn', uiText(
        uiLocale,
        `[取消] 工作流「${definition.title}」已取消`,
        `[Cancelled] Workflow "${definition.title}" was cancelled`,
      ), uiLocale)
    }

    try {
      context.writingSkills = definition.withoutWritingSkills ? {} : await freezeWritingSkillsSnapshot(projectSession, writingLanguage)
    } catch (error) {
      if (stoppedByCancellation(context, error)) {
        await cancelBeforeFirstStep()
        return runId
      }
      const failure: Failure = {
        note: note('写作 Skill 快照加载失败，工作流未启动', 'Writing skill snapshot could not be loaded, so the workflow was not started.'),
        because: caughtFailure(error),
      }
      await endBeforeFirstStep('failed', failure)
      get().addLog('error', failureText(context.interfaceLocale, failure), uiLocale)
      return runId
    }
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) {
      if (isCancellationPending(context)) {
        await cancelBeforeFirstStep()
        return runId
      }
      await endBeforeFirstStep('failed', { note: note(
        '写作 Skill 快照加载期间项目已切换，工作流未启动',
        'The project changed while writing skills were being frozen, so the workflow was not started.',
      ) })
      return runId
    }
    const writingSkillSummaries = Object.values(context.writingSkills).map(skill => ({
      stage: skill.stage,
      skillId: skill.skillId,
      name: skill.name,
      source: skill.source,
      utf8Bytes: skill.utf8Bytes,
    }))
    if (writingSkillSummaries.length) {
      updateRunById(set, run.id, { writingSkills: Object.freeze(writingSkillSummaries) })
    }
    get().addLog('info', uiText(
      uiLocale,
      `[开始] 工作流「${definition.title}」已启动`,
      `[Started] Workflow "${definition.title}" started`,
    ), uiLocale)

    navigate({ kind: 'run', facet: 'output' })

    const waitForResumeAtSafeBoundary = async () => {
      if (!context.pauseRequested || isCancellationPending(context)) return

      updateRunById(set, run.id, { status: 'paused', pauseRequested: false })
      get().addLog('info', uiText(
        context.uiLocale,
        `[暂停] 工作流「${definition.title}」已在当前步骤完成后暂停`,
        `[Paused] Workflow "${definition.title}" paused after the current step`,
      ), context.uiLocale)
      await new Promise<void>((resolve) => { pauseResolveRefs.set(run.id, resolve) })
      if (!isCancellationPending(context)) {
        updateRunById(set, run.id, { status: 'running', pauseRequested: false })
        get().addLog('info', uiText(
          context.uiLocale,
          `[继续] 工作流「${definition.title}」已继续`,
          `[Resumed] Workflow "${definition.title}" resumed`,
        ), context.uiLocale)
      }
    }

    definition.onStarted?.()

    for (let i = 0; i < definition.steps.length; i++) {
      if (i > 0) await waitForResumeAtSafeBoundary()

      if (!isCancellationPending(context) && ((stepByStep && i > 0) || definition.steps[i].requiresConfirmation)) {
        const confirmed = new Promise<void>(resolve => { continueResolveRefs.set(run.id, resolve) })
        const batch = context.data.characterProposalBatch as CharacterProposalBatch | undefined
        if (batch) delete context.data.characterProposalChoices
        updateRunById(set, run.id, { status: 'waiting', ...(batch ? { characterProposalBatch: structuredClone(batch), characterProposalChoices: undefined } : {}) })
        set(s => {
          const newWaiting = { ...s.waitingRuns, [run.id]: { waitingForConfirm: true, waitingAfterStepIndex: i - 1 } }
          return { waitingRuns: newWaiting, ...computeCompat(s.activeRuns, newWaiting) }
        })
        get().addLog('info', uiText(
          context.uiLocale,
          `[暂停] [${definition.title}] 等待确认第 ${i + 1} 步：${definition.steps[i].name}`,
          `[Paused] [${definition.title}] Waiting for confirmation before step ${i + 1}: ${definition.steps[i].name}`,
        ), context.uiLocale)
        await confirmed
        if (!isCancellationPending(context)) updateRunById(set, run.id, { status: 'running' })
      }
      if (context.cancelled && definition.type !== 'novel_import') {
        updateRunById(set, run.id, {
          status: 'cancelled',
          failure: cancelledRun(),
        })
        get().addLog('warn', uiText(
          context.uiLocale,
          `[取消] 工作流「${definition.title}」已取消`,
          `[Cancelled] Workflow "${definition.title}" was cancelled`,
        ), context.uiLocale)
        break
      }

      if (!isCurrentWorkflowSession(definition.projectPath, context.projectSession)) {
        updateRunById(set, run.id, {
          status: 'failed',
          failure: sessionChanged(),
        })
        get().addLog('error', uiText(
          context.uiLocale,
          `[失败] 工作流「${definition.title}」已停止：项目会话已切换或失效`,
          `[Failed] Workflow "${definition.title}" stopped because the project session changed or expired`,
        ), context.uiLocale)
        break
      }

      const stepDef = definition.steps[i]

      updateStepById(set, run.id, i, { status: 'running', startedAt: new Date().toISOString(), activityText: undefined })
      updateRunById(set, run.id, { currentStepIndex: i })
      get().addLog('info', uiText(
        context.uiLocale,
        `[执行] [${definition.title}] 步骤: ${stepDef.name}`,
        `[Running] [${definition.title}] Step: ${stepDef.name}`,
      ), context.uiLocale)

      let promptBudgetAttemptCount = 0
      const callbacks: StepCallbacks = {
        log: (message) => {
          appendStepLogById(set, run.id, i, message)
          get().addLog('info', `  ${message}`, context.uiLocale)
        },
        setGenerationActivity: (generationActivity) => {
          updateStepById(set, run.id, i, { generationActivity })
        },
        setActivityText: (activityText) => {
          updateStepById(set, run.id, i, { activityText })
        },
        setProgress: (progress) => {
          updateStepById(set, run.id, i, { progress })
        },
        setPromptBudgetReport: (report) => {
          promptBudgetAttemptCount += 1
          const attributableReport = promptBudgetAttemptCount === 1 ? report : undefined
          updateStepById(set, run.id, i, { promptBudgetReport: attributableReport })
          updateRunById(set, run.id, { promptBudgetReport: attributableReport })
        },
        appendText: (text) => {
          const activeRun = get().activeRuns.find(r => r.id === run.id)
          const step = activeRun?.steps[i]
          if (
            activeRun?.status !== 'running'
            || activeRun.currentStepIndex !== i
            || step?.status !== 'running'
          ) return
          updateStepById(set, run.id, i, { result: (step.result || '') + text })
        },
        replaceText: (text) => {
          const activeRun = get().activeRuns.find(r => r.id === run.id)
          const step = activeRun?.steps[i]
          if (
            !activeRun
            || activeRun.currentStepIndex !== i
            || step?.status !== 'running'
          ) return
          const isRunningMutation = activeRun.status === 'running'
          const isCancellationCleanup = activeRun.status === 'cancelling' && text === ''
          if (isRunningMutation || isCancellationCleanup) {
            updateStepById(set, run.id, i, { result: text })
          }
        },
      }

      try {
        const result = await stepDef.executor(run.steps[i], context, callbacks)
        if (context.cancelled) {
          throw new WorkflowCancelledError(uiText(context.uiLocale, '工作流已取消', 'Workflow was cancelled.'))
        }
        if (!isCurrentWorkflowSession(definition.projectPath, context.projectSession)) {
          throw authorError(errorLocaleForRun(context.uiLocale, currentInterfaceLocale()), { note: note('项目会话已切换或失效，工作流已停止以避免跨项目写入', 'The project session changed or expired. The workflow stopped to prevent a cross-project write.') })
        }
        updateStepById(set, run.id, i, {
          status: 'completed',
          completedAt: new Date().toISOString(),
          progress: 100,
          result: result || get().activeRuns.find(r => r.id === run.id)?.steps[i].result,
        })
        get().addLog('info', uiText(
          context.uiLocale,
          `[完成] [${definition.title}] 步骤: ${stepDef.name}`,
          `[Completed] [${definition.title}] Step: ${stepDef.name}`,
        ), context.uiLocale)

      } catch (error) {
        if (stoppedByCancellation(context, error)) {
          const notice = error instanceof WorkflowCancelledError && error.notice ? { failure: { note: error.notice } } : {}
          updateStepById(set, run.id, i, { status: 'cancelled', completedAt: new Date().toISOString(), ...notice })
          const cancelReason = displayedErrorMessage(context.interfaceLocale, error)
          get().addLog('warn', uiText(
            context.uiLocale,
            `[取消] [${definition.title}] 步骤: ${stepDef.name} — ${cancelReason}`,
            `[Cancelled] [${definition.title}] Step: ${stepDef.name} — ${cancelReason}`,
          ), context.uiLocale)
          break
        }
        const promptBudgetFailure = promptBudgetFailureFromError(error, context.uiLocale)
        const failureCode = getBoundedCompletionFailureCode(error)
          ?? promptBudgetFailure?.failureCode
        const failure = promptBudgetFailure ? undefined : reasonOf(error)
        updateStepById(set, run.id, i, {
          status: 'failed',
          ...(failure ? { failure } : {}),
          ...(failureCode ? { failureCode } : {}),
          ...(promptBudgetFailure ? { promptBudgetReport: promptBudgetFailure.report } : {}),
          completedAt: new Date().toISOString(),
        })
        updateRunById(set, run.id, {
          status: 'failed',
          ...(failure ? { failure } : {}),
          ...(failureCode ? { failureCode } : {}),
          ...(promptBudgetFailure ? { promptBudgetReport: promptBudgetFailure.report } : {}),
        })
        const failedReason = promptBudgetFailure
          ? formatPromptBudgetFailure(promptBudgetFailure.report, context.uiLocale)
          : displayedErrorMessage(context.interfaceLocale, error)
        get().addLog('error', uiText(
          context.uiLocale,
          `[失败] [${definition.title}] 步骤: ${stepDef.name} — ${failedReason}`,
          `[Failed] [${definition.title}] Step: ${stepDef.name} — ${failedReason}`,
        ), context.uiLocale)
        break
      }
    }

    await cancellationRequestSettled()
    let finalRun = get().activeRuns.find(r => r.id === run.id)
    if (finalRun?.status !== 'failed' && (finalRun?.status === 'cancelling' || context.cancelled)) {
      const finalizeCancellation = cancelBoundaryHooks.get(run.id)
      if (finalizeCancellation) {
        try {
          await finalizeCancellation(context)
        } catch (error) {
          get().addLog('error', uiText(
            context.uiLocale,
            `[取消失败] 工作流「${definition.title}」未能持久化安全边界：${displayedErrorMessage(context.interfaceLocale, error)}`,
            `[Cancellation failed] Workflow "${definition.title}" could not persist its safe boundary: ${displayedErrorMessage(context.interfaceLocale, error)}`,
          ), context.uiLocale)
        }
      }
      updateRunById(set, run.id, {
        status: 'cancelled',
        failure: cancelledRun(),
        completedAt: new Date().toISOString(),
      })
      finalRun = get().activeRuns.find(r => r.id === run.id)
    }
    if (finalRun && finalRun.status === 'running' && !isCurrentWorkflowSession(
      definition.projectPath,
      context.projectSession,
    )) {
      updateRunById(set, run.id, {
        status: 'failed',
        failure: { note: note(
          '项目会话已切换或失效，未提交工作流完成结果',
          'The project session changed or expired, so the workflow completion result was not committed.',
        ) },
        completedAt: new Date().toISOString(),
      })
      finalRun = get().activeRuns.find(r => r.id === run.id)
    }
    if (finalRun && finalRun.status === 'running') {
      const projectSession = context.projectSession
      updateRunById(set, run.id, { status: 'completed', completedAt: new Date().toISOString() })
      get().addLog('info', uiText(
        context.uiLocale,
        `[完成] 工作流「${definition.title}」已完成`,
        `[Completed] Workflow "${definition.title}" completed`,
      ), context.uiLocale)

      globalEventBus.emit('WORKFLOW_COMPLETE', {
        type: definition.type,
        projectPath: definition.projectPath,
        projectSession,
        runId: run.id,
      })

      if (definition.onComplete) {
        const { mode, openResult } = definition.onComplete
        try {
          if (mode === 'open' && openResult) {
            await openResult()
          }
        } catch (e) {
          get().addLog('warn', uiText(
            context.uiLocale,
            `[警告] onComplete 执行失败: ${displayedErrorMessage(context.interfaceLocale, e)}`,
            `[Warning] onComplete failed: ${displayedErrorMessage(context.interfaceLocale, e)}`,
          ), context.uiLocale)
        }
      }
    }

    const endedRun = get().activeRuns.find(r => r.id === run.id)
    const notice = endedRun && definition.backgroundNotice && stageNotice(context.uiLocale, definition.backgroundNotice, endedRun, context.data)
    if (notice) void ipc.invoke('window:notify-stage', notice).catch(() => {})

    set(s => {
      const completedRun = s.activeRuns.find(r => r.id === run.id)
      const newRuns = s.activeRuns.filter(r => r.id !== run.id)
      const newWaiting = { ...s.waitingRuns }
      delete newWaiting[run.id]
      const newHistory = completedRun
        ? prependRunHistory(s.history, completedRun)
        : s.history
      return {
        activeRuns: newRuns,
        history: newHistory,
        waitingRuns: newWaiting,
        ...computeCompat(newRuns, newWaiting),
      }
    })

    activeContexts.delete(run.id)
    continueResolveRefs.delete(run.id)
    pauseResolveRefs.delete(run.id)
    cancelRequestedHooks.delete(run.id)
    cancelBoundaryHooks.delete(run.id)

    return run.id
  },

  cancelWorkflow: (runId) => {
    if (runId) {
      const ctx = activeContexts.get(runId)
      const targetRun = get().activeRuns.find(r => r.id === runId)
      if (!ctx || !targetRun || isTerminalRunStatus(targetRun.status)) {
        return
      }
      if (ctx) {
        const persistCancellation = cancelRequestedHooks.get(runId)
        if (persistCancellation && !ctx.cancellationRequest) {
          ctx.cancellationRequest = Promise.resolve(persistCancellation(ctx))
          void ctx.cancellationRequest.catch(error => {
            get().addLog('error', uiText(
              targetRun.uiLocale,
              `[取消失败] 未能立即保存取消请求：${displayedErrorMessage(ctx.interfaceLocale, error)}`,
              `[Cancellation failed] Could not persist the cancellation request immediately: ${displayedErrorMessage(ctx.interfaceLocale, error)}`,
            ), targetRun.uiLocale)
          })
        }
        if (targetRun.type === 'novel_import') ctx.cancelRequested = true
        else ctx.cancelled = true
        ctx.pauseRequested = false
        if (targetRun.type !== 'novel_import') {
          void ctx.requestMainGenerationCancellation?.().catch(error => get().addLog('error', displayedErrorMessage(ctx.interfaceLocale, error), targetRun.uiLocale))
        }
      }
      const resolve = continueResolveRefs.get(runId)
      if (resolve) { resolve(); continueResolveRefs.delete(runId) }
      const pauseResolve = pauseResolveRefs.get(runId)
      if (pauseResolve) { pauseResolve(); pauseResolveRefs.delete(runId) }
      set(s => {
        const newWaiting = { ...s.waitingRuns }
        delete newWaiting[runId]
        const newRuns = s.activeRuns.map(r => r.id === runId
          ? {
              ...r,
              status: 'cancelling' as const,
            }
          : r)
        return {
          activeRuns: newRuns,
          waitingRuns: newWaiting,
          ...computeCompat(newRuns, newWaiting),
        }
      })
      get().addLog('warn', uiText(
        targetRun.uiLocale,
        '[取消] 取消请求已提交，等待当前操作安全退出',
        '[Cancel requested] Waiting for the current operation to exit safely',
      ), targetRun.uiLocale)
    } else {
      const targetRuns = get().activeRuns.filter(run => !isTerminalRunStatus(run.status))
      for (const [id, ctx] of activeContexts) {
        const run = get().activeRuns.find(item => item.id === id)
        if (!run || isTerminalRunStatus(run.status)) continue
        const persistCancellation = cancelRequestedHooks.get(id)
        if (persistCancellation && !ctx.cancellationRequest) {
          ctx.cancellationRequest = Promise.resolve(persistCancellation(ctx))
          void ctx.cancellationRequest.catch(error => {
            get().addLog('error', uiText(
              run.uiLocale,
              `[取消失败] 未能立即保存取消请求：${displayedErrorMessage(ctx.interfaceLocale, error)}`,
              `[Cancellation failed] Could not persist the cancellation request immediately: ${displayedErrorMessage(ctx.interfaceLocale, error)}`,
            ), run.uiLocale)
          })
        }
        if (run.type === 'novel_import') ctx.cancelRequested = true
        else ctx.cancelled = true
        ctx.pauseRequested = false
        if (run.type !== 'novel_import') {
          void ctx.requestMainGenerationCancellation?.().catch(error => get().addLog('error', displayedErrorMessage(ctx.interfaceLocale, error), run.uiLocale))
        }
        const resolve = continueResolveRefs.get(id)
        if (resolve) { resolve(); continueResolveRefs.delete(id) }
        const pauseResolve = pauseResolveRefs.get(id)
        if (pauseResolve) { pauseResolve(); pauseResolveRefs.delete(id) }
      }
      set(s => {
        const cancellingRuns = s.activeRuns.map(r => ({
          ...r,
          ...(isTerminalRunStatus(r.status)
            ? {}
            : {
                status: 'cancelling' as const,
              }),
        }))
        return {
          activeRuns: cancellingRuns,
          waitingRuns: {},
          ...computeCompat(cancellingRuns, {}),
        }
      })
      for (const targetRun of targetRuns) {
        get().addLog('warn', uiText(
          targetRun.uiLocale,
          `[取消] 工作流「${targetRun.title}」的取消请求已提交，等待当前操作安全退出`,
          `[Cancel requested] Waiting for workflow "${targetRun.title}" to exit safely`,
        ), targetRun.uiLocale)
      }
    }
  },

  cancelProjectWorkflowsAndWait: async (projectPath, timeoutMs = 30_000) => {
    const targetRuns = get().activeRuns
      .filter(run => sameProjectPathKey(run.projectPath, projectPath))
    const targetIds = targetRuns.map(run => run.id)
    for (const runId of targetIds) {
      get().cancelWorkflow(runId)
    }
    if (targetIds.length === 0) return

    const deadline = Date.now() + timeoutMs
    while (get().activeRuns.some(run => sameProjectPathKey(run.projectPath, projectPath))) {
      if (Date.now() >= deadline) {
        throw authorError(errorLocaleForRun(targetRuns[0].uiLocale, currentInterfaceLocale()), { note: note('等待后台任务停止超时，项目保持打开状态', 'Timed out waiting for background tasks to stop; the project remains open.') })
      }
      await new Promise<void>(resolve => setTimeout(resolve, 50))
    }
  },

  pauseWorkflow: (runId) => {
    const context = activeContexts.get(runId)
    const run = get().activeRuns.find(item => item.id === runId)
    if (!context || !run || context.cancelled || run.status === 'paused') return

    context.pauseRequested = true
    updateRunById(set, runId, { pauseRequested: true })
    get().addLog('info', uiText(
      run.uiLocale,
      `[暂停] 已请求暂停「${run.title}」，将在当前章节完成后生效`,
      `[Pause requested] "${run.title}" will pause after the current chapter`,
    ), run.uiLocale)
  },

  resumeWorkflow: (runId) => {
    const context = activeContexts.get(runId)
    const run = get().activeRuns.find(item => item.id === runId)
    if (!context || !run || context.cancelled) return

    context.pauseRequested = false
    const resolve = pauseResolveRefs.get(runId)
    if (resolve) {
      resolve()
      pauseResolveRefs.delete(runId)
    } else {
      updateRunById(set, runId, { pauseRequested: false })
    }
  },

  recordRunGenerationModel: (runId, modelId) => {
    const run = get().activeRuns.find(candidate => candidate.id === runId)
    if (run && run.generationModelId !== modelId) updateRunById(set, runId, { generationModelId: modelId })
  },

  addLog: (level, message, locale = useLocaleStore.getState().locale) => {
    const entry = { time: new Date().toLocaleTimeString(locale), level, message }
    set((s) => ({
      globalLogs: [...s.globalLogs, entry].slice(-500),
    }))
  },

  clearLogs: () => set({ globalLogs: [] }),
}))

function updateRunById(
  set: (fn: (s: WorkflowState) => Partial<WorkflowState>) => void,
  runId: string,
  updates: Partial<WorkflowRun>
) {
  set((s) => {
    const newRuns = s.activeRuns.map(r =>
      r.id === runId ? { ...r, ...updates } : r
    )
    return { activeRuns: newRuns, ...computeCompat(newRuns, s.waitingRuns) }
  })
}

function advancesStep(step: WorkflowStep, { status, progress, result, generationActivity: activity }: Partial<WorkflowStep>): boolean {
  if (status === 'running' || (progress !== undefined && progress !== step.progress) || (result !== undefined && result !== step.result)) return true
  if (!activity) return false
  if (!activity.diagnostics) return true
  const before = step.generationActivity
  return before?.operation !== activity.operation
    || (before.diagnostics?.lastOutputMs ?? null) !== activity.diagnostics.lastOutputMs
    || before.diagnostics?.endReason !== activity.diagnostics.endReason
}

function updateStepById(
  set: (fn: (s: WorkflowState) => Partial<WorkflowState>) => void,
  runId: string,
  stepIndex: number,
  updates: Partial<WorkflowStep>
) {
  set((s) => {
    const newRuns = s.activeRuns.map(r => {
      if (r.id !== runId) return r
      const steps = [...r.steps]
      const step = steps[stepIndex]
      steps[stepIndex] = { ...step, ...updates, ...(advancesStep(step, updates) ? { lastProgressAt: new Date().toISOString() } : {}) }
      return { ...r, steps }
    })
    return { activeRuns: newRuns, ...computeCompat(newRuns, s.waitingRuns) }
  })
}

function appendStepLogById(
  set: (fn: (s: WorkflowState) => Partial<WorkflowState>) => void,
  runId: string,
  stepIndex: number,
  message: string
) {
  set((s) => {
    const newRuns = s.activeRuns.map(r => {
      if (r.id !== runId) return r
      const steps = [...r.steps]
      steps[stepIndex] = {
        ...steps[stepIndex],
        logs: [...steps[stepIndex].logs, `[${new Date().toLocaleTimeString(r.uiLocale)}] ${message}`],
      }
      return { ...r, steps }
    })
    return { activeRuns: newRuns, ...computeCompat(newRuns, s.waitingRuns) }
  })
}
