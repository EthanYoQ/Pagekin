import { resultFailure } from '../i18n/app-errors'
import type { Failure } from '../shared/failure'

const GENERIC_WRITE_FAILURES: ReadonlySet<string> = new Set(['BLUEPRINT_WRITE_FAILED', 'PROJECT_CORE_WRITE_FAILED'])

/** 蓝图与故事设定的通用写失败码只说「没写进作品」，调用点自己的概述更具体，让给它；其余码照传。 */
export function specificWriteFailure(result: { failure?: Failure }): Failure | undefined {
  const failure = resultFailure(result)
  return failure?.code && GENERIC_WRITE_FAILURES.has(failure.code) ? undefined : failure
}
