import { translate } from '../i18n/core'
import type { Locale } from '../i18n/types'

export const OFFICIAL_HOMEPAGE_URL = 'https://github.com/EthanYoQ/AI-Novel-Writer'

export function getOfficialHomepageOpenError(locale: Locale): string {
  return translate(locale, 'error.officialHomepageOpenFailed')
}
