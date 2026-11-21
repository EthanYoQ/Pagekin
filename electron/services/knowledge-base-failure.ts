const CODE_SHAPE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u
const DISK_FULL = new Set(['ENOSPC', 'SQLITE_FULL'])
const UNWRITABLE = new Set(['EACCES', 'EPERM', 'EROFS', 'EBUSY', 'SQLITE_READONLY'])

/**
 * 交给界面的知识库失败码。已经是码的原样交出；文件系统与 SQLite 的盘满、不可写给作者能照做的码；
 * 其余（LanceDB 原生报错等）原文带本机路径和英文，只记进主进程日志，界面给通用码。
 */
export function knowledgeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (CODE_SHAPE.test(message)) return message
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && DISK_FULL.has(code)) return 'KNOWLEDGE_BASE_DISK_FULL'
  if (typeof code === 'string' && UNWRITABLE.has(code)) return 'KNOWLEDGE_BASE_UNWRITABLE'
  console.error('[AI Novel KB] 知识库操作失败:', error)
  return 'KNOWLEDGE_BASE_OPERATION_FAILED'
}
