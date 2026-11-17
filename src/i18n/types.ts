/** Interface languages the author can choose in Settings → Appearance. */
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US', 'ja-JP'] as const

export type InterfaceLocale = typeof SUPPORTED_LOCALES[number]

/**
 * Languages that colocated copy (`text(zh, en)`, `localize`, …) is written in.
 * A `ja-JP` interface reads this copy in English until each area gains Japanese copy (#722).
 */
export const COPY_LOCALES = ['zh-CN', 'en-US'] as const

export type Locale = typeof COPY_LOCALES[number]
export type MessageParams = Record<string, string | number>

declare const errorDisplay: unique symbol

/**
 * 查报错目录用的语言：作者在设置里选的界面语言。只由 locale-store、主进程配置和 errorLocaleForRun 给出，
 * 文案语言 `Locale`（日文界面下是 en-US）传不进来，放宽成 `InterfaceLocale` 也不行。
 */
export type ErrorDisplayLocale = InterfaceLocale & { readonly [errorDisplay]: true }
