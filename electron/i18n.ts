import { copyLocale, localize, resolveInterfaceLocale, storedInterfaceLocale, translate, type MessageKey, type MessageParams } from '../src/i18n/core'
import type { InterfaceLocale, Locale } from '../src/i18n/types'
import type { GlobalConfig } from '../src/shared/ipc-channels'
import { DEFAULT_GLOBAL_CONFIG, GLOBAL_CONFIG_PATH, readJsonFile } from './utils/config-utils'

export function resolveStoredOrSystemLocale(
  storedLocale: unknown,
  systemLocale: string | undefined,
): InterfaceLocale {
  return storedInterfaceLocale(storedLocale) ?? resolveInterfaceLocale(systemLocale)
}

/** Interface language of the main process: the stored setting, else the system language. */
export function getMainInterfaceLocale(systemLocale: string | undefined): InterfaceLocale {
  const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
  return resolveStoredOrSystemLocale(config.locale, systemLocale)
}

/** Language of colocated main-process copy (`mainText`): a `ja-JP` interface reads `en-US`. */
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

export function mainText(
  systemLocale: string | undefined,
  zhCNText: string,
  enUSText: string,
  params?: MessageParams,
): string {
  return localize(getMainLocale(systemLocale), zhCNText, enUSText, params)
}
