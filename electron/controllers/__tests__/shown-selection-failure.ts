import { failureText, receivedIpcResult } from '../../../src/i18n/app-errors'
import { shown } from '../../../src/i18n/__tests__/shown-locale'
import type { Failure } from '../../../src/shared/failure'

type Handler = (...args: unknown[]) => unknown
type ShownHandler = (...args: unknown[]) => Promise<unknown>

/** 把选文件失败换成导入对话框显示给作者的整句，放回 error 字段。 */
export function shownSelectionFailure(handler: Handler): ShownHandler {
  return async (...args) => {
    const result = receivedIpcResult(await handler(...args)) as { success?: boolean; failure?: Failure; locale?: 'zh-CN' | 'en-US' } | null
    if (!result || result.success !== false || !('failure' in result)) return result
    const { failure, locale, ...rest } = result
    return { ...rest, error: failureText(shown(locale ?? 'zh-CN'), failure) }
  }
}
