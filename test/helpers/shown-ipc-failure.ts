import { failureText, wireFailure } from '../../src/i18n/app-errors'
import { shown } from '../../src/i18n/__tests__/shown-locale'

export function withShownError(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('failure' in value)) return value
  const { failure, ...rest } = value as { failure: unknown }
  return { ...rest, error: failureText(shown('zh-CN'), wireFailure(failure)) }
}
