import { resultFailure } from '../i18n/app-errors'
import type { Failure } from '../shared/failure'

/** DRAFT_WRITE_FAILED 的说明是笼统的「已存的稿件都还在」，调用点自己的说明句更具体，让给它；其余码照传。 */
export function draftWriteFailure(result: { failure?: Failure }): Failure | undefined {
  const failure = resultFailure(result)
  return failure?.code === 'DRAFT_WRITE_FAILED' ? undefined : failure
}
