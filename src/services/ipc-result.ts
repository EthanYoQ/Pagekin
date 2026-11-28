import { authorError, catalogNote, IPC_HANDLER_FAILED, isRegisteredErrorCode, resultFailure } from '../i18n/app-errors'
import { AuthorNote, authorOwned, codeOf, type Failure } from '../shared/failure'
import { currentInterfaceLocale } from '../stores/locale-store'

export interface IpcMutationResult {
  success: boolean
  error?: string
  failure?: Failure
}

/**
 * 说不出原因时作者看到的动作名，三种界面语言各写一份：中文接在「没能」后，
 * 英文接在 Could not 后（小写动词短语），日文接在「に失敗しました」前（名词短语）。
 */
export type ActionName = readonly [zhCN: string, enUS: string, jaJP: string]

/**
 * IPC mutations report business failures as values rather than rejected
 * promises. Convert them to exceptions so workflows cannot continue after a
 * persistence operation failed.
 *
 * 抛出的错误带着这次失败，冻结了界面语言的调用方（导出、工作流）凭它按自己的语言重新说明。
 * 说不出原因的失败（没有码、原文、IPC_HANDLER_FAILED）显示调用点的兜底说明，码照样留着；原文只进日志。
 */
export function requireIpcSuccess<T extends IpcMutationResult>(
  result: T,
  unexplained: ActionName | AuthorNote,
): T {
  if (result.success) return result
  const failure = resultFailure(result)
  const code = failure && codeOf(failure)
  if (failure && (failure.note || code !== IPC_HANDLER_FAILED && isRegisteredErrorCode(code))) throw authorError(currentInterfaceLocale(), failure)
  const note = AuthorNote.minted(unexplained) ? unexplained : catalogNote('error.actionFailed', {
    actionZh: authorOwned(unexplained[0]), actionEn: authorOwned(unexplained[1]), actionJa: authorOwned(unexplained[2]),
  })
  throw authorError(currentInterfaceLocale(), code ? { code, note } : { note })
}
