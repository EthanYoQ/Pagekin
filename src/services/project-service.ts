import { globalEventBus, type EventPayloadMap } from '../shared/event-bus'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import { useProjectStore } from '../stores/project-store'
import { useCharacterStore } from '../stores/character-store'
import { useDraftStore } from '../stores/draft-store'
import { useEditorStore } from '../stores/editor-store'
import { useWorkflowStore } from '../stores/workflow-store'
import { currentInterfaceLocale, useLocaleStore } from '../stores/locale-store'
import { failureText, reasonOf } from '../i18n/app-errors'
import { note, type AuthorNote } from '../shared/failure'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import {
  reconcileFinalizationCompletion,
  type FinalizationCompletion,
  type FinalizationSnapshot,
} from './finalization-snapshot'

let disposers: Array<() => void> = []

function runProjectEventTask(label: () => string, task: () => Promise<void>): void {
  void task().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    const locale = useLocaleStore.getState().locale
    const localizedLabel = label()
    console.error(`[ProjectService] ${localizedLabel}:`, error)
    globalEventBus.emit('SYSTEM_NOTICE', {
      level: 'error',
      message: locale === 'zh-CN' ? `${localizedLabel}：${message}` : localizedLabel,
    })
  })
}

function isProjectSessionCurrent(projectSession: ProjectSessionContext): boolean {
  return sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )
}

function isActiveWorkflowForProjectSession(
  runId: string,
  projectSession: ProjectSessionContext,
): boolean {
  return useWorkflowStore.getState().activeRuns.some(run => (
    run.id === runId
    && sameProjectSessionContext(run.projectSession, projectSession)
  ))
}

export function initProjectService(): void {
  const text = useLocaleStore.getState().text
  if (disposers.length > 0) return

  disposers.push(
    globalEventBus.on('WORKFLOW_COMPLETE', (payload) => runProjectEventTask(
      () => text('工作流完成后的项目刷新失败', 'Could not refresh project data after workflow completion'),
      async () => {
      console.log('[ProjectService] WORKFLOW_COMPLETE 事件触发:', payload.type)
      if (!isProjectSessionCurrent(payload.projectSession)) return

      if (payload.type === 'config_generation') {
        console.log('[ProjectService] config_generation 完成，跳过资源刷新')
        return
      }

      if (payload.type === 'chapter_creation') {
        console.log('[ProjectService] 刷新草稿和角色卡...')
        await Promise.all([
          useDraftStore.getState().loadAllDrafts(payload.projectPath, payload.projectSession),
          useCharacterStore.getState().load(payload.projectPath, payload.projectSession),
        ])
        if (!isProjectSessionCurrent(payload.projectSession)) return
        console.log('[ProjectService] 草稿和角色卡刷新完成')
      } else if (payload.type === 'architecture_generation') {
        console.log('[ProjectService] 刷新角色卡...')
        await useCharacterStore.getState().load(payload.projectPath, payload.projectSession)
        if (!isProjectSessionCurrent(payload.projectSession)) return
        console.log('[ProjectService] 角色卡刷新完成')
      }
      },
    ))
  )

  disposers.push(
    globalEventBus.on('FINALIZE_COMPLETE', (payload) => runProjectEventTask(
      () => text('定稿后的项目刷新失败', 'Could not refresh project data after finalization'),
      async () => {
      const project = useProjectStore.getState().currentProject
      if (!project || !sameProjectSessionContext(
        projectSessionContextFromProject(project),
        payload.projectSession,
      )) return

      syncFinalizedDraftTab(payload)

      await Promise.all([
        useDraftStore.getState().loadChapterDrafts(
          payload.chapterNumber,
          payload.projectPath,
          payload.projectSession,
        ),
        useCharacterStore.getState().load(payload.projectPath, payload.projectSession),
      ])
      if (!isProjectSessionCurrent(payload.projectSession)) return
      },
    ))
  )

  disposers.push(
    globalEventBus.on('ARCH_POSTPROCESS_UPDATED', (payload) => runProjectEventTask(
      () => text('架构后处理刷新失败', 'Could not refresh character cards after architecture post-processing'),
      async () => {
      if (
        !isProjectSessionCurrent(payload.projectSession)
        || !isActiveWorkflowForProjectSession(payload.runId, payload.projectSession)
      ) return
      await useCharacterStore.getState().load(payload.projectPath, payload.projectSession)
      if (!isProjectSessionCurrent(payload.projectSession)) return
      },
    ))
  )

  disposers.push(
    globalEventBus.on('CHARACTER_EXTRACT_FAILED', (payload) => runProjectEventTask(
      () => text('角色卡失败状态刷新失败', 'Could not refresh character-card failure status'),
      async () => {
      if (
        !isProjectSessionCurrent(payload.projectSession)
        || !isActiveWorkflowForProjectSession(payload.runId, payload.projectSession)
      ) return
      await useCharacterStore.getState().load(payload.projectPath, payload.projectSession)
      if (!isProjectSessionCurrent(payload.projectSession)) return
      },
    ))
  )

  disposers.push(
    globalEventBus.on('REFRESH_RESOURCE', (payload) => runProjectEventTask(
      () => text('项目资源刷新失败', 'Could not refresh project resources'),
      async () => {
      const projectPath = payload.projectPath
      if (!isProjectSessionCurrent(payload.projectSession)) return
      const resources = payload.resources
      if (resources.includes('all') || resources.includes('characterCards')) {
        await useCharacterStore.getState().load(projectPath, payload.projectSession)
        if (!isProjectSessionCurrent(payload.projectSession)) return
      }
      if (resources.includes('all') || resources.includes('drafts')) {
        await useDraftStore.getState().loadAllDrafts(projectPath, payload.projectSession)
        if (!isProjectSessionCurrent(payload.projectSession)) return
      }
      },
    ))
  )

  console.log('[ProjectService] 已初始化，事件监听已注册')
}

export function onProjectOpening(projectSession: ProjectSessionContext): void {
  useCharacterStore.getState().beginProjectLoad(projectSession.projectPath)
  useDraftStore.getState().beginProjectLoad(projectSession.projectPath)
}

export async function onProjectOpened(
  projectSession: ProjectSessionContext,
): Promise<{ warnings: string[] }> {
  const text = useLocaleStore.getState().text
  if (!isProjectSessionCurrent(projectSession)) return { warnings: [] }

  const results = await Promise.allSettled([
    useCharacterStore.getState().load(projectSession.projectPath, projectSession),
    useDraftStore.getState().loadAllDrafts(projectSession.projectPath, projectSession),
  ])
  if (!isProjectSessionCurrent(projectSession)) return { warnings: [] }
  const warnings: string[] = []
  const characterError = useCharacterStore.getState().lastError
  if (characterError) warnings.push(text(
    `角色卡读取失败：${characterError}`,
    `Could not load character cards. ${characterError}`,
  ))
  const loadWarning = (summary: AuthorNote, error: unknown) => failureText(currentInterfaceLocale(), { note: summary, because: reasonOf(error) })
  if (results[0].status === 'rejected' && !characterError) {
    warnings.push(loadWarning(note('角色卡读取失败', 'Could not load character cards.'), results[0].reason))
  }
  if (results[1].status === 'rejected') {
    warnings.push(loadWarning(note('草稿列表读取失败', 'Could not load the draft list.'), results[1].reason))
  }

  globalEventBus.emit('PROJECT_CHANGED', {
    projectPath: projectSession.projectPath,
    projectSession,
  })

  console.log('[ProjectService] 项目数据加载完成:', projectSession.projectPath)
  return { warnings }
}

export async function onProjectClosed(projectPath: string | null): Promise<void> {
  const { useEditorStore } = await import('../stores/editor-store')
  if (projectPath) {
    useEditorStore.getState().clearProjectTabs(projectPath)
  } else {
    useEditorStore.getState().clearTabs()
  }

  disableProjectBindingsPreservingDrafts(projectPath)

  console.log('[ProjectService] 项目已关闭，第二层状态仓库已重置')
}

export function disableProjectBindingsPreservingDrafts(projectPath: string | null): void {
  useCharacterStore.getState().reset()
  useDraftStore.getState().reset()

  console.log('[ProjectService] 已停用项目数据绑定并保留未保存草稿:', projectPath)
}

function syncFinalizedDraftTab(payload: EventPayloadMap['FINALIZE_COMPLETE']): void {
  const snapshot: FinalizationSnapshot = {
    tabId: payload.tabId,
    projectPath: payload.projectPath,
    projectSession: payload.projectSession,
    draftId: payload.draftId,
    chapterNumber: payload.chapterNumber,
    chapterTitle: payload.chapterTitle,
    content: payload.snapshotContent,
    contentRevision: payload.contentRevision,
  }
  const completion: FinalizationCompletion = {
    finalizationId: payload.finalizationId,
    contentHash: payload.contentHash,
    contentRevision: payload.contentRevision,
    draftId: payload.draftId,
    projectPath: payload.projectPath,
    projectSession: payload.projectSession,
    publicationStatus: payload.publicationStatus,
  }
  useEditorStore.setState(state => ({
    tabs: state.tabs.map(tab => reconcileFinalizationCompletion(tab, snapshot, completion)),
  }))
}

export function disposeProjectService(): void {
  for (const dispose of disposers) {
    dispose()
  }
  disposers = []
  console.log('[ProjectService] 已销毁')
}
