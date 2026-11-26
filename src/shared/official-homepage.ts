import { localize } from '../i18n/core'
import type { Locale } from '../i18n/types'

export const OFFICIAL_HOMEPAGE_URL = 'https://github.com/EthanYoQ/AI-Novel-Writer'

export function getOfficialHomepageOpenError(locale: Locale): string {
  return localize(
    locale,
    '无法打开官方主页，请稍后重试。',
    'Unable to open the official homepage. Please try again later.',
  )
}
