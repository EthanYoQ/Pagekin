import { enUS, type MessageKey } from './messages/en-US'
import { jaJP } from './messages/ja-JP'
import { zhCN } from './messages/zh-CN'
import { SUPPORTED_LOCALES, type ErrorDisplayLocale, type InterfaceLocale, type Locale, type MessageParams } from './types'

type Catalog = Record<string, string>

export const messages: Record<InterfaceLocale, Catalog> = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'ja-JP': jaJP,
}

export function resolveLocale(input?: string | null): Locale {
  return input?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

export function resolveInterfaceLocale(input?: string | null): InterfaceLocale {
  return input?.toLowerCase().startsWith('ja') ? 'ja-JP' : resolveLocale(input)
}

export function storedInterfaceLocale(value: unknown): InterfaceLocale | undefined {
  return SUPPORTED_LOCALES.includes(value as InterfaceLocale) ? value as InterfaceLocale : undefined
}

export function copyLocale(locale: InterfaceLocale): Locale {
  return locale === 'zh-CN' ? 'zh-CN' : 'en-US'
}

export function errorLocaleForRun(runCopyLocale: Locale, shown: ErrorDisplayLocale): ErrorDisplayLocale {
  return copyLocale(shown) === runCopyLocale ? shown : runCopyLocale as ErrorDisplayLocale
}

export function createTranslator(catalogs: Record<InterfaceLocale, Catalog>) {
  return (locale: InterfaceLocale, key: string, params: MessageParams = {}): string => {
    const template = catalogs[locale]?.[key] ?? catalogs['en-US'][key] ?? key
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
  }
}

const translateMessage = createTranslator(messages)

function interpolate(template: string, params: MessageParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
}

export interface LocalizedText {
  (zhCNText: string, enUSText: string, params?: MessageParams): string
  (zhCNText: string, enUSText: string, jaJPText: string, params?: MessageParams): string
}

export function selectCopy(
  locale: InterfaceLocale,
  zhCNText: string,
  enUSText: string,
  jaJPTextOrParams?: string | MessageParams,
  params?: MessageParams,
): string {
  const jaJPText = typeof jaJPTextOrParams === 'string' ? jaJPTextOrParams : undefined
  const chosen = locale === 'zh-CN' ? zhCNText : locale === 'ja-JP' && jaJPText ? jaJPText : enUSText
  return interpolate(chosen, typeof jaJPTextOrParams === 'string' ? params : jaJPTextOrParams)
}

export function localize(locale: InterfaceLocale, zhCNText: string, enUSText: string, params?: MessageParams): string
export function localize(locale: InterfaceLocale, zhCNText: string, enUSText: string, jaJPText: string, params?: MessageParams): string
export function localize(
  locale: InterfaceLocale,
  zhCNText: string,
  enUSText: string,
  jaJPTextOrParams?: string | MessageParams,
  params?: MessageParams,
): string {
  return selectCopy(locale, zhCNText, enUSText, jaJPTextOrParams, params)
}

export function translate(locale: InterfaceLocale, key: MessageKey, params?: MessageParams): string {
  return translateMessage(locale, key, params)
}

export type { InterfaceLocale, Locale, MessageKey, MessageParams }
