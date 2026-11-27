import { errorCodeOf } from '../../i18n/app-errors'
import { AuthorError, note, type AuthorNote } from '../../shared/failure'

const WORKFLOW_CANCELLED = note('工作流已取消', 'Workflow was cancelled.')

/**
 * 执行器看到作者的取消后停下时抛出；作者看到的说明按显示语言渲染，消息按运行语言写给日志，不带错误码。
 * 带 notice 时，这句说明交代了停在哪里、保住了什么，留在已取消的那一步上。
 */
export class WorkflowCancelledError extends AuthorError {
  constructor(message: string, readonly notice?: AuthorNote) {
    super({ note: notice ?? WORKFLOW_CANCELLED }, message)
  }
}

/** 仓库里所有取消码都是 CANCELLED 或以 _CANCELLED 结尾，例如 GENERATION_WORKFLOW_CANCELLED；模型的结束原因 cancelled 也算。 */
const CANCELLATION_CODE = /^(?:[A-Z0-9]+_)*CANCELLED$/u

function isCancellationCode(code: unknown): boolean {
  return typeof code === 'string' && CANCELLATION_CODE.test(code.trim().toUpperCase())
}

/**
 * 这次中止是不是取消本身造成的。认不出的错误一律不算，取消窗口里的真实错误才能照常记失败。
 * 包装层的 catch 只凭它决定能否换成 WorkflowCancelledError；取消标记已置位只能停止重试，不能改写错误。
 */
export function isWorkflowCancellation(error: unknown): boolean {
  if (error instanceof WorkflowCancelledError) return true
  const carried = typeof error === 'object' && error !== null ? error as { code?: unknown; failureCode?: unknown } : {}
  return [carried.code, carried.failureCode, errorCodeOf(error)].some(isCancellationCode)
}
