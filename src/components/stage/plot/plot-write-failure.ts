import { failureText, resultFailure } from '../../../i18n/app-errors'
import type { AuthorNote, Failure } from '../../../shared/failure'
import { currentInterfaceLocale } from '../../../stores/locale-store'

/** 「没写进作品」只是笼统的写失败，各入口自己的兜底句更具体，让给它；其余码按目录说明。 */
export function plotWriteFailureText(result: { failure?: Failure } | undefined, fallback: AuthorNote): string {
  const failure = result && resultFailure(result)
  return failureText(currentInterfaceLocale(), failure?.code === 'PLOT_THREAD_WRITE_FAILED' ? undefined : failure, { fallback })
}
