import { app } from 'electron'
import { mainText } from '../i18n'
import { MAX_TEXT_BYTES } from '../security/windows-safe-file-system'

const MAX_TEXT_MB = MAX_TEXT_BYTES / (1024 * 1024)

const READ_FAILURES: Readonly<Record<string, readonly [zhCN: string, enUS: string]>> = {
  SECURE_FS_INVALID_TEXT: [
    '这个文件不是 UTF-8 编码的文本。请用文本编辑器另存为 UTF-8 后重新导入。',
    'This file is not UTF-8 text. Save it as UTF-8 in a text editor, then import it again.',
  ],
  SECURE_FS_FILE_TOO_LARGE: [
    `这个文件超过 ${MAX_TEXT_MB} MB，读不进来。请拆成几个小文件后重新导入。`,
    `This file is larger than ${MAX_TEXT_MB} MB and cannot be read. Split it into smaller files, then import them again.`,
  ],
  SECURE_FS_OPEN_FAILED: [
    '系统不让打开这个文件。请把它复制到桌面等普通文件夹，再重新导入。',
    'The system would not open this file. Copy it to a regular folder such as the Desktop, then import it again.',
  ],
  SECURE_FS_FILE_IN_USE: [
    '这个文件正被别的程序占用。请关掉打开它的程序，再重新导入。',
    'Another program is using this file. Close that program, then import it again.',
  ],
}

const UNREADABLE = [
  '无法读取所选文件；请重新选择后再试。',
  'Could not read the selected files. Please choose them again.',
] as const

export function readFailureCopy(error: unknown): readonly [zhCN: string, enUS: string] | undefined {
  // 解析路径在安全文件层之前，系统拒绝时 Node 只给错误号。
  const errno = (error as NodeJS.ErrnoException | null)?.code
  const code = errno === 'EPERM' || errno === 'EACCES'
    ? 'SECURE_FS_OPEN_FAILED'
    : error instanceof Error ? error.message : String(error)
  return Object.hasOwn(READ_FAILURES, code) ? READ_FAILURES[code] : undefined
}

export function externalFileReadFailureText(error: unknown): string {
  const [zhCN, enUS] = readFailureCopy(error) ?? UNREADABLE
  return mainText(app.getLocale(), zhCN, enUS)
}
