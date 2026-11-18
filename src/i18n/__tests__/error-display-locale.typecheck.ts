import { displayedErrorMessage } from '../app-errors'
import type { InterfaceLocale, Locale } from '../types'
import { workflowMainProcessError } from '../../services/workflows/workflow-project-session'

/** tsc 检查：文案语言（日文界面下是 en-US）不能拿去查报错目录，放宽成 InterfaceLocale 也不行。 */
export function copyLocaleIsRejected(copy: Locale): void {
  // @ts-expect-error 文案语言不能查报错目录
  displayedErrorMessage(copy, 'PROJECT_NOT_OPEN')
  const widened: InterfaceLocale = copy
  // @ts-expect-error 放宽成界面语言类型也不能查
  displayedErrorMessage(widened, 'PROJECT_NOT_OPEN')
  // @ts-expect-error 工作流的冻结文案语言不能查
  workflowMainProcessError(copy, 'PROJECT_NOT_OPEN', '失败', 'Failed.')
}
