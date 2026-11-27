import { failureText, receivedIpcResult } from '../../../src/i18n/app-errors'
import type { ErrorDisplayLocale } from '../../../src/i18n/types'
import type { Failure } from '../../../src/shared/failure'

/** 把 failure 按界面语言写成句子放进 error，读句子的断言不用改。 */
export function rendered<T>(result: T, locale: string): T & { error?: string } {
  const received = receivedIpcResult(result) as T & { success?: unknown; failure?: Failure }
  if (received?.success !== false || !received.failure) return received
  return { ...received, error: failureText(locale as ErrorDisplayLocale, received.failure) }
}
