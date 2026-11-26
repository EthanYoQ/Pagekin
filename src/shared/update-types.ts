export interface UpdateReleaseInfo {
  version: string
  releaseName?: string
  releaseNotes?: string
  releaseDate?: string
}

export interface UpdateCheckResult {
  updateInfo?: UpdateReleaseInfo
}

export interface UpdatePreferences {
  lastCheckedAt?: string
  lastAutomaticCheckDate?: string
  availableUpdate?: UpdateReleaseInfo
  reminder?: UpdateReminder
}

export interface UpdateReminder {
  version: string
  until: string
}

export type UpdateReminderDelay = 7 | 30

export type UpdateAction = 'download' | 'open-release'

export type UpdateStatus = 'idle' | 'checking' | 'not-available' | 'available' | 'downloading' | 'downloaded' | 'error' | 'disabled'

export type UpdateErrorCode = 'UPDATES_DISABLED' | 'UPDATE_CONFIGURATION_MISSING' | 'CHECK_FAILED' | 'DOWNLOAD_NOT_READY' | 'DOWNLOAD_FAILED' | 'INSTALL_NOT_READY' | 'INSTALL_FAILED' | 'OPEN_RELEASE_FAILED' | 'REMINDER_NOT_AVAILABLE' | 'REMINDER_SAVE_FAILED' | 'INVALID_REMINDER_DELAY'

export type UpdateErrorPhase = 'configuration' | 'check' | 'download' | 'install' | 'navigation' | 'reminder'

export type UpdateErrorReason =
  | 'not-installed'
  | 'configuration-missing'
  | 'network'
  | 'proxy'
  | 'tls'
  | 'http-forbidden'
  | 'http-not-found'
  | 'http-rate-limited'
  | 'metadata-invalid'
  | 'asset-missing'
  | 'not-ready'
  | 'reminder-unavailable'
  | 'reminder-save-failed'
  | 'invalid-reminder-delay'
  | 'install-failed'
  | 'open-release-failed'
  | 'unknown'

export type SafeUpdateTechnicalDetails =
  | 'UPDATES_DISABLED'
  | 'UPDATE_CONFIGURATION_MISSING'
  | 'DNS_OR_OFFLINE'
  | 'PROXY_CONNECT_FAILED'
  | 'TLS_HANDSHAKE_FAILED'
  | 'HTTP_403'
  | 'HTTP_404'
  | 'HTTP_429'
  | 'UPDATE_METADATA_INVALID'
  | 'UPDATE_ASSET_MISSING'
  | 'UPDATE_OPERATION_FAILED'
  | 'DOWNLOAD_NOT_READY'
  | 'INSTALL_NOT_READY'
  | 'INSTALL_FAILED'
  | 'OPEN_RELEASE_FAILED'
  | 'REMINDER_NOT_AVAILABLE'
  | 'REMINDER_SAVE_FAILED'
  | 'INVALID_REMINDER_DELAY'

export interface UpdateError {
  code: UpdateErrorCode
  phase: UpdateErrorPhase
  reason: UpdateErrorReason
  retryable: boolean
  safeTechnicalDetails: SafeUpdateTechnicalDetails
}

export interface UpdateDownloadProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion?: string
  updateAction?: UpdateAction
  releaseName?: string
  releaseNotes?: string
  releaseDate?: string
  lastCheckedAt?: string
  reminderUntil?: string
  isReminderDeferred: boolean
  downloadProgress?: UpdateDownloadProgress
  error?: UpdateError
}

export interface UpdateCheckResponse {
  success: boolean
  checked: boolean
  updateAvailable: boolean
  state: UpdateState
  error?: UpdateError
}

export interface UpdateActionResponse {
  success: boolean
  state: UpdateState
  error?: UpdateError
}
