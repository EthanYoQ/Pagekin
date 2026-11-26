import { failureText } from '../../i18n/app-errors'
import type { ErrorDisplayLocale } from '../../i18n/types'
import type { AuthorNote, Failure } from '../../shared/failure'

/** 蓝图操作失败的 toast：概述，空一行，再接原因。 */
export function blueprintFailureToast(locale: ErrorDisplayLocale, summary: AuthorNote, reason: Failure | undefined): string {
  return failureText(locale, { note: summary, ...(reason ? { because: reason } : {}) }, { join: 'paragraph' })
}
