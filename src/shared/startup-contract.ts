import type { MainReady } from './project-storage'
import type { APPEARANCE_STORAGE_KEY } from './appearance-profile'

export interface AppearanceReadbackAck {
  storageKey: typeof APPEARANCE_STORAGE_KEY
  profileRevision: number
  globalGeneration: string
}

export interface StartupMigrationNotice { legacySourceIgnored: boolean; preservedUnknownCount: number }
export type StartupBlockedCode = 'GLOBAL_DATA_BLOCKED' | 'GLOBAL_DISK_FULL' | 'GLOBAL_DATA_UNWRITABLE' | 'GLOBAL_MODEL_CREDENTIALS_DIFFER'
export type StartupState = MainReady & {
  code?: StartupBlockedCode
  migrationNotice?: StartupMigrationNotice
  appearanceRevisionFloor?: number
}
export interface StartupChannels {
  'startup:get-state': { args: []; return: StartupState }
  'startup:appearance-ack': { args: [ack: AppearanceReadbackAck]; return: boolean }
}
