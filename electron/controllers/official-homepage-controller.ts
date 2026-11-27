import { shell } from 'electron'
import { handle } from '../ipc/handle'

import { OFFICIAL_HOMEPAGE_URL } from '../services/official-homepage-navigation'

export { OFFICIAL_HOMEPAGE_URL } from '../services/official-homepage-navigation'

export interface OfficialHomepageControllerOptions {
  /** Test-only dependency seam used by the offline packaged qualification. */
  openExternal?: (url: string) => Promise<void>
}

/** Registers the fixed, no-argument intent for opening the project's official homepage. */
export function registerOfficialHomepageController({
  openExternal = url => shell.openExternal(url),
}: OfficialHomepageControllerOptions = {}) {
  handle('official-homepage:open', async () => {
    try {
      await openExternal(OFFICIAL_HOMEPAGE_URL)
      return { success: true }
    } catch (error) {
      console.warn('[AI Novel Writer] Unable to open official homepage.', error)
      return { success: false, failure: { code: 'OFFICIAL_HOMEPAGE_OPEN_FAILED' } }
    }
  })
}
