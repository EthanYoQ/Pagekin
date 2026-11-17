import { copyLocale, resolveInterfaceLocale, selectCopy, storedInterfaceLocale, translate, type MessageKey, type MessageParams } from '../src/i18n/core'
import type { ErrorDisplayLocale, InterfaceLocale, Locale } from '../src/i18n/types'
import type { GlobalConfig } from '../src/shared/ipc-channels'
import { DEFAULT_GLOBAL_CONFIG, GLOBAL_CONFIG_PATH, readJsonFile } from './utils/config-utils'

export function resolveStoredOrSystemLocale(
  storedLocale: unknown,
  systemLocale: string | undefined,
): InterfaceLocale {
  return storedInterfaceLocale(storedLocale) ?? resolveInterfaceLocale(systemLocale)
}

/** Interface language of the main process: the stored setting, else the system language. */
export function getMainInterfaceLocale(systemLocale: string | undefined): ErrorDisplayLocale {
  const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
  return resolveStoredOrSystemLocale(config.locale, systemLocale) as ErrorDisplayLocale
}

/** 主进程查报错目录用的界面语言；全局设置读不出时按系统语言，不让查语言的失败盖住原来的报错。 */
export function mainErrorDisplayLocale(systemLocale: string | undefined): ErrorDisplayLocale {
  try {
    return getMainInterfaceLocale(systemLocale)
  } catch {
    return resolveInterfaceLocale(systemLocale) as ErrorDisplayLocale
  }
}

/** Copy language of the main-process interface language: a `ja-JP` interface reads `en-US`. */
export function getMainLocale(systemLocale: string | undefined): Locale {
  return copyLocale(getMainInterfaceLocale(systemLocale))
}

export function mainT(
  systemLocale: string | undefined,
  key: MessageKey,
  params?: MessageParams,
): string {
  return translate(getMainInterfaceLocale(systemLocale), key, params)
}

export function mainText(systemLocale: string | undefined, zhCNText: string, enUSText: string, params?: MessageParams): string
export function mainText(systemLocale: string | undefined, zhCNText: string, enUSText: string, jaJPText: string, params?: MessageParams): string
export function mainText(
  systemLocale: string | undefined,
  zhCNText: string,
  enUSText: string,
  jaJPTextOrParams?: string | MessageParams,
  params?: MessageParams,
): string {
  return selectCopy(getMainInterfaceLocale(systemLocale), zhCNText, enUSText, jaJPTextOrParams, params)
}
