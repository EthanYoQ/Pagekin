import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { sameProjectPathKey } from '../../shared/project-session-context'
import type { WorkflowContext } from '../../stores/workflow-store'
import type { WritingLanguage } from '../../shared/writing-language'
import type { ErrorDisplayLocale, Locale } from '../../i18n/types'
import { displayedErrorMessage, errorCodeOf, isRegisteredErrorCode } from '../../i18n/app-errors'
import { copyLocale } from '../../i18n/core'

/**
 * 取出工作流启动时冻结的项目会话。
 *
 * 工作流中的项目 IPC 不能重新向 renderer 的 currentProject 借用租约；
 * 即使路径文字相同，重新打开同一项目也会得到不同的 leaseId。
 */
export function requireWorkflowProjectSession(context: WorkflowContext): ProjectSessionContext {
  const session = context.projectSession
  if (!session || !sameProjectPathKey(session.projectPath, context.projectPath)) {
    throw new Error(workflowUiText(
      context,
      '工作流缺少匹配的冻结项目会话，已拒绝项目数据访问',
      'The workflow is missing a matching frozen project session, so project data access was denied.',
    ))
  }
  return session
}

export function workflowWritingLanguage(context: WorkflowContext): WritingLanguage {
  return context.writingLanguage
}

export function workflowUiLocale(context: WorkflowContext): Locale {
  return context.uiLocale
}

export function workflowUiText(
  context: WorkflowContext,
  zhCNText: string,
  enUSText: string,
): string {
  return workflowUiLocale(context) === 'en-US' ? enUSText : zhCNText
}

/**
 * 主进程拒绝时只回 String(err)：多是只有中文的原文，也可能是错误码。登记过的码按界面语言说明；
 * 未登记的码只给说明，码挂在 code 上并记进控制台（#787）；其余原文只附在中文说明后面，英文界面只给英文说明。
 */
export function workflowMainProcessError(
  interfaceLocale: ErrorDisplayLocale,
  error: unknown,
  zhCNSummary: string,
  enUSSummary: string,
): Error {
  const english = copyLocale(interfaceLocale) === 'en-US'
  const summary = english ? enUSSummary : zhCNSummary
  if (typeof error !== 'string') return new Error(summary)
  const code = errorCodeOf(error)
  // 未登记的码和空原文都落到这里给的兜底，也就是说明本身，不再接一遍。
  const shown = displayedErrorMessage(interfaceLocale, error, summary)
  const reason = shown === summary || (english && !isRegisteredErrorCode(error)) ? undefined : shown
  const failure = new Error(reason ? `${summary}${english ? ' ' : '：'}${reason}` : summary)
  return code ? Object.assign(failure, { code }) : failure
}
