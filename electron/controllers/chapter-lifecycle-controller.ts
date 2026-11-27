import { handle } from '../ipc/handle'
import { isProjectSessionContext } from '../../src/shared/project-session-context'
import type {
  DeleteFinalizedChapterRequest,
  PurgeTrashRequest,
  RestoreTrashedChapterRequest,
} from '../../src/shared/chapter-deletion'
import type { ReopenChapterRequest } from '../../src/shared/chapter-reopen'
import { getCurrentProjectPath } from '../database'
import {
  chapterDeletionService,
  type ChapterDeletionService,
} from '../services/chapter-deletion-service'
import { reopenFinalizedChapter } from '../services/chapter-reopen-service'
import { ReplacementImpactRepository } from '../repositories/replacement-impact-repository'
import { removeReplacedKnowledge, removeReplacedManuscripts } from '../services/replaced-final-cleanup'
import { projectAccess } from '../services/project-access'
import { assertRequiredExpectedProjectPath } from '../utils/project-context'
import { finalizationStepErrorCode } from '../../src/shared/finalization-step-error'
import { IPC_HANDLER_FAILED, registeredErrorCode } from '../../src/i18n/app-errors'
import type { FailureCode } from '../../src/shared/failure'

type ChapterLifecycleHandler = (event: unknown, ...args: never[]) => unknown

const REPLACED_CLEANUP_CHANNELS = new Set(['chapter:remove-replaced-knowledge', 'chapter:remove-replaced-manuscripts'])

/** 被替换旧定稿的清理码（含 :[文件名]）原样记进定稿步骤，重试规则按它判，所以单独带回，不当作失败说明。 */
function failureFields(channel: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const stepError = REPLACED_CLEANUP_CHANNELS.has(channel) ? finalizationStepErrorCode(message) : undefined
  if (stepError) return { stepError }
  const code = registeredErrorCode(error) as FailureCode | undefined
  if (!code) console.error(`[AI Novel IPC] ${channel} 失败：`, error)
  return { failure: { code: code ?? IPC_HANDLER_FAILED } }
}

export function registerChapterLifecycleController(
  service: ChapterDeletionService = chapterDeletionService,
): void {
  const register = (channel: string, handler: ChapterLifecycleHandler) => {
    handle(channel, async (event, ...args: unknown[]) => {
      const candidate = args.at(-1)
      const context = isProjectSessionContext(candidate) ? candidate : undefined
      if (context) args.pop()
      try {
        const lease = projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath())
        return await (handler as (event: unknown, ...handlerArgs: unknown[]) => unknown)(
          event,
          ...args,
          lease.rootPath,
          lease.projectId,
        )
      } catch (error) {
        return { success: false, committed: false, ...failureFields(channel, error) }
      }
    })
  }

  register('chapter:delete-finalized', async (
    _event,
    request: DeleteFinalizedChapterRequest,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return service.delete(projectRoot, request)
  })

  register('chapter:retry-deletion', async (
    _event,
    operationId: string,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return service.retry(projectRoot, operationId)
  })

  register('chapter:confirm-legacy-knowledge-absent', async (
    _event,
    operationId: string,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return service.confirmLegacyKnowledgeAbsent(projectRoot, operationId)
  })

  register('chapter:reopen', async (
    _event,
    request: ReopenChapterRequest,
    expectedProjectPath: string,
    projectRoot: string,
    projectId: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return reopenFinalizedChapter(projectId, request)
  })

  register('chapter:remove-replaced-knowledge', async (
    _event,
    draftId: number,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    await removeReplacedKnowledge(projectRoot, draftId)
    return { success: true }
  })

  register('chapter:remove-replaced-manuscripts', async (
    _event,
    draftId: number,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    await removeReplacedManuscripts(projectRoot, draftId)
    return { success: true }
  })

  register('chapter:replacement-impacts', async (
    _event,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return { success: true, impacts: ReplacementImpactRepository.list() }
  })

  register('chapter:replacement-impact-preview', async (
    _event,
    draftId: number,
    content: string,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return { success: true, impact: ReplacementImpactRepository.preview(draftId, content) }
  })

  register('chapter:list-incomplete-deletions', async (
    _event,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return { success: true, operations: service.listIncomplete(projectRoot) }
  })

  register('chapter:trash-list', async (
    _event,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return service.listTrash()
  })

  register('chapter:trash-restore', async (
    _event,
    request: RestoreTrashedChapterRequest,
    expectedProjectPath: string,
    projectRoot: string,
    projectId: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return service.restore(projectRoot, projectId, request)
  })

  register('chapter:trash-purge', async (
    _event,
    request: PurgeTrashRequest,
    expectedProjectPath: string,
    projectRoot: string,
  ) => {
    assertRequiredExpectedProjectPath(projectRoot, expectedProjectPath)
    return service.purge(projectRoot, request)
  })
}
