import type { Failure, WireFailure } from '../shared/failure'
import type { UpdateError, UpdateErrorReason } from '../shared/update-types'
import { catalogNote, wireNote } from './app-errors'
import type { MessageKey } from './messages/en-US'

/** 这些原因有自己的说明，盖过码的说明；其余原因按码说明。 */
const REASON_KEYS: Partial<Record<UpdateErrorReason, Exclude<MessageKey, 'error.unknown'>>> = {
  'configuration-missing': 'error.updateConfigurationMissing',
  network: 'error.updateNetwork',
  proxy: 'error.updateProxy',
  tls: 'error.updateTls',
  'http-forbidden': 'error.updateForbidden',
  'http-not-found': 'error.updateReleaseNotFound',
  'http-rate-limited': 'error.updateRateLimited',
  'metadata-invalid': 'error.updateMetadataInvalid',
  'asset-missing': 'error.updateAssetMissing',
}

export function updateWireFailure({ code, reason }: Pick<UpdateError, 'code' | 'reason'>): WireFailure {
  const key = REASON_KEYS[reason]
  return { code, ...(key ? { note: wireNote(key) } : {}) }
}

export function updateFailure({ code, reason }: Pick<UpdateError, 'code' | 'reason'>): Failure {
  const key = REASON_KEYS[reason]
  return { code, ...(key ? { note: catalogNote(key) } : {}) }
}
