import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import type {
  CreateProjectConfig,
  ProjectOpenTarget,
  ProjectDirectoryGrant,
  ProjectChannels,
  ProjectData,
  ProjectSessionContext,
  NovelConfig,
} from '../shared/ipc-channels'
import type { AiSources } from '../shared/novel-config-ai-sources'
import { LatestRequestGate } from '../shared/latest-request-gate'
import { alertError } from '../components/ui/AlertDialog'
import { showFinalizationRepairNotice } from '../components/finalization-repair-notice'
import { showLedgerSealedNotice } from '../components/ledger-sealed-notice'
import { confirm } from '../components/ui/Confirm'
import { pushToast } from '../components/ui/ToastStack'
import { appErrorMessage, displayedErrorMessage, englishWithReason, failureText, legacyImportFailureMessage, projectDeleteFailureMessage, projectOpenFailureMessage, resultFailure } from '../i18n/app-errors'
import { saveDirtyEditorChangesForExit, useEditorStore } from './editor-store'
import { countUnsavedEditorItemsForProject } from './editor-unsaved'
import { useLayoutStore } from './layout-store'
import { currentInterfaceLocale, useLocaleStore } from './locale-store'
import { requireIpcSuccess } from '../services/ipc-result'
import { specificWriteFailure } from '../services/specific-write-failure'
import {
  projectPathKey,
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
  setActiveProjectSessionContext,
} from '../shared/project-session-context'
import {
  CONFIG_DRAFT_TAB,
  discardProjectEditorDraft,
  getProjectEditorDraft,
  mergeObjectDraftWithRemote,
  parseProjectEditorDraftLedger,
  persistProjectEditorDraftLedger,
  rebaseProjectEditorDraft,
  recordProjectEditorEdit,
  settleProjectEditorSave,
} from './project-editor-draft-ledger'
import {
  captureProjectTransitionDraftSnapshot,
  discardProjectTransitionDrafts,
  hasProjectTransitionDrafts,
  isProjectTransitionDraftSnapshotCurrent,
  saveProjectTransitionDrafts,
  type ProjectTransitionDraftSnapshot,
} from '../services/project-transition'

let openProjectRequestSequence = 0
const recentProjectsReads = new LatestRequestGate()
let closeProjectInFlight: Promise<boolean> | null = null
let projectRecoveryInFlight: Promise<void> | null = null

type ProjectTransitionDecision = 'clean' | 'saved' | 'discard'
type PreparedProjectTransition = Readonly<{
  decision: ProjectTransitionDecision
  draftLedgers: Record<string, string>
  draftSnapshot: ProjectTransitionDraftSnapshot
  tabs: ReturnType<typeof useEditorStore.getState>['tabs']
}>

let createOpenTransitionAuthorization: {
  sourceProject: ProjectData
  targetPath: string
  prepared: PreparedProjectTransition
} | null = null

type LocalizedProjectCopy = Readonly<{
  zhCNText: string
  enUSText: string
}>

function projectText(zhCNText: string, enUSText: string): string {
  return useLocaleStore.getState().text(zhCNText, enUSText)
}

let pendingOpens = 0
let openingNoticeTimer: ReturnType<typeof setTimeout> | undefined
let closeOpeningNotice: (() => void) | undefined

async function withOpeningNotice<T>(opening: Promise<T>): Promise<T> {
  if (pendingOpens++ === 0) openingNoticeTimer = setTimeout(() => {
    closeOpeningNotice = pushToast({ tone: 'info', duration: 0, message: projectText(
      '正在打开作品…\n\n长篇要多等一会儿，第一次在新版打开会更久。',
      'Opening the book…\n\nLong books take a moment, longer the first time in this version.',
    ) })
  }, 500)
  try {
    return await opening
  } finally {
    if (--pendingOpens === 0) {
      clearTimeout(openingNoticeTimer)
      closeOpeningNotice?.()
      closeOpeningNotice = undefined
    }
  }
}

function importedCopyNotOpenedNotice(targetRoot: string): string {
  return projectText(`副本已建立，但未能自动打开。请用“打开作品”选择：${targetRoot}`, `The copy was created but could not be opened. Use “Open a book” to select: ${targetRoot}`)
}

function projectCopy(zhCNText: string, enUSText: string): LocalizedProjectCopy {
  return { zhCNText, enUSText }
}

type ProjectNotice = () => string

const OPEN_FAILED_TITLE = ['打开作品失败', 'Couldn’t open the book'] as const
const CREATE_FAILED_TITLE = ['新建作品失败', 'Couldn’t create the book'] as const
const DELETE_FAILED_TITLE = ['删除作品失败', 'Couldn’t delete the book'] as const

function projectNotice(zhCNText: string, enUSText: string): ProjectNotice {
  return () => projectText(zhCNText, enUSText)
}

function closedBookNotices(name: string | undefined): ProjectNotice[] {
  return name ? [projectNotice(`原来开着的《${name}》已关闭。`, `“${name}”, which was open, has been closed.`)] : []
}

function joinProjectNotices(separator: string, ...notices: ProjectNotice[]): ProjectNotice {
  return () => notices.map(notice => notice()).join(separator)
}

function projectError(
  error: unknown,
  fallbackZhCN = '发生未知错误。',
  fallbackEnUS = 'Something went wrong.',
): string {
  if (error === undefined || error === null || error === '') {
    return projectText(fallbackZhCN, fallbackEnUS)
  }
  return appErrorMessage(currentInterfaceLocale(), error)
}

function projectErrorNotice(error: unknown, fallbackZhCN: string, fallbackEnUS: string): ProjectNotice {
  return () => projectError(error, fallbackZhCN, fallbackEnUS)
}

function projectOperationCopy(operation: 'create' | 'open'): LocalizedProjectCopy {
  return operation === 'create'
    ? projectCopy('创建', 'create')
    : projectCopy('打开', 'open')
}

async function confirmAndCancelProjectWorkflows(
  projectPath: string,
  operation: 'create' | 'open' | 'close',
  shouldContinue: () => boolean = () => true,
): Promise<boolean> {
  const { useWorkflowStore } = await import('./workflow-store')
  const activeCount = useWorkflowStore.getState().activeRuns.filter(run => (
    sameProjectPathKey(run.projectPath, projectPath)
  )).length
  if (activeCount > 0) {
    const operationCopy = operation === 'create'
      ? projectCopy('新建项目', 'create a project')
      : operation === 'open'
        ? projectCopy('打开其他项目', 'open another project')
        : projectCopy('关闭项目', 'close the project')
    const approved = await confirm(
      projectText(
        `当前项目有 ${activeCount} 个创作任务。继续${operationCopy.zhCNText}将取消并等待这些任务停止。`,
        `This project has ${activeCount} active creative task${activeCount === 1 ? '' : 's'}. Continuing to ${operationCopy.enUSText} will cancel and wait for them to stop.`,
      ),
      {
        title: projectText('创作任务仍在运行', 'Creative tasks are still running'),
        confirmText: projectText('取消任务并继续', 'Cancel tasks and continue'),
        danger: true,
      },
    )
    if (!approved) return false
  }
  if (!shouldContinue()) return false
  await useWorkflowStore.getState().cancelProjectWorkflowsAndWait(projectPath)
  return shouldContinue()
}

function capturePreparedProjectTransition(
  project: ProjectData,
  decision: ProjectTransitionDecision,
): PreparedProjectTransition {
  const editor = useEditorStore.getState()
  return {
    decision,
    tabs: editor.tabs,
    draftLedgers: editor.draftLedgers,
    draftSnapshot: captureProjectTransitionDraftSnapshot(project.path),
  }
}

function isPreparedProjectTransitionCurrent(
  project: ProjectData,
  prepared: PreparedProjectTransition,
): boolean {
  const editor = useEditorStore.getState()
  return sameRendererProject(project, useProjectStore.getState().currentProject)
    && editor.tabs === prepared.tabs
    && editor.draftLedgers === prepared.draftLedgers
    && isProjectTransitionDraftSnapshotCurrent(project.path, prepared.draftSnapshot)
}

async function prepareProjectTransition(project: ProjectData): Promise<PreparedProjectTransition | null> {
  const editor = useEditorStore.getState()
  for (const content of Object.values(editor.draftLedgers)) {
    if (!content) continue
    try { JSON.parse(content) } catch {
      throw new Error(projectText('存在无法识别的未保存编辑内容，请先恢复该编辑器', 'An unsaved editor draft could not be read. Restore that editor before continuing.'))
    }
  }
  const hasEditorDrafts = countUnsavedEditorItemsForProject(
    editor.tabs,
    editor.draftLedgers,
    project.path,
  ) > 0
  if (!hasEditorDrafts && !hasProjectTransitionDrafts(project.path)) {
    return capturePreparedProjectTransition(project, 'clean')
  }

  const save = await confirm(
    projectText(
      '当前项目有未保存内容。保存后再继续切换吗？',
      'This project has unsaved changes. Save them before continuing?',
    ),
    {
      title: projectText('处理未保存内容', 'Handle unsaved changes'),
      confirmText: projectText('保存并继续', 'Save and continue'),
      cancelText: projectText('其他选项', 'Other options'),
    },
  )
  if (save) {
    await saveDirtyEditorChangesForExit(project.path, 'project')
    await saveProjectTransitionDrafts(project.path)
    return capturePreparedProjectTransition(project, 'saved')
  }

  const discard = await confirm(
    projectText(
      '只有项目切换成功后才会放弃这些修改。要继续吗？',
      'These changes will be discarded only after the project transition succeeds. Continue?',
    ),
    {
      title: projectText('放弃未保存内容', 'Discard unsaved changes'),
      confirmText: projectText('放弃并继续', 'Discard and continue'),
      cancelText: projectText('取消', 'Cancel'),
      danger: true,
    },
  )
  return discard ? capturePreparedProjectTransition(project, 'discard') : null
}

function readConfigDraftLedger() {
  return parseProjectEditorDraftLedger<NovelConfig>(
    useEditorStore.getState().draftLedgers[CONFIG_DRAFT_TAB.id],
  )
}

function persistConfigDraftLedger(ledger: ReturnType<typeof readConfigDraftLedger>) {
  persistProjectEditorDraftLedger(useEditorStore.getState(), CONFIG_DRAFT_TAB, ledger)
}

function toPlainProjectData(p: ProjectData): ProjectData {
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    sessionLease: p.sessionLease,
    novelConfig: p.novelConfig ? { ...p.novelConfig } : p.novelConfig,
    aiSources: p.aiSources,
    characterStates: p.characterStates,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[${label}] 超时 (${ms}ms)`))
    }, ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}
let _onProjectOpened: ((projectSession: ProjectSessionContext) => Promise<{ warnings: string[] }>) | null = null
let _onProjectOpening: ((projectSession: ProjectSessionContext) => void | Promise<void>) | null = null
let _onProjectClosed: ((projectPath: string | null) => Promise<void>) | null = null
let _disableProjectBindingsPreservingDrafts: ((projectPath: string | null) => void) | null = null
async function callProjectOpening(projectSession: ProjectSessionContext) {
  if (!_onProjectOpening) {
    const { onProjectOpening } = await import('../services/project-service')
    _onProjectOpening = onProjectOpening
  }
  await _onProjectOpening(projectSession)
}
async function callProjectOpened(projectSession: ProjectSessionContext) {
  if (!_onProjectOpened) {
    const { onProjectOpened } = await import('../services/project-service')
    _onProjectOpened = onProjectOpened
  }
  return _onProjectOpened(projectSession)
}
async function callProjectClosed(projectPath: string | null) {
  if (!_onProjectClosed) {
    const { onProjectClosed } = await import('../services/project-service')
    _onProjectClosed = onProjectClosed
  }
  await _onProjectClosed(projectPath)
}

async function callDisableProjectBindingsPreservingDrafts(projectPath: string | null) {
  if (!_disableProjectBindingsPreservingDrafts) {
    const { disableProjectBindingsPreservingDrafts } = await import('../services/project-service')
    _disableProjectBindingsPreservingDrafts = disableProjectBindingsPreservingDrafts
  }
  _disableProjectBindingsPreservingDrafts(projectPath)
}

async function detachProjectBindings(options: {
  projectPath: string | null
  detachRenderer: () => void
  message: ProjectNotice
  title: ProjectNotice
  shouldNotify?: () => boolean
}): Promise<void> {
  options.detachRenderer()
  const cleanup = callDisableProjectBindingsPreservingDrafts(options.projectPath).catch((cleanupError) => {
    console.error('[Project] 数据库失效后的界面清理失败:', cleanupError)
  })
  projectRecoveryInFlight = cleanup
  try {
    await cleanup
  } finally {
    if (projectRecoveryInFlight === cleanup) projectRecoveryInFlight = null
  }
  if (options.shouldNotify?.() === false) return
  const message = options.message()
  const title = options.title()
  alertError(
    `${message}\n${projectText(
      '未保存的编辑和草稿已保留；重新打开作品后可以继续处理。',
      'Unsaved edits and drafts were kept. Reopen the book to continue.',
    )}`,
    { title },
  )
}

function projectDatabaseMatchesRenderer(
  runtimeContext: ProjectChannels['project:get-runtime-context']['return'],
  rendererProjectPath: string | null,
): boolean {
  return (
    runtimeContext.dbReady
    && sameProjectPathKey(runtimeContext.activeProjectPath, rendererProjectPath)
  )
}

function sameRendererProject(
  left: ProjectData | null | undefined,
  right: ProjectData | null | undefined,
): boolean {
  if (!left || !right) return left === right
  const leftContext = projectSessionContextFromProject(left)
  const rightContext = projectSessionContextFromProject(right)
  return leftContext && rightContext
    ? sameProjectSessionContext(leftContext, rightContext)
    : sameProjectPathKey(left.path, right.path)
}

async function reconcileStaleProjectResponse(options: {
  getRendererProjectPath: () => string | null
  detachRenderer: () => void
  operation: 'create' | 'open'
}): Promise<boolean> {
  let runtimeContext: ProjectChannels['project:get-runtime-context']['return']
  const operation = projectOperationCopy(options.operation)
  try {
    runtimeContext = await ipc.invoke('project:get-runtime-context')
  } catch (error) {
    const rendererProjectPath = options.getRendererProjectPath()
    await detachProjectBindings({
      projectPath: rendererProjectPath,
      detachRenderer: options.detachRenderer,
      message: joinProjectNotices(
        '\n',
        projectNotice(
          `无法确认过期项目${operation.zhCNText}后的主进程数据库状态。`,
          `Could not verify the main-process database after an obsolete ${operation.enUSText} request.`,
        ),
        projectErrorNotice(error, '项目数据库状态未知。', 'The project database state is unknown.'),
      ),
      title: projectNotice(
        '无法确认项目数据库状态，已停用项目',
        'Could not verify project database state; the project was disabled',
      ),
    })
    return true
  }
  const rendererProjectPath = options.getRendererProjectPath()
  if (projectDatabaseMatchesRenderer(runtimeContext, rendererProjectPath)) return false
  await detachProjectBindings({
    projectPath: rendererProjectPath,
    detachRenderer: options.detachRenderer,
    message: projectNotice(
      `过期的项目${operation.zhCNText}结果表明主进程数据库与当前界面项目不一致。`,
      `The obsolete ${operation.enUSText} result indicates that the main-process database does not match the current project.`,
    ),
    title: projectNotice(
      '项目数据库状态不一致，已停用项目',
      'Project database state does not match; the project was disabled',
    ),
  })
  return true
}

interface ProjectState {
  currentProject: ProjectData | null
  recentProjects: ProjectChannels['project:recent-list']['return']
  recentProjectsLoaded: boolean
  loading: boolean
  legacyImportNotice: string
  legacyImportBusy: boolean
  projectSessionEpoch: number

  createProject: (config: CreateProjectConfig) => Promise<boolean>
  openProject: (target: ProjectOpenTarget) => Promise<boolean>
  importLegacyProject: (source?: ProjectDirectoryGrant) => Promise<boolean>
  saveProject: (expectedProjectSession?: ProjectSessionContext) => Promise<boolean>
  updateNovelConfig: (config: Partial<NovelConfig>, expectedProjectSession?: ProjectSessionContext) => void
  setAiSources: (sources: AiSources, expectedProjectSession: ProjectSessionContext) => void
  publishSavedNovelConfig: (saved: Partial<NovelConfig>, expectedProjectSession: ProjectSessionContext, keep: 'none' | 'unsaved-edits' | 'current') => void
  commitGeneratedNovelConfig: (config: Partial<NovelConfig>, expectedConfig: NovelConfig, expectedProjectSession: ProjectSessionContext,
    generationRunHandle: import('../services/generation/generation-runtime').MainGenerationRunHandle,
    persistEffect?: () => Promise<Partial<NovelConfig> | void>,
    aiSources?: AiSources) => Promise<boolean>
  discardNovelConfigDraft: (
    projectPath: string,
    expectedProjectSession: ProjectSessionContext,
  ) => void
  loadRecentProjects: () => Promise<void>
  removeRecentProject: (projectPath: string) => Promise<boolean>
  deleteProject: (projectPath: string) => Promise<boolean>
  closeProject: () => Promise<boolean>
  updateCharacterStates: (states: string) => Promise<void>
}

export const useProjectStore = create<ProjectState>()((set, get) => ({
  currentProject: null,
  recentProjects: [],
  recentProjectsLoaded: false,
  loading: false,
  legacyImportNotice: '',
  legacyImportBusy: false,
  projectSessionEpoch: 0,

  createProject: async (config) => {
    const requestSequence = ++openProjectRequestSequence
    const isLatestRequest = () => requestSequence === openProjectRequestSequence
    let preparedTransition: PreparedProjectTransition | null = null
    set({ loading: true })
    try {
      if (closeProjectInFlight) {
        const closed = await closeProjectInFlight
        if (!isLatestRequest() || !closed) return false
        set({ loading: true })
      }
      if (projectRecoveryInFlight) {
        await projectRecoveryInFlight
        if (!isLatestRequest()) return false
      }
      const rendererProject = get().currentProject
      const rendererProjectPath = rendererProject?.path ?? null
      if (rendererProject) {
        preparedTransition = await prepareProjectTransition(rendererProject)
        if (!preparedTransition || !isLatestRequest() || !isPreparedProjectTransitionCurrent(rendererProject, preparedTransition)) return false
        if (!await confirmAndCancelProjectWorkflows(
          rendererProject.path,
          'create',
          isLatestRequest,
        )) return false
        if (!isPreparedProjectTransitionCurrent(rendererProject, preparedTransition)) return false
      }
      if (
        !isLatestRequest()
        || !sameRendererProject(rendererProject, get().currentProject)
      ) return false
      const requestToken = `create-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const result = await ipc.invoke(
        'project:create',
        config,
        requestToken,
        rendererProjectPath,
      )
      if (
        !isLatestRequest()
        || result.stale
        || result.requestToken !== requestToken
      ) {
        await reconcileStaleProjectResponse({
          getRendererProjectPath: () => get().currentProject?.path ?? null,
          detachRenderer: () => set({ currentProject: null }),
          operation: 'create',
        })
        return false
      }
      if (result.databaseRestored === false || result.dbReady === false) {
        const unsafeProjectPath = get().currentProject?.path ?? rendererProjectPath
        await detachProjectBindings({
          projectPath: unsafeProjectPath,
          detachRenderer: () => set({ currentProject: null }),
          message: joinProjectNotices(
            '\n',
            () => failureText(currentInterfaceLocale(), resultFailure(result)),
            ...closedBookNotices(rendererProject?.name),
          ),
          title: projectNotice(...CREATE_FAILED_TITLE),
          shouldNotify: isLatestRequest,
        })
        return false
      }
      if (!result.success) {
        console.error('[Project] 创建失败:', result.error)
        alertError(
          failureText(currentInterfaceLocale(), resultFailure(result)),
          { title: projectText(...CREATE_FAILED_TITLE) },
        )
        return false
      }
      const projectDir = result.projectPath
      if (!projectDir) throw new Error(projectText('创建结果缺少项目路径', 'The created project did not report its folder.'))
      if (rendererProject && preparedTransition) {
        if (!isPreparedProjectTransitionCurrent(rendererProject, preparedTransition)) return false
        createOpenTransitionAuthorization = {
          sourceProject: rendererProject,
          targetPath: projectDir,
          prepared: preparedTransition,
        }
      }
      try {
        return await get().openProject(projectDir)
      } finally {
        if (createOpenTransitionAuthorization?.targetPath === projectDir) {
          createOpenTransitionAuthorization = null
        }
      }
    } catch (e) {
      if (!isLatestRequest()) return false
      console.error('[Project] createProject 异常:', e)
      alertError(
        projectError(e),
        { title: projectText('新建作品异常', 'Unexpected error while creating the book') },
      )
      return false
    } finally {
      if (isLatestRequest()) set({ loading: false })
    }
  },


  openProject: async (target) => {
    const projectPath = typeof target === 'string' ? target : ''
    if (useLayoutStore.getState().settingsOpen) {
      const { confirmLeaveSettings } = await import('../components/settings/unsaved-settings')
      if (await confirmLeaveSettings() !== 'left') return false
    }
    const requestSequence = ++openProjectRequestSequence
    const requestToken = `${Date.now()}-${requestSequence}-${Math.random().toString(36).slice(2)}`
    const isLatestRequest = () => requestSequence === openProjectRequestSequence
    const openFailureMessage = (result: { errorCode?: string, error?: string }) => {
      const failure = resultFailure(result)
      if (!failure) return projectError(failure)
      const title = get().recentProjects.find(project => sameProjectPathKey(project.path, projectPath))?.name
      return projectOpenFailureMessage(currentInterfaceLocale(), failure, title)
    }
    let rendererProject = get().currentProject
    let rendererProjectPath = rendererProject?.path ?? null
    let mainOpenWasAccepted = false
    let preparedTransition: PreparedProjectTransition | null = null
    set({ loading: true })
    try {
      if (closeProjectInFlight) {
        const closed = await closeProjectInFlight
        if (!isLatestRequest() || !closed) return false
        rendererProject = get().currentProject
        rendererProjectPath = rendererProject?.path ?? null
        set({ loading: true })
      }
      if (projectRecoveryInFlight) {
        await projectRecoveryInFlight
        if (!isLatestRequest()) return false
        rendererProject = get().currentProject
        rendererProjectPath = rendererProject?.path ?? null
      }
      const activeProjectPath = get().currentProject?.path
      if (activeProjectPath) {
        const authorization = createOpenTransitionAuthorization
        const authorized = Boolean(
          authorization
          && sameProjectPathKey(authorization.targetPath, projectPath)
          && sameRendererProject(authorization.sourceProject, rendererProject),
        )
        if (authorized) {
          preparedTransition = authorization!.prepared
          createOpenTransitionAuthorization = null
        } else {
          preparedTransition = rendererProject && await prepareProjectTransition(rendererProject)
          if (!preparedTransition) return false
          if (!await confirmAndCancelProjectWorkflows(activeProjectPath, 'open', isLatestRequest)) return false
        }
        if (
          !isLatestRequest()
          || !rendererProject
          || !preparedTransition
          || !isPreparedProjectTransitionCurrent(rendererProject, preparedTransition)
        ) return false
      }
      const result = await withOpeningNotice(ipc.invoke('project:open', target, requestToken, rendererProjectPath))
      if (!isLatestRequest() || result.stale || result.requestToken !== requestToken) {
        await reconcileStaleProjectResponse({
          getRendererProjectPath: () => get().currentProject?.path ?? null,
          detachRenderer: () => set({ currentProject: null }),
          operation: 'open',
        })
        return false
      }
      const activeProjectMismatch = Boolean(
        result.success
        && result.project
        && !sameProjectPathKey(result.activeProjectPath, result.project.path),
      )
      if (
        result.databaseRestored === false
        || result.dbReady === false
        || activeProjectMismatch
      ) {
        const unsafeProjectPath = get().currentProject?.path ?? rendererProjectPath
        await detachProjectBindings({
          projectPath: unsafeProjectPath,
          detachRenderer: () => set({ currentProject: null }),
          message: joinProjectNotices(
            '\n',
            resultFailure(result)
              ? () => openFailureMessage(result)
              : projectErrorNotice(
                undefined,
                '主进程项目数据库与打开结果不一致。',
                'The main-process project database does not match the open result.',
              ),
            ...closedBookNotices(rendererProject?.name),
          ),
          title: projectNotice(...OPEN_FAILED_TITLE),
          shouldNotify: isLatestRequest,
        })
        return false
      }
      if (
        result.success
        && result.project
        && rendererProject
        && preparedTransition
        && !isPreparedProjectTransitionCurrent(rendererProject, preparedTransition)
      ) {
        await detachProjectBindings({
          projectPath: rendererProjectPath,
          detachRenderer: () => set({ currentProject: null }),
          message: projectNotice(
            '项目打开期间检测到新的编辑。主进程已切换项目，当前界面已停用以避免使用旧会话继续写入。',
            'New edits were detected while the project was opening. The main process switched projects, so the editor was disabled to prevent writes through the old session.',
          ),
          title: projectNotice(
            '项目切换期间内容发生变化，已停用项目',
            'Project content changed during the transition; the project was disabled',
          ),
          shouldNotify: isLatestRequest,
        })
        return false
      }
      if (result.success && result.project) {
        mainOpenWasAccepted = true
        const openedProjectSession = projectSessionContextFromProject(result.project)
        if (!openedProjectSession) {
          throw new Error(projectText(
            '主进程未返回有效项目会话，已拒绝绑定项目数据。',
            'The main process did not return a valid project session, so project data was not bound.',
          ))
        }
        const draftLedger = readConfigDraftLedger()
        const restored = rebaseProjectEditorDraft(
          draftLedger,
          result.project.path,
          result.project.novelConfig,
          mergeObjectDraftWithRemote,
        )
        if (getProjectEditorDraft(draftLedger, result.project.path)) {
          persistConfigDraftLedger(restored.ledger)
        }
        await callProjectOpening(openedProjectSession)
        if (!isLatestRequest()) {
          await reconcileStaleProjectResponse({
            getRendererProjectPath: () => get().currentProject?.path ?? null,
            detachRenderer: () => set({ currentProject: null }),
            operation: 'open',
          })
          return false
        }
        if (!sameRendererProject(rendererProject, get().currentProject)) return false
        const { navigate } = await import('./navigation/navigation-intents')
        if (!isLatestRequest() || !sameRendererProject(rendererProject, get().currentProject)) return false
        if (rendererProjectPath) {
          if (preparedTransition?.decision === 'discard') {
            discardProjectTransitionDrafts(rendererProjectPath)
          }
          useEditorStore.getState().clearProjectTabs(rendererProjectPath)
        }
        set((state) => ({
          currentProject: { ...result.project!, novelConfig: preparedTransition?.decision === 'discard'
            && rendererProjectPath && sameProjectPathKey(rendererProjectPath, result.project!.path)
            ? result.project!.novelConfig : restored.value },
          projectSessionEpoch: state.projectSessionEpoch + 1,
        }))
        navigate({ kind: 'stage' })
        const partialLoadWarnings: string[] = []
        try {
          await get().loadRecentProjects()
        } catch (recentError) {
          set({ recentProjects: [] })
          partialLoadWarnings.push(String(recentError))
        }
        if (!isLatestRequest()) return false
        let layer2Warnings: string[] = []
        try {
          const layer2Result = await callProjectOpened(openedProjectSession)
          layer2Warnings = layer2Result?.warnings ?? []
        } catch (layer2Error) {
          console.error('[Project] 项目资源初始化失败:', layer2Error)
          layer2Warnings = [String(layer2Error)]
        }
        if (!isLatestRequest()) return false
        const warnings = [...partialLoadWarnings, ...layer2Warnings]
          .map(warning => projectError(warning))
        const repair = result.finalizationRepair
        if (repair?.status === 'failed') {
          const failure = resultFailure({ error: repair.error })
          const reason = failure ? failureText(currentInterfaceLocale(), failure) : ''
          warnings.push(projectText(
            `重复的定稿没能修复，后面的章节可能写不了；下次打开项目会再试一次。${reason && `原因：${reason}`}`,
            englishWithReason(currentInterfaceLocale(), 'Duplicate final versions could not be repaired, so later chapters may stay blocked. Opening the project again will retry.', reason),
          ))
        }
        const leftThisProject = new AbortController()
        const abortIfLeft = () => {
          if (!sameProjectSessionContext(openedProjectSession, projectSessionContextFromProject(get().currentProject))) {
            leftThisProject.abort()
          }
        }
        abortIfLeft()
        const stopWatching = useProjectStore.subscribe(abortIfLeft)
        const { signal } = leftThisProject
        void (async () => {
          try {
            if (warnings.length > 0) {
              await alertError(warnings.join('\n'), {
                title: projectText('项目已打开，部分数据加载失败', 'Project opened with some data unavailable'),
                signal,
              })
            }
            if (repair?.status === 'checked') await showFinalizationRepairNotice(repair, signal)
            await showLedgerSealedNotice(result.sealedGenerationCount, signal)
          } finally {
            stopWatching()
          }
        })()
        return true
      }
      if (!isLatestRequest()) return false
      if (result.errorCode === 'PROJECT_LEGACY_IMPORT_REQUIRED' && result.legacyImportSource) {
        const approved = await confirm(
          projectText(
            '这是旧版项目。继续操作将创建独立的新版副本，旧项目会保留。两份项目的后续修改不会自动同步。',
            'This is a legacy project. Continue by creating an independent copy for this version. The original is kept, and future changes do not sync between the two projects.',
          ),
          {
            title: projectText('导入旧项目', 'Import legacy project'),
            confirmText: projectText('创建新版副本', 'Create new copy'),
          },
        )
        if (!approved || !isLatestRequest()) return false
        return await get().importLegacyProject(result.legacyImportSource)
      }
      console.error('[Project] 打开失败:', result.error)
      alertError(
        openFailureMessage(result),
        { title: projectText(...OPEN_FAILED_TITLE) },
      )
      return false
    } catch (e) {
      if (mainOpenWasAccepted) {
        const detached = await reconcileStaleProjectResponse({
          getRendererProjectPath: () => get().currentProject?.path ?? null,
          detachRenderer: () => set({ currentProject: null }),
          operation: 'open',
        })
        if (detached) return false
      }
      if (!isLatestRequest()) return false
      console.error('[Project] IPC 通信异常:', e)
      if (!isLatestRequest()) return false
      alertError(
        projectError(e),
        { title: projectText('打开作品异常', 'Unexpected error while opening the book') },
      )
      return false
    } finally {
      if (isLatestRequest()) set({ loading: false })
    }
  },

  importLegacyProject: async (source) => {
    if (get().legacyImportBusy) return false
    const requestSequence = openProjectRequestSequence
    const isCurrent = () => requestSequence === openProjectRequestSequence
    set({ legacyImportNotice: '', legacyImportBusy: true })
    let copiedTo: string | undefined
    try {
      const sourceRoot = source ?? await ipc.invoke('dialog:select-legacy-project')
      if (!sourceRoot || !isCurrent()) return false
      const sourceName = sourceRoot.displayName || projectText('旧项目', 'Legacy project')
      const target = await ipc.invoke('dialog:select-project-restore-target', `${sourceName}-${projectText('新版副本', 'new copy')}`)
      if (!target || !isCurrent()) return false
      const result = await ipc.invoke('project:import-legacy-copy', sourceRoot.grantId, target.grantId)
      if (result.state === 'cancelled') return false
      if (result.state === 'blocked') {
        set({ legacyImportNotice: legacyImportFailureMessage(currentInterfaceLocale(), result.code) })
        return false
      }
      copiedTo = result.targetRoot
      const { confirmLeaveSettings } = await import('../components/settings/unsaved-settings')
      const leave = isCurrent() ? await confirmLeaveSettings() : 'left'
      const opened = leave === 'left' && isCurrent() && await get().openProject(result.targetRoot).catch(() => false)
      set({ legacyImportNotice: opened
        ? projectText('旧项目已导入为独立副本。两份项目的后续修改不会自动同步。', 'Legacy project imported as an independent copy. Future changes do not sync between the two projects.')
        : leave === 'stayed'
          ? projectText(`副本已建立。你选了继续编辑设置，所以没有自动打开；之后可用“打开作品”选择：${result.targetRoot}`, `The copy was created. You chose to keep editing settings, so it was not opened. Use “Open a book” to select it later: ${result.targetRoot}`)
          : leave === 'busy'
            ? projectText(`副本已建立。另一个「放弃未保存的修改？」确认还开着，所以没有自动打开；之后可用“打开作品”选择：${result.targetRoot}`, `The copy was created. Another “Discard unsaved changes?” confirmation was still open, so it was not opened. Use “Open a book” to select it later: ${result.targetRoot}`)
            : importedCopyNotOpenedNotice(result.targetRoot) })
      return opened
    } catch (error) {
      set({ legacyImportNotice: copiedTo ? importedCopyNotOpenedNotice(copiedTo) : legacyImportFailureMessage(currentInterfaceLocale(), error) })
      return false
    } finally {
      set({ legacyImportBusy: false })
    }
  },

  saveProject: async (expectedProjectSession) => {
    const project = get().currentProject
    console.log('[project-store.saveProject] 开始保存，项目ID:', project?.id)
    if (!project) {
      console.log('[project-store.saveProject] 项目为空，跳过保存')
      return false
    }
    const projectSession = projectSessionContextFromProject(project)
    if (!projectSession) {
      console.error('[project-store.saveProject] 缺少项目会话，拒绝保存')
      return false
    }
    if (
      expectedProjectSession
      && !sameProjectSessionContext(expectedProjectSession, projectSession)
    ) {
      console.warn('[project-store.saveProject] 项目会话已变化，拒绝保存')
      return false
    }
    try {
      const plainData = toPlainProjectData(project)
      console.log('[project-store.saveProject] 准备调用 IPC，数据大小:', JSON.stringify(plainData).length)
      const result = await withTimeout(
        ipc.invokeWithProjectSession(
          projectSession,
          'project:save',
          plainData.id,
          plainData,
          project.path,
        ),
        15_000,
        'project:save',
      )
      console.log('[project-store.saveProject] IPC 调用完成，结果:', result)
      if (!result.success) return false
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(get().currentProject),
      )) return false
      const ledger = readConfigDraftLedger()
      const currentValue = get().currentProject?.novelConfig
      persistConfigDraftLedger(settleProjectEditorSave(
        ledger,
        project.path,
        plainData.novelConfig,
        currentValue ?? plainData.novelConfig,
      ))
      return true
    } catch (err) {
      console.error('[project-store.saveProject] 保存失败:', err)
      return false
    }
  },

  commitGeneratedNovelConfig: async (generated, expectedConfig, expectedProjectSession, generationRunHandle, persistEffect, aiSources) => {
    const project = get().currentProject
    if (!project || !sameProjectSessionContext(expectedProjectSession, projectSessionContextFromProject(project))
      || JSON.stringify(project.novelConfig) !== JSON.stringify(expectedConfig)) throw new Error('GENERATION_AUTHOR_DRAFT_CHANGED')
    const { narrativePOV, ...coreFields } = generated
    const data = { ...coreFields, ...(narrativePOV !== undefined ? { narrativePov: narrativePOV } : {}) }
    let config = generated
    if (persistEffect) config = (await persistEffect()) ?? generated
    else {
      const result = await ipc.invokeWithProjectSession(expectedProjectSession, 'db:project-core-commit-generated',
        { data, aiSources, generationRunHandle }, project.path)
      if (!result.success) throw new Error(specificWriteFailure(result)?.code ?? 'GENERATION_FORMAL_COMMIT_FAILED')
    }
    const current = get().currentProject
    if (!current || !sameProjectSessionContext(expectedProjectSession, projectSessionContextFromProject(current))) return false
    const ledger = readConfigDraftLedger()
    const saved = { ...(getProjectEditorDraft(ledger, project.path)?.baseValue ?? expectedConfig), ...config }
    const unchanged = JSON.stringify(current.novelConfig) === JSON.stringify(expectedConfig)
    const next = unchanged ? { ...expectedConfig, ...config } : { ...current.novelConfig }
    if (!unchanged) {
      for (const key of Object.keys(config) as (keyof NovelConfig)[]) {
        if (JSON.stringify(current.novelConfig[key]) === JSON.stringify(expectedConfig[key])) Object.assign(next, { [key]: saved[key] })
      }
    }
    set({ currentProject: { ...current, novelConfig: next, ...(aiSources ? { aiSources } : {}) } })
    persistConfigDraftLedger(settleProjectEditorSave(ledger, project.path, saved, next))
    if (!unchanged) throw new Error('GENERATION_SAVED_WITH_NEWER_AUTHOR_DRAFT')
    return true
  },

  publishSavedNovelConfig: (saved, expectedProjectSession, keep) => {
    const project = get().currentProject
    if (!project || !sameProjectSessionContext(expectedProjectSession, projectSessionContextFromProject(project))) return
    const ledger = readConfigDraftLedger()
    const base = getProjectEditorDraft(ledger, project.path)?.baseValue ?? project.novelConfig
    const next = { ...project.novelConfig }
    for (const key of Object.keys(saved) as (keyof NovelConfig)[]) {
      const edited = JSON.stringify(project.novelConfig[key]) !== JSON.stringify(base[key])
      if (keep === 'none' || (keep === 'unsaved-edits' && !edited)) Object.assign(next, { [key]: saved[key] })
    }
    set({ currentProject: { ...project, novelConfig: next } })
    persistConfigDraftLedger(settleProjectEditorSave(ledger, project.path, { ...base, ...saved }, next))
  },

  updateNovelConfig: (config, expectedProjectSession) => {
    const project = get().currentProject
    if (!project) return
    if (
      expectedProjectSession
      && !sameProjectSessionContext(
        expectedProjectSession,
        projectSessionContextFromProject(project),
      )
    ) return
    const nextConfig = { ...project.novelConfig, ...config }
    set({
      currentProject: {
        ...project,
        novelConfig: nextConfig,
      },
    })
    persistConfigDraftLedger(recordProjectEditorEdit(
      readConfigDraftLedger(),
      project.path,
      project.novelConfig,
      nextConfig,
    ))
  },

  setAiSources: (aiSources, expectedProjectSession) => {
    const project = get().currentProject
    if (!project || !sameProjectSessionContext(expectedProjectSession, projectSessionContextFromProject(project))) return
    set({ currentProject: { ...project, aiSources } })
  },

  discardNovelConfigDraft: (projectPath, expectedProjectSession) => {
    if (
      !sameProjectPathKey(expectedProjectSession.projectPath, projectPath)
      || !sameProjectSessionContext(
        expectedProjectSession,
        projectSessionContextFromProject(get().currentProject),
      )
    ) return
    const ledger = readConfigDraftLedger()
    const projectDraft = getProjectEditorDraft(ledger, projectPath)
    if (!projectDraft) return
    if (sameProjectSessionContext(
      expectedProjectSession,
      projectSessionContextFromProject(get().currentProject),
    )) {
      set((state) => ({
        currentProject: state.currentProject
          ? { ...state.currentProject, novelConfig: projectDraft.baseValue }
          : null,
      }))
    }
    persistConfigDraftLedger(discardProjectEditorDraft(ledger, projectPath))
  },

  loadRecentProjects: async () => {
    const requestId = recentProjectsReads.begin()
    let list: ProjectChannels['project:recent-list']['return']
    try {
      list = await ipc.invoke('project:recent-list')
    } catch (error) {
      if (recentProjectsReads.isLatest(requestId)) set({ recentProjectsLoaded: true })
      throw error
    }
    if (!recentProjectsReads.isLatest(requestId)) return
    const seenProjectPaths = new Set<string>()
    const recentProjects = list.filter((project) => {
      const key = projectPathKey(project.path) ?? project.path
      if (seenProjectPaths.has(key)) return false
      seenProjectPaths.add(key)
      return true
    })
    set({ recentProjects, recentProjectsLoaded: true })
  },

  removeRecentProject: async (projectPath) => {
    try {
      const result = await ipc.invoke('project:recent-remove', projectPath)
      if (!result.success) {
        alertError(
          failureText(currentInterfaceLocale(), resultFailure(result)),
          { title: projectText('移除最近项目失败', 'Failed to remove recent project') },
        )
        return false
      }
      set(state => ({
        recentProjects: state.recentProjects.filter(project => (
          !sameProjectPathKey(project.path, projectPath)
        )),
      }))
      return true
    } catch (error) {
      alertError(
        projectError(error),
        { title: projectText('移除最近项目异常', 'Unexpected recent-project removal error') },
      )
      return false
    }
  },

  deleteProject: async (projectPath) => {
    const activeProject = get().currentProject
    const projectSession = projectSessionContextFromProject(activeProject)
    if (
      !activeProject
      || !sameProjectPathKey(activeProject.path, projectPath)
      || !projectSession
    ) {
      alertError(
        projectText('只能删除当前已验证项目；请先打开目标项目。', 'Only the currently verified project can be deleted. Open the target project first.'),
        { title: projectText(...DELETE_FAILED_TITLE) },
      )
      return false
    }
    set({ loading: true })
    try {
      const { useWorkflowStore } = await import('./workflow-store')
      await useWorkflowStore.getState().cancelProjectWorkflowsAndWait(activeProject.path)
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(get().currentProject),
      )) return false
      const result = await ipc.invokeWithProjectSession(
        projectSession,
        'project:delete',
        projectPath,
        activeProject.id,
        projectSession.leaseId,
      )
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(get().currentProject),
      )) return false
      if (!result.success) {
        if (
          result.databaseRestored === false
          && sameProjectSessionContext(
            projectSession,
            projectSessionContextFromProject(get().currentProject),
          )
        ) {
          set({ currentProject: null })
          try {
            await callProjectClosed(projectPath)
          } catch (cleanupError) {
            console.error('[project-store.deleteProject] 数据库恢复失败后的界面清理失败:', cleanupError)
          }
          alertError(
            projectDeleteFailureMessage(currentInterfaceLocale(), resultFailure(result), activeProject.name),
            { title: projectText(...DELETE_FAILED_TITLE) },
          )
          return false
        }
        alertError(
          projectDeleteFailureMessage(currentInterfaceLocale(), resultFailure(result)),
          { title: projectText(...DELETE_FAILED_TITLE) },
        )
        return false
      }
      if (result.warning) {
        alertError(
          displayedErrorMessage(currentInterfaceLocale(), result.warning),
          { title: projectText('项目已删除，部分清理未完成', 'Project deleted with some cleanup incomplete') },
        )
      }

      const currentProject = get().currentProject
      if (sameProjectSessionContext(projectSession, projectSessionContextFromProject(currentProject))) {
        set({ currentProject: null })
        try {
          await callProjectClosed(projectPath)
        } catch (cleanupError) {
          console.error('[project-store.deleteProject] 项目已删除，但界面清理失败:', cleanupError)
          alertError(
            projectError(cleanupError),
            { title: projectText('项目已删除，界面清理未完成', 'Project deleted with editor cleanup incomplete') },
          )
        }
      }

      try {
        await get().loadRecentProjects()
      } catch (recentProjectError) {
        console.error('[project-store.deleteProject] 项目已删除，但刷新最近项目失败:', recentProjectError)
        alertError(
          projectError(recentProjectError),
            { title: projectText('项目已删除，最近项目列表刷新失败', 'Project deleted with recent-project refresh failed') },
        )
      }
      return true
    } catch (e) {
      alertError(
        projectError(e),
        { title: projectText('删除作品异常', 'Unexpected error while deleting the book') },
      )
      return false
    } finally {
      const currentSession = projectSessionContextFromProject(get().currentProject)
      if (!currentSession || sameProjectSessionContext(projectSession, currentSession)) {
        set({ loading: false })
      }
    }
  },

  closeProject: async () => {
    if (closeProjectInFlight) return closeProjectInFlight
    if (get().loading) {
      alertError(
        projectText('项目正在切换，请稍后再关闭。', 'The project is switching. Try closing it again shortly.'),
        { title: projectText('暂时无法关闭项目', 'Cannot close project yet') },
      )
      return false
    }
    const project = get().currentProject
    const projectPath = project?.path
    if (!projectPath) return true
    const projectSession = projectSessionContextFromProject(project)
    if (!projectSession) {
      alertError(
        projectText(
          '当前项目缺少有效会话，已拒绝关闭数据库。',
          'The current project has no valid session, so its database was not closed.',
        ),
        { title: projectText('关闭项目失败', 'Failed to close project') },
      )
      return false
    }

    const closeOperation = (async () => {
      set({ loading: true })
      try {
        const preparedTransition = await prepareProjectTransition(project)
        if (!preparedTransition || !isPreparedProjectTransitionCurrent(project, preparedTransition)) return false
        if (!await confirmAndCancelProjectWorkflows(projectPath, 'close')) return false
        if (!isPreparedProjectTransitionCurrent(project, preparedTransition)) {
          throw new Error(projectText(
            '项目上下文已变化，关闭操作已取消。',
            'The project context changed, so the close operation was cancelled.',
          ))
        }
        const result = await ipc.invokeWithProjectSession(projectSession, 'db:close', projectPath)
        requireIpcSuccess(result, '关闭项目数据库')
        if (!isPreparedProjectTransitionCurrent(project, preparedTransition)) {
          await detachProjectBindings({
            projectPath,
            detachRenderer: () => set({ currentProject: null }),
            message: projectNotice(
              '项目数据库关闭期间检测到新的编辑。数据库已关闭，当前界面已停用。',
              'New edits were detected while the project database was closing. The database is closed, so the editor was disabled.',
            ),
            title: projectNotice(
              '项目关闭期间内容发生变化，已停用项目',
              'Project content changed during close; the project was disabled',
            ),
          })
          return false
        }
        if (!sameProjectSessionContext(
          projectSession,
          projectSessionContextFromProject(get().currentProject),
        )) return false
        if (preparedTransition.decision === 'discard') discardProjectTransitionDrafts(projectPath)
        set({ currentProject: null })
        try {
          await callProjectClosed(projectPath)
        } catch (cleanupError) {
          console.error('[project-store.closeProject] 项目已关闭，但界面清理失败:', cleanupError)
          alertError(
            projectError(cleanupError),
            { title: projectText('项目已关闭，界面清理未完成', 'Project closed with editor cleanup incomplete') },
          )
        }
        return true
      } catch (error) {
        console.error('[project-store.closeProject] 关闭失败:', error)
        alertError(
          projectError(error),
          { title: projectText('关闭项目失败', 'Failed to close project') },
        )
        return false
      } finally {
        const currentSession = projectSessionContextFromProject(get().currentProject)
        if (!currentSession || sameProjectSessionContext(projectSession, currentSession)) {
          set({ loading: false })
        }
      }
    })()
    closeProjectInFlight = closeOperation
    try {
      return await closeOperation
    } finally {
      if (closeProjectInFlight === closeOperation) closeProjectInFlight = null
    }
  },

  updateCharacterStates: async (states) => {
    const project = get().currentProject
    if (!project) return
    const projectSession = projectSessionContextFromProject(project)
    if (!projectSession) return
    const updated = { ...project, characterStates: states }
    try {
      const result = await withTimeout(
        ipc.invokeWithProjectSession(
          projectSession,
          'project:save',
          project.id,
          toPlainProjectData(updated),
          project.path,
        ),
        15_000,
        'project:save(characterStates)',
      )
      requireIpcSuccess(result, '保存角色状态')
      if (sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(get().currentProject),
      )) {
        set({ currentProject: updated })
      }
    } catch (err) {
      console.error('[project-store.updateCharacterStates] 持久化失败:', err)
      alertError(
        projectError(err),
        { title: projectText('保存角色状态失败', 'Failed to save character states') },
      )
    }
  },
}))

useProjectStore.subscribe((state) => {
  setActiveProjectSessionContext(projectSessionContextFromProject(state.currentProject))
})
