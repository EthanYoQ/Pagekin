import { isRegisteredErrorCode } from '../i18n/app-errors'
import type { AuthorNote, Failure } from '../shared/failure'

export function failureOr(fallback: AuthorNote, reason: Failure | undefined): Failure {
  if (reason && (reason.note || isRegisteredErrorCode(reason.code))) return reason
  return reason ? { note: fallback, because: reason } : { note: fallback }
}
