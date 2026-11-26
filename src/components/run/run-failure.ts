import { useState } from 'react'
import { displayedErrorMessage, failureText } from '../../i18n/app-errors'
import { launchCreativeWorkflow } from '../../services/workflows/creative-workflow-launcher'
import { projectSessionContextFromProject, sameProjectPathKey, sameProjectSessionContext } from '../../shared/project-session-context'
import { navigate } from '../../stores/navigation/navigation-intents'
import { currentInterfaceLocale } from '../../stores/locale-store'
import { errorLocaleForRun } from '../../i18n/core'
import type { ErrorDisplayLocale } from '../../i18n/types'
import type { Failure, LegacyReason } from '../../shared/failure'
import { useProjectStore } from '../../stores/project-store'
import type { WorkflowRun } from '../../stores/workflow-store'
import { toast } from '../ui/Toast'
import { presentWorkflowFailure, type WorkflowFailurePresentation } from '../panels/ai-output-failure-presentation'

export interface RunFailure {
  title: string
  presentation: WorkflowFailurePresentation
  /** 情节大纲生成被截断且已完成部分已保存：可以从断点续写。 */
  canResumeOutline: boolean
  /** 情节大纲途中来源被改：同一运行不能恢复，只能到架构页从本批起始章重新生成。 */
  canRestartOutline: boolean
}

const hasNote = (failure: Failure | LegacyReason | undefined): boolean =>
  failure !== undefined && !('legacy' in failure) && (failure.note !== undefined || hasNote(failure.because))

export function runFailure(run: WorkflowRun, interfaceLocale: ErrorDisplayLocale): RunFailure {
  const failedStep = run.steps.find(step => step.status === 'failed')
  const currentStep = run.steps[run.currentStepIndex] ?? run.steps[0]
  const failure = run.failure ?? failedStep?.failure
  const locale = errorLocaleForRun(run.uiLocale, interfaceLocale)
  const legacy = run.error || currentStep?.error
  return {
    title: run.title,
    presentation: presentWorkflowFailure(
      run.failureCode ?? currentStep?.failureCode,
      failure && !legacy?.trim() ? failureText(locale, failure) : legacy,
      locale,
      run.type === 'chapter_creation' && run.chapterWordsTarget !== undefined && !(currentStep?.result || '').trim(),
      run.promptBudgetReport ?? currentStep?.promptBudgetReport,
      failedStep?.generationActivity ?? currentStep?.generationActivity,
      failure && hasNote(failure) ? failureText(locale, failure) : undefined,
    ),
    canResumeOutline: failure?.recovery === 'resume-plot-outline',
    canRestartOutline: failure?.recovery === 'restart-plot-outline',
  }
}

/** 运行属于当前打开的这次项目会话；失败提示里的动作只对它生效。 */
export function isCurrentSessionRun(run: Pick<WorkflowRun, 'projectPath' | 'projectSession'>): boolean {
  const project = useProjectStore.getState().currentProject
  return sameProjectPathKey(run.projectPath, project?.path)
    && sameProjectSessionContext(run.projectSession, projectSessionContextFromProject(project))
}

export function openNovelConfigurationFor(run: WorkflowRun): void {
  if (isCurrentSessionRun(run)) navigate({ kind: 'stage', stage: 'setup' })
}

export function openArchitectureFor(run: WorkflowRun): void {
  if (isCurrentSessionRun(run)) navigate({ kind: 'stage', stage: 'architecture' })
}

/** 从断点续写情节大纲：已完成部分已存为不完整大纲，这次让模型接着末尾写。 */
export function useResumePlotOutline(run: WorkflowRun) {
  const [resuming, setResuming] = useState(false)
  const resume = async () => {
    if (resuming || !run.projectSession || !isCurrentSessionRun(run)) return
    setResuming(true)
    try {
      await launchCreativeWorkflow({ workflow: 'generate_architecture', selectedSteps: ['synopsis'], resumeSynopsis: true }, run.projectSession)
    } catch (error) {
      const detail = displayedErrorMessage(errorLocaleForRun(run.uiLocale, currentInterfaceLocale()), error)
      toast.error(run.uiLocale === 'en-US' ? `Failed to start the continuation: ${detail}` : `续写启动失败：${detail}`)
    } finally {
      setResuming(false)
    }
  }
  return { resuming, resume }
}
