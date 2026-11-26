import { failureText, wireFailure } from '../../src/i18n/app-errors'
import { shown } from '../../src/i18n/__tests__/shown-locale'

/** 主进程返回值的 failure 换成作者在中文界面看到的说明，放在 error 上，沿用按说明断言的控制器测试。 */
export function withShownError(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('failure' in value)) return value
  const { failure, ...rest } = value as { failure: unknown }
  return { ...rest, error: failureText(shown('zh-CN'), wireFailure(failure)) }
}
