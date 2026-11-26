export const SUPPORTED_LOCALES = ['zh-CN', 'en-US', 'ja-JP'] as const

export type InterfaceLocale = typeof SUPPORTED_LOCALES[number]

export const COPY_LOCALES = ['zh-CN', 'en-US'] as const

export type Locale = typeof COPY_LOCALES[number]
export type MessageParams = Record<string, string | number>

declare const errorDisplay: unique symbol

export type ErrorDisplayLocale = InterfaceLocale & { readonly [errorDisplay]: true }
