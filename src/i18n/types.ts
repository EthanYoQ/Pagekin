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
