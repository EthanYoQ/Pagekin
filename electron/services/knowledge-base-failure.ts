const CODE_SHAPE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u
const DISK_FULL = new Set(['ENOSPC', 'SQLITE_FULL'])
const UNWRITABLE = new Set(['EACCES', 'EPERM', 'EROFS', 'EBUSY', 'SQLITE_READONLY'])

export function knowledgeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (CODE_SHAPE.test(message)) return message
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && DISK_FULL.has(code)) return 'KNOWLEDGE_BASE_DISK_FULL'
  if (typeof code === 'string' && UNWRITABLE.has(code)) return 'KNOWLEDGE_BASE_UNWRITABLE'
  console.error('[AI Novel KB] 知识库操作失败:', error)
  return 'KNOWLEDGE_BASE_OPERATION_FAILED'
}
