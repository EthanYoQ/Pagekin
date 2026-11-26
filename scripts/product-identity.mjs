import { existsSync } from 'node:fs'
import path from 'node:path'

export const PRODUCT_NAME = '书童'
const LEGACY_PRODUCT_NAME = 'AI小说作家'
export const PRODUCT_NAMES = [PRODUCT_NAME, LEGACY_PRODUCT_NAME]

export const WINDOWS_EXECUTABLE_NAME = `${PRODUCT_NAME}.exe`
const WINDOWS_EXECUTABLE_NAMES = PRODUCT_NAMES.map(name => `${name}.exe`)

export const WINDOWS_PROCESS_TARGET_NAMES = [
  ...PRODUCT_NAMES.flatMap(name => [`${name}.exe`, name]),
  'ai-novel-writer',
]

export function resolveWindowsExecutable(directory) {
  const candidates = WINDOWS_EXECUTABLE_NAMES.map(name => path.join(directory, name))
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]
}

export function resolvePackagedWindowsExecutable(directory, { freshBuild }) {
  return freshBuild ? path.join(directory, WINDOWS_EXECUTABLE_NAME) : resolveWindowsExecutable(directory)
}

export function resolveMacExecutable(appBundle) {
  const candidates = PRODUCT_NAMES.map(name => path.join(appBundle, 'Contents', 'MacOS', name))
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]
}
