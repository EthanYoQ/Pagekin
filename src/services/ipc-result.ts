import { authorError, isRegisteredErrorCode, resultFailure } from '../i18n/app-errors'
import { codeOf, type Failure } from '../shared/failure'
import { currentInterfaceLocale, useLocaleStore } from '../stores/locale-store'

export interface IpcMutationResult {
  success: boolean
  error?: string
  failure?: Failure
}

/**
 * IPC mutations report business failures as values rather than rejected
 * promises. Convert them to exceptions so workflows cannot continue after a
 * persistence operation failed.
 *
 * 抛出的错误带着这次失败，冻结了界面语言的调用方（导出、工作流）凭它按自己的语言重新说明。
 * action 多是只有中文的动作名，英文界面改用通用说明。
 */
export function requireIpcSuccess<T extends IpcMutationResult>(
  result: T,
  action: string,
  fallbackMessage?: string,
): T {
  if (!result.success) {
    const failure = resultFailure(result)
    if (failure && (failure.note || isRegisteredErrorCode(codeOf(failure)))) throw authorError(currentInterfaceLocale(), failure)
    const { text } = useLocaleStore.getState()
    throw new Error(fallbackMessage || text(`${action}失败`, 'The operation failed.'))
  }
  return result
}
