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

/** Copy language for a system or stored locale: Chinese for `zh*`, English otherwise. */
export function resolveLocale(input?: string | null): Locale {
  return input?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/** Interface language for a system locale: `ja*` selects Japanese, the rest follow resolveLocale. */
export function resolveInterfaceLocale(input?: string | null): InterfaceLocale {
  return input?.toLowerCase().startsWith('ja') ? 'ja-JP' : resolveLocale(input)
}

/** A stored interface language, or undefined when the value is missing or unknown. */
export function storedInterfaceLocale(value: unknown): InterfaceLocale | undefined {
  return SUPPORTED_LOCALES.includes(value as InterfaceLocale) ? value as InterfaceLocale : undefined
}

/** 界面语言对应的文案语言：ja-JP 读英文。运行与存档只记这一种。 */
export function copyLocale(locale: InterfaceLocale): Locale {
  return locale === 'zh-CN' ? 'zh-CN' : 'en-US'
}

/**
 * 冻结了文案语言的运行（运行卡片、工作流、导入）查报错目录用的语言：运行的文案语言与界面一致时用界面语言
 * （日文界面看英文运行得到 ja-JP），不一致时用运行自己的语言，原因和运行里其余文字是同一种语言。
 */
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

/**
 * Localize short copy that belongs to a single component. Shared language uses
 * the keyed catalog above; colocating one-off copy keeps the catalog focused.
 */
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
