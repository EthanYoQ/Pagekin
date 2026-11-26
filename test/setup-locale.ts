import { beforeEach } from 'vitest'

import { useLocaleStore } from '../src/stores/locale-store'

export function resetTestLocale(): void {
  useLocaleStore.setState({ locale: 'zh-CN', initialized: false })
}

beforeEach(resetTestLocale)
