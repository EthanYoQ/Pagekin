import { isRegisteredErrorCode } from '../i18n/app-errors'
import type { AuthorNote, Failure, LegacyReason } from '../shared/failure'

export function failureOr(fallback: AuthorNote, reason: Failure | LegacyReason | undefined): Failure {
  if (reason && !('legacy' in reason) && (reason.note || isRegisteredErrorCode(reason.code))) return reason
  return reason ? { note: fallback, because: reason } : { note: fallback }
}
