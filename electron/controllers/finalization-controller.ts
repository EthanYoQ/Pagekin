import { handle } from '../ipc/handle'
import { getCurrentProjectPath } from '../database'
import { projectAccess } from '../services/project-access'
import { FinalizationService, type FinalizationIpcResult, type FinalizationResult } from '../services/finalization-service'
import { IPC_HANDLER_FAILED, registeredErrorCode } from '../../src/i18n/app-errors'
import type { FailureCode } from '../../src/shared/failure'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import { isProjectSessionContext } from '../../src/shared/project-session-context'
import type { FinalizationSnapshot } from '../../src/services/finalization-snapshot'

const finalizationService = new FinalizationService()

function isFinalizationSnapshot(value: unknown): value is FinalizationSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<FinalizationSnapshot>
  return (
    typeof snapshot.tabId === 'string'
    && typeof snapshot.projectPath === 'string'
    && isProjectSessionContext(snapshot.projectSession)
    && Number.isInteger(snapshot.draftId)
    && Number.isInteger(snapshot.chapterNumber)
    && typeof snapshot.chapterTitle === 'string'
    && typeof snapshot.content === 'string'
    && Number.isInteger(snapshot.contentRevision)
  )
}

function snapshotMatchesContext(
  snapshot: FinalizationSnapshot,
  context: ProjectSessionContext,
): boolean {
  return snapshot.projectPath === context.projectPath
    && snapshot.projectSession.projectId === context.projectId
    && snapshot.projectSession.leaseId === context.leaseId
    && snapshot.projectSession.projectPath === context.projectPath
}

/** 服务回的原因可能是 SQLite 或文件系统原文，只把已登记的码交给渲染端，原文进主进程日志。 */
function publicResult(channel: string, { error, ...result }: FinalizationResult): FinalizationIpcResult {
  if (error === undefined) return result
  const code = registeredErrorCode(error) as FailureCode | undefined
  if (!code) console.error(`[AI Novel IPC] ${channel} 失败：`, error)
  return { ...result, failure: { code: code ?? IPC_HANDLER_FAILED } }
}

/**
 * #23 的窄 IPC 边界。这里不复用 db-controller 的路径兼容调用，也不向 shared
 * IPC 增加宽泛路径 API；每个动作都必须带 #21 的当前项目会话并由 ProjectAccess
 * 重新验证。
 */
export function registerFinalizationController(): void {
  handle('finalization:commit', async (
    _event,
    candidate: unknown,
    context: unknown,
  ) => {
    try {
      if (!isFinalizationSnapshot(candidate)) {
        throw new Error('FINALIZATION_SNAPSHOT_INVALID')
      }
      if (!isProjectSessionContext(context) || !snapshotMatchesContext(candidate, context)) {
        throw new Error('FINALIZATION_SNAPSHOT_SESSION_MISMATCH')
      }
      const active = projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath())
      return publicResult('finalization:commit', await finalizationService.finalize({
        projectRoot: active.rootPath,
        draftId: candidate.draftId,
        chapterNumber: candidate.chapterNumber,
        chapterTitle: candidate.chapterTitle,
        content: candidate.content,
        contentRevision: candidate.contentRevision,
      }))
    } catch (error) {
      return publicResult('finalization:commit', { success: false, committed: false, error: String(error) })
    }
  })

  handle('finalization:retry', async (
    _event,
    finalizationId: unknown,
    context: unknown,
  ) => {
    try {
      if (typeof finalizationId !== 'string' || !finalizationId) {
        throw new Error('FINALIZATION_COMMIT_ID_REQUIRED')
      }
      if (!isProjectSessionContext(context)) {
        throw new Error('PROJECT_SESSION_REQUIRED')
      }
      const active = projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath())
      return publicResult('finalization:retry', await finalizationService.retry({
        projectRoot: active.rootPath,
        finalizationId,
      }))
    } catch (error) {
      return publicResult('finalization:retry', { success: false, committed: false, error: String(error) })
    }
  })
}
