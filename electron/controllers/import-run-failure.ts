import { app } from 'electron'
import { knownAppErrorMessage } from '../../src/i18n/app-errors'
import { errorLocaleForRun, resolveLocale, translate } from '../../src/i18n/core'
import type { ErrorDisplayLocale, Locale } from '../../src/i18n/types'
import { failureCode, type WireFailure } from '../../src/shared/failure'
import { storedImportFailure } from '../../src/shared/import-run'
import { getMainLocale, mainErrorDisplayLocale } from '../i18n'
import { ImportRunRepository } from '../repositories/import-run-repository'

const IPC_PREFIX = /^Error invoking remote method '[^']+': /u
const CLASS_PREFIX = /^[A-Za-z]*Error: /u
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/u

export interface ImportRunFailure {
  error: string
  errorCode: string
  /** 只在码已登记时带；没登记的码由渲染端照旧读 errorCode。 */
  failure?: WireFailure
}

function rawReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim().replace(IPC_PREFIX, '').replace(CLASS_PREFIX, '')
}

/**
 * 导入对话框与导入运行卡片原样显示主进程交来的 error，失败原因还会存进导入运行的 last_error 供以后显示（#474）。
 * 所以在 IPC 边界按导入运行的界面语言写成说明：登记过的码用 app-errors 的文案；没登记的码（导入运行、收据与来源的
 * 完整性校验，以及效果收据提交时生成来源复核交出的 GENERATION_IMPORT_* 等）给带码的通用说明，原码放在 errorCode。
 * 不是码的（已按语言写好的说明）返回 undefined，由调用方照旧交出。
 * 语言可以传函数，只在认出码时才去查，免得查语言本身的失败盖住原来的报错。
 */
export function explainImportRunFailure(error: unknown, locale: Locale | (() => Locale)): ImportRunFailure | undefined {
  const code = rawReason(error)
  if (!ERROR_CODE.test(code)) return undefined
  const resolved = importErrorLocale(typeof locale === 'function' ? locale() : locale)
  const known = knownAppErrorMessage(resolved, code)
  const wire = known ? failureCode(code) : undefined
  return {
    error: known ?? translate(resolved, 'error.importRunCheckFailed', { code }),
    errorCode: code,
    ...(wire ? { failure: { code: wire } } : {}),
  }
}

/** 主进程捕获的失败存进 last_error：认得出的码换成说明，其余存通用说明，原文只进日志。 */
export function persistedImportRunFailure(error: unknown, locale: Locale | (() => Locale)): string {
  const explained = explainImportRunFailure(error, locale)?.error
  if (explained) return storedImportFailure(explained)
  console.error('[AI Novel] 导入运行失败，原文不存进记录：', error)
  return storedImportFailure(translate(importErrorLocale(typeof locale === 'function' ? locale() : locale), 'error.unregisteredCode'))
}

/** 导入的运行语言来自请求或运行记录，界面语言取主进程配置。 */
export function importErrorLocale(runLocale: Locale): ErrorDisplayLocale {
  return errorLocaleForRun(runLocale, mainErrorDisplayLocale(app.getLocale()))
}

/** 说明用的语言：请求自带的导入语言优先，其次是导入运行记下的语言，都没有时用应用界面语言。 */
export function importRunLocale(runId?: unknown, requestedLocale?: unknown): Locale {
  if (requestedLocale === 'zh-CN' || requestedLocale === 'en-US') return requestedLocale
  if (typeof runId === 'string') {
    try {
      const locale = ImportRunRepository.get(runId)?.locale
      if (locale) return locale
    } catch {
      // 项目数据库已关闭或运行记录读不出时只是拿不到运行语言，退回界面语言。
    }
  }
  try {
    return getMainLocale(app.getLocale())
  } catch {
    // 全局设置还读不出来时按系统语言说明，不让查语言的失败盖住导入本身的报错。
    return resolveLocale(app.getLocale())
  }
}
