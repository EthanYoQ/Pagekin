import { displayedErrorMessage } from '../app-errors'
import type { ErrorDisplayLocale, InterfaceLocale, Locale } from '../types'
import { workflowMainProcessError } from '../../services/workflows/workflow-project-session'

export function copyLocaleIsRejected(copy: Locale): void {
  // @ts-expect-error 文案语言不能查报错目录
  displayedErrorMessage(copy, 'PROJECT_NOT_OPEN')
  const widened: InterfaceLocale = copy
  // @ts-expect-error 放宽成界面语言类型也不能查
  displayedErrorMessage(widened, 'PROJECT_NOT_OPEN')
  // @ts-expect-error 工作流的冻结文案语言不能查
  workflowMainProcessError(copy, undefined, '失败', 'Failed.')
}

export function displayLocaleIsAccepted(display: ErrorDisplayLocale): void {
  displayedErrorMessage(display, 'PROJECT_NOT_OPEN')
  workflowMainProcessError(display, undefined, '失败', 'Failed.')
}
