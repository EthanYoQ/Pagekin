import { shell } from 'electron'
import { handle } from '../ipc/handle'

import {
  isModelProviderResourceId,
  MODEL_PROVIDER_RESOURCE_URLS,
} from '../../src/shared/model-provider-resources'

export interface ModelProviderResourceControllerOptions {
  /** Injectable boundary for deterministic handling without exposing shell to the renderer. */
  openExternal?: (url: string) => Promise<void>
}

/** Opens only fixed, allowlisted model-provider destinations in the system browser. */
export function registerModelProviderResourceController({
  openExternal = url => shell.openExternal(url),
}: ModelProviderResourceControllerOptions = {}) {
  handle('model-provider-resource:open', async (_event, resource: unknown) => {
    if (!isModelProviderResourceId(resource)) {
      return { success: false, failure: { code: 'MODEL_PROVIDER_RESOURCE_OPEN_FAILED' } }
    }

    try {
      await openExternal(MODEL_PROVIDER_RESOURCE_URLS[resource])
      return { success: true }
    } catch (error) {
      console.warn('[AI Novel Writer] Unable to open model provider resource.', error)
      return { success: false, failure: { code: 'MODEL_PROVIDER_RESOURCE_OPEN_FAILED' } }
    }
  })
}
