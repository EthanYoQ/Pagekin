import { wireNote } from '../../src/i18n/app-errors'
import type { WireFailure } from '../../src/shared/failure'
import { MAX_TEXT_BYTES } from '../security/windows-safe-file-system'

const MAX_TEXT_MB = MAX_TEXT_BYTES / (1024 * 1024)

const READ_FAILURES = {
  SECURE_FS_INVALID_TEXT: 'error.externalFileNotUtf8',
  SECURE_FS_FILE_TOO_LARGE: 'error.externalFileTooLarge',
  SECURE_FS_OPEN_FAILED: 'error.externalFileOpenFailed',
  SECURE_FS_FILE_IN_USE: 'error.externalFileInUse',
} as const

function readFailureKey(error: unknown): (typeof READ_FAILURES)[keyof typeof READ_FAILURES] | undefined {
  const code = error instanceof Error ? error.message : String(error)
  return Object.hasOwn(READ_FAILURES, code) ? READ_FAILURES[code as keyof typeof READ_FAILURES] : undefined
}

export function readFailureNote(error: unknown) {
  const key = readFailureKey(error)
  return key && { key, params: { max: MAX_TEXT_MB } }
}

export function externalFileReadFailure(error: unknown): WireFailure {
  return { code: 'EXTERNAL_FILE_READ_FAILED', note: wireNote(readFailureKey(error) ?? 'error.externalFileUnreadable', { max: MAX_TEXT_MB }) }
}
