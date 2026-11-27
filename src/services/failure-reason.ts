import { caughtFailure, containsHan, errorCodeOf, failureText, registeredErrorCode } from '../i18n/app-errors'
import { copyLocale } from '../i18n/core'
import type { ErrorDisplayLocale } from '../i18n/types'
import { failureCode, failureOf, type AuthorNote, type Failure, type LegacyReason } from '../shared/failure'

/** 还没标记的中文原因（生成 harness、解析器、主进程写的句子）按旧规则只在中文界面显示，其余只进控制台。 */
export function reasonOf(locale: ErrorDisplayLocale, error: unknown): Failure | LegacyReason | undefined {
  const marked = failureOf(error)
  if (marked) return marked
  const registered = failureCode(registeredErrorCode(error))
  if (registered) return { code: registered }
  const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  const legacy = copyLocale(locale) === 'zh-CN' && containsHan(raw) ? { legacy: raw } : undefined
  // 没登记的码照样留着（error.code 仍是它），说明只能靠中文原文。
  const code = failureCode(errorCodeOf(error))
  if (code) return legacy ? { code, because: legacy } : { code }
  return legacy ?? caughtFailure(error)
}

/** 原因能显示出来才用末尾带「原因」标签的那句，免得标签后面空着。 */
export function explained(locale: ErrorDisplayLocale, labelled: AuthorNote, plain: AuthorNote, because: Failure | LegacyReason | undefined): Failure {
  if (!because) return { note: plain }
  const shown = failureText(locale, { note: labelled, because }) !== failureText(locale, { note: labelled })
  return { note: shown ? labelled : plain, because }
}

export function failureOr(fallback: AuthorNote, reason: Failure | LegacyReason | undefined): Failure {
  if (reason && !('legacy' in reason)) return reason
  return reason ? { note: fallback, because: reason } : { note: fallback }
}
