import fs from 'node:fs'
import path from 'node:path'

function codesIn(files: string[], pattern: RegExp): string[] {
  const codes = new Set<string>()
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(pattern)) codes.add(match[0])
  }
  return [...codes].sort()
}

/** files 是 repoSourceFiles('electron/security') 列出的仓库相对路径；只取这一层的源码与 helper 脚本。 */
export function secureFileSystemCodes(files: readonly string[]): string[] {
  const sources = files.filter(file => path.posix.dirname(file) === 'electron/security' && /\.(ts|m|cs|ps1)$/.test(file))
  return codesIn(sources.map(file => path.resolve(file)), /SECURE_FS_[A-Z0-9_]+/g)
}

export function externalFileGrantCodes(): string[] {
  return codesIn([path.resolve('electron/services/external-file-grant-service.ts')], /EXTERNAL_FILE_GRANT_[A-Z0-9_]+/g)
}

export const READ_FAILURE_TEXT = {
  SECURE_FS_INVALID_TEXT: '这个文件不是 UTF-8 编码的文本。请用文本编辑器另存为 UTF-8 后重新导入。',
  SECURE_FS_FILE_TOO_LARGE: '这个文件超过 64 MB，读不进来。请拆成几个小文件后重新导入。',
  SECURE_FS_OPEN_FAILED: '系统不让打开这个文件。请把它复制到桌面等普通文件夹，再重新导入。',
  SECURE_FS_FILE_IN_USE: '这个文件正被别的程序占用。请关掉打开它的程序，再重新导入。',
  generic: '无法读取所选文件；请重新选择后再试。',
} as const

export function expectedReadFailureText(code: string): string {
  return Object.hasOwn(READ_FAILURE_TEXT, code)
    ? READ_FAILURE_TEXT[code as keyof typeof READ_FAILURE_TEXT]
    : READ_FAILURE_TEXT.generic
}
