import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { sameProjectPathKey } from '../../shared/project-session-context'
import type { WorkflowContext } from '../../stores/workflow-store'
import type { WritingLanguage } from '../../shared/writing-language'
import type { ErrorDisplayLocale, Locale } from '../../i18n/types'
import { authorError } from '../../i18n/app-errors'
import { note, type AuthorError, type Failure, type Literal, type NoteParams } from '../../shared/failure'

/**
 * 取出工作流启动时冻结的项目会话。
 *
 * 工作流中的项目 IPC 不能重新向 renderer 的 currentProject 借用租约；
 * 即使路径文字相同，重新打开同一项目也会得到不同的 leaseId。
 */
export function requireWorkflowProjectSession(context: WorkflowContext): ProjectSessionContext {
  const session = context.projectSession
  if (!session || !sameProjectPathKey(session.projectPath, context.projectPath)) {
    throw authorError(context.interfaceLocale, { note: note('工作流缺少匹配的冻结项目会话，已拒绝项目数据访问', 'The workflow is missing a matching frozen project session, so project data access was denied.') })
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

/** 主进程拒绝时的说明：概述在前，通道给的失败（resultFailure(result)）接在后面。 */
export function workflowMainProcessError<const Z extends string, const E extends string>(
  interfaceLocale: ErrorDisplayLocale,
  error: Failure | undefined,
  zhCNSummary: Literal<Z>,
  enUSSummary: Literal<E>,
  params?: NoteParams,
): AuthorError {
  const summary = note(zhCNSummary, enUSSummary, params)
  return authorError(interfaceLocale, error ? { note: summary, because: error } : { note: summary })
}
