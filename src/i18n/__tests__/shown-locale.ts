import type { ErrorDisplayLocale, InterfaceLocale } from '../types'

export function shown(locale: InterfaceLocale): ErrorDisplayLocale {
  return locale as ErrorDisplayLocale
}
