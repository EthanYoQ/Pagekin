import { app, ipcMain, dialog } from 'electron'
import { showOpenDialogInLastDirectory } from '../utils/remembered-dialog'
import fs from 'node:fs'
import path from 'node:path'
import { readJsonFile, writeJsonFile, RECENT_PROJECTS_PATH } from '../utils/config-utils'
import { removeDirectoryWithWindowsRetry } from '../utils/remove-directory'
import {
  ProjectData,
  type CreateProjectConfig,
  type ProjectSessionContext,
  type ProjectOpenTarget,
  type ProjectDirectoryGrant,
} from '../../src/shared/ipc-channels'
import { DIR_PROMPTS } from '../../src/shared/project-paths'
import { sameProjectPathKey } from '../../src/shared/project-session-context'
import {
  resolveWritingLanguage,
} from '../../src/shared/writing-language'
import {
  closeProjectDatabase,
  createProjectDatabase,
  getCurrentProjectPath,
  getProjectDb,
  initProjectDatabase,
} from '../database'
import { closeConnection as closeVectorConnection } from '../vector-store'
import { externalFileGrants } from '../services/external-file-grant-service'
import {
  ProjectCoreRepository,
  type ProjectCoreData,
} from '../repositories/project-core-repository'
import { projectAccess, ProjectSessionStaleError, type ProjectSessionLease } from '../services/project-access'
import { assertExpectedProjectPath, assertRequiredExpectedProjectPath } from '../utils/project-context'
import { sanitizeProjectName } from './project-path'
import { stopPortableExports } from '../services/portable-export-host'
import { projectStoragePreflightFailure } from '../services/project-storage-preflight'
import { verifyCanonicalProjectData } from '../services/project-data-locator'
import type { LedgerAdmission } from '../repositories/generation-ledger-admission'
import { projectPeekService } from '../services/project-peek'
import { probeProjectSqlite } from '../services/sqlite-project-migration'
import { mainText } from '../i18n'
import { isRegisteredErrorCode } from '../../src/i18n/app-errors'
import { adoptTransferredCharacterContinuityOnOpen } from '../services/transferred-character-continuity'
import { FinalizationRepository } from '../repositories/finalization-repository'
import type { FinalizationRepairOnOpen } from '../../src/shared/finalization-repair'
import { REPLACED_FINAL_CLEANUP_STEP_LABELS } from '../../src/shared/finalization-step-error'

function repairDuplicateFinalizationsOnOpen(): FinalizationRepairOnOpen {
  try {
    return { status: 'checked', ...FinalizationRepository.repairDuplicateFinalizations({
      remove_replaced_knowledge: text(...REPLACED_FINAL_CLEANUP_STEP_LABELS.remove_replaced_knowledge),
      remove_replaced_manuscripts: text(...REPLACED_FINAL_CLEANUP_STEP_LABELS.remove_replaced_manuscripts),
    }) }
  } catch (error) {
    console.error('[Project] 遗留重复定稿修复失败:', error)
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

/** 按作者保存的界面语言选文案；没保存过时按系统语言，与渲染层一致。 */
function text(zhCNText: string, enUSText: string): string {
  return mainText(app.getLocale(), zhCNText, enUSText)
}

/** 新建失败交给界面的码：登记过的码原样交出，其余系统报错按作者能做的事归成两类，原文只进日志。 */
function projectCreateFailure(error: unknown): string {
  if (isRegisteredErrorCode(error)) return String(error)
  console.error('[Project] 新建失败:', error)
  const code = systemCode(error)
  return code === 'EPERM' || code === 'EACCES' ? 'PROJECT_CREATE_ACCESS_DENIED' : 'PROJECT_CREATE_FAILED'
}

/**
 * 打开项目时被拒的原因都是错误码，渲染层按 app-errors.ts 登记的文案解释。
 * 旧版项目与「选了上级目录」两种还带 errorCode：渲染层据此分流到导入旧项目，或提示改选项目根。
 */
function projectRootSelectionFailure(error: unknown) {
  if (error instanceof Error && error.message === 'PROJECT_LEGACY_IMPORT_REQUIRED') {
    return { errorCode: 'PROJECT_LEGACY_IMPORT_REQUIRED' as const, error: error.message }
  }
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'PROJECT_ROOT_REQUIRED'
  ) {
    return { errorCode: 'PROJECT_ROOT_REQUIRED' as const, error: 'PROJECT_ROOT_REQUIRED' }
  }
  return null
}

/**
 * SQLite 3.53 的 Windows 实现截断不了别的进程还映射着的 project.db-shm，报 SQLITE_IOERR_TRUNCATE。
 * 强杀书童后旧进程先放开锁、过一会儿才拆映射，这段空档里打开就会撞上；失败的那次不改作品文件。
 */
const FILES_BUSY_RETRY_MS = 3_000

/** SQLite 的扩展码或 Node 文件系统的 errno 码（worker 里抛的也带回来了）。 */
function systemCode(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : undefined
}

const DELETE_FAILURE_CODES: Readonly<Record<string, string>> = {
  EBUSY: 'PROJECT_DELETE_FILES_BUSY',
  EPERM: 'PROJECT_DELETE_ACCESS_DENIED',
  EACCES: 'PROJECT_DELETE_ACCESS_DENIED',
}

const filesStillMapped = (error: unknown) => systemCode(error) === 'SQLITE_IOERR_TRUNCATE'

/** 按前缀从上往下认，扩展码要排在基础码前面。 */
const PROJECT_FILE_FAILURES = [
  ['SQLITE_IOERR_TRUNCATE', 'PROJECT_OPEN_FILES_BUSY'],
  ['SQLITE_IOERR', 'PROJECT_OPEN_IO_FAILED'],
  ['SQLITE_READONLY_', 'PROJECT_OPEN_ACCESS_DENIED'],
  ['SQLITE_READONLY', 'PROJECT_OPEN_FILES_LOCKED'],
  ['SQLITE_CORRUPT', 'PROJECT_OPEN_DAMAGED'],
  ['SQLITE_NOTADB', 'PROJECT_OPEN_DAMAGED'],
  ['EBUSY', 'PROJECT_OPEN_FILES_LOCKED'],
  ['EPERM', 'PROJECT_OPEN_ACCESS_DENIED'],
  ['EACCES', 'PROJECT_OPEN_ACCESS_DENIED'],
] as const

function projectFilesFailure(error: unknown) {
  const code = systemCode(error)
  const errorCode = code && PROJECT_FILE_FAILURES.find(([prefix]) => code.startsWith(prefix))?.[1]
  return errorCode ? { errorCode, error: errorCode } : null
}

export interface RecentProject {
  name: string
  path: string
  updatedAt: string
  projectId?: string
}

let latestProjectOpenRequestToken: string | null = null
let projectOpenQueue: Promise<void> = Promise.resolve()
const recentPreviewCapabilities = new Map<string, string>()

function revokeRecentPreviewCapabilities(projectPath?: string): void {
  for (const [capabilityId, capabilityPath] of recentPreviewCapabilities) {
    if (projectPath && !sameRecentProjectPath(capabilityPath, projectPath)) continue
    projectPeekService.revokeCapability(capabilityId)
    recentPreviewCapabilities.delete(capabilityId)
  }
}

function serializeProjectOpen<T>(operation: () => Promise<T>): Promise<T> {
  const result = projectOpenQueue.then(operation, operation)
  projectOpenQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function yieldToPendingOpenRequests(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 换库前等当前这本书的在途导出停完：worker 还在读它时关库，会读到半关的库。 */
async function stopExportsOfClosingProject(): Promise<void> {
  const closing = getCurrentProjectPath()
  if (closing) await stopPortableExports(closing)
}

interface ProjectDatabaseState {
  databaseRestored: boolean
  dbReady: boolean
  activeProjectPath: string | null
}

/**
 * A rollback boundary may only use authority observed and validated by the
 * main process before this create/open operation changes the database. The
 * renderer's remembered path is response metadata, never restoration input.
 */
interface TrustedProjectRollbackSnapshot {
  session: ProjectSessionLease
  rootPath: string
  databaseRoot: string
}

type ProjectRollbackBoundary =
  | { kind: 'trusted'; snapshot: TrustedProjectRollbackSnapshot }
  | { kind: 'neutral' }
  | { kind: 'untrusted' }

function sameProjectPath(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right
  return projectAccess.sameCanonicalProjectRoot(left, right)
}

// 最近项目是导航元数据，删除后目录可能已经不存在，不能只依赖 realpath。
// 用主进程 canonical root 优先，失败时退回与渲染端一致的 Windows 词法路径键。
function sameRecentProjectPath(left: string, right: string): boolean {
  return sameProjectPath(left, right) || sameProjectPathKey(left, right)
}

function creativeStrategyCoreUpdate(
  novelConfig: ProjectData['novelConfig'],
): Pick<Partial<ProjectCoreData>, 'creativeStrategy'> {
  return novelConfig.creativeStrategy
    ? { creativeStrategy: novelConfig.creativeStrategy }
    : {}
}

function narrativeThreadSettingsCoreUpdate(
  novelConfig: ProjectData['novelConfig'],
): Pick<Partial<ProjectCoreData>, 'narrativeThreadDormantChapterThreshold'> {
  return novelConfig.narrativeThreadDormantChapterThreshold === undefined
    ? {}
    : { narrativeThreadDormantChapterThreshold: novelConfig.narrativeThreadDormantChapterThreshold }
}

/** 项目配置读写必须显式携带当前会话租约，路径本身不是授权。 */
function assertRequiredProjectSession(
  projectId: string,
  data: Partial<ProjectData>,
  currentProjectPath: string | null,
  context: ProjectSessionContext | undefined,
): void {
  if (!context) {
    throw new Error('PROJECT_SESSION_REQUIRED')
  }
  if (
    !projectId
    || context.projectId !== projectId
    || (data.id && data.id !== projectId)
    || (data.sessionLease !== undefined && data.sessionLease !== context.leaseId)
  ) {
    throw new Error('PROJECT_SESSION_IDENTITY_MISMATCH')
  }
  const active = projectAccess.assertCurrentProjectContext(context, currentProjectPath)
  if (
    !sameProjectPath(active.rootPath, currentProjectPath)
    || (data.path !== undefined && !sameProjectPath(active.rootPath, data.path))
  ) {
    throw new ProjectSessionStaleError('PROJECT_SESSION_ROOT_MISMATCH')
  }
}

function databaseStateFor(expectedProjectPath: string | null): ProjectDatabaseState {
  const activeProjectPath = getCurrentProjectPath()
  const dbReady = getProjectDb() !== null
    && sameProjectPath(activeProjectPath, expectedProjectPath)
  return {
    databaseRestored: dbReady,
    dbReady,
    activeProjectPath,
  }
}

function failedDatabaseState(): ProjectDatabaseState {
  // 回滚快照缺失、过期或恢复失败时，不能留下指向半切换项目的数据库或租约。
  // close 先于 invalidate，避免后续 IPC 将旧租约误认为仍可写。
  try {
    closeProjectDatabase()
  } catch (closeError) {
    console.error('[Project] 关闭不可信项目数据库失败:', closeError)
  } finally {
    projectAccess.invalidateCurrentSession()
  }
  return {
    databaseRestored: false,
    dbReady: false,
    activeProjectPath: getCurrentProjectPath(),
  }
}

function neutralDatabaseState(): ProjectDatabaseState {
  const activeProjectPath = getCurrentProjectPath()
  const neutral = activeProjectPath === null
    && getProjectDb() === null
    && projectAccess.captureCurrentSession() === null
  return {
    databaseRestored: neutral,
    dbReady: neutral,
    activeProjectPath,
  }
}

function requireReadyDatabase(
  databaseState: ProjectDatabaseState,
  code: 'PROJECT_ROLLBACK_DATABASE_UNAVAILABLE' | 'PROJECT_OPEN_DATABASE_UNAVAILABLE',
): ProjectDatabaseState {
  if (!databaseState.databaseRestored || !databaseState.dbReady) {
    throw new Error(code)
  }
  return databaseState
}

function captureProjectRollbackBoundary(): ProjectRollbackBoundary {
  const databaseRoot = getCurrentProjectPath()
  const database = getProjectDb()
  const capturedSession = projectAccess.captureCurrentSession()
  if (!databaseRoot && !database && !capturedSession) return { kind: 'neutral' }
  if (!databaseRoot || !database || !capturedSession) return { kind: 'untrusted' }

  try {
    const activeSession = projectAccess.assertCurrentSession(capturedSession)
    if (
      !sameProjectPath(activeSession.rootPath, capturedSession.rootPath)
      || !sameProjectPath(activeSession.rootPath, databaseRoot)
    ) {
      return { kind: 'untrusted' }
    }

    return {
      kind: 'trusted',
      snapshot: Object.freeze({
        session: Object.freeze({ ...activeSession }),
        rootPath: activeSession.rootPath,
        databaseRoot,
      }),
    }
  } catch {
    return { kind: 'untrusted' }
  }
}

function restoreTrustedProjectDatabase(
  snapshot: TrustedProjectRollbackSnapshot,
): ProjectDatabaseState {
  // A matching path is not enough: reopening it creates a fresh lease. Check
  // the frozen lease before any filesystem/database side effect.
  const activeSession = projectAccess.assertCurrentSession(snapshot.session)
  if (
    !sameProjectPath(activeSession.rootPath, snapshot.rootPath)
    || !sameProjectPath(snapshot.databaseRoot, snapshot.rootPath)
  ) {
    throw new Error('PROJECT_ROLLBACK_SNAPSHOT_STALE')
  }

  initProjectDatabase(snapshot.rootPath)
  const restoredSession = projectAccess.assertCurrentProjectContext({
    projectId: snapshot.session.projectId,
    leaseId: snapshot.session.leaseId,
    projectPath: snapshot.rootPath,
  }, getCurrentProjectPath())
  if (!sameProjectPath(restoredSession.rootPath, snapshot.rootPath)) {
    throw new Error('PROJECT_ROLLBACK_ROOT_MISMATCH')
  }
  return databaseStateFor(snapshot.rootPath)
}

function databaseStateForRollbackBoundary(
  boundary: ProjectRollbackBoundary,
): ProjectDatabaseState {
  if (boundary.kind === 'trusted') return databaseStateFor(boundary.snapshot.rootPath)
  if (boundary.kind === 'neutral') return neutralDatabaseState()
  return failedDatabaseState()
}

function restoreProjectRollbackBoundary(
  boundary: ProjectRollbackBoundary,
): ProjectDatabaseState {
  if (boundary.kind === 'trusted') {
    return restoreTrustedProjectDatabase(boundary.snapshot)
  }
  if (boundary.kind === 'untrusted') {
    throw new Error('PROJECT_ROLLBACK_UNTRUSTED')
  }

  // 首次启动没有旧项目可恢复。创建只负责落盘，因此显式关闭刚创建的
  // 数据库并清空租约，保持 renderer 随后调用 project:open 前的中立态。
  closeProjectDatabase()
  projectAccess.invalidateCurrentSession()
  const databaseState = neutralDatabaseState()
  if (!databaseState.databaseRestored || !databaseState.dbReady) {
    throw new Error('PROJECT_ROLLBACK_NEUTRAL_FAILED')
  }
  return databaseState
}

function loadRecentProjects(): RecentProject[] {
  return readJsonFile<RecentProject[]>(RECENT_PROJECTS_PATH, [])
}

/** 最近项目导航元数据的唯一写入口。 */
export function registerRecentProject(project: RecentProject): void {
  const list = loadRecentProjects()
  const filtered = list.filter((p) => !sameRecentProjectPath(p.path, project.path))
  filtered.unshift(project)
  const trimmed = filtered.slice(0, 20)
  writeJsonFile(RECENT_PROJECTS_PATH, trimmed)
}

function removeRecentProject(projectPath: string) {
  const filtered = loadRecentProjects().filter((p) => !sameRecentProjectPath(p.path, projectPath))
  writeJsonFile(RECENT_PROJECTS_PATH, filtered)
}

export interface ProjectControllerOptions {
  /** Called only after the project directory is confirmed absent. */
  removeDeletedProjectBinding?(projectId: string): void
}

export function registerProjectController(options: ProjectControllerOptions = {}) {
  const issueDirectoryGrant = (event: Electron.IpcMainInvokeEvent, directoryPath: string,
    operation: 'project-create' | 'project-open' | 'legacy-import') => {
    const grant = externalFileGrants.issueDirectory({
      webContentsId: event.sender.id, directoryPath, operations: [operation], ttlMs: 10 * 60 * 1_000,
    })
    event.sender.once('destroyed', () => externalFileGrants.revokeWebContents(event.sender.id))
    return { grantId: grant.grantId, displayName: path.basename(directoryPath) }
  }
  ipcMain.handle('dialog:select-legacy-project', async (event) => {
    const result = await showOpenDialogInLastDirectory('legacy-project', {
      title: text('选择旧版小说项目文件夹', 'Choose the legacy novel project folder'),
      properties: ['openDirectory'],
    })
    return result.canceled || !result.filePaths[0] ? null
      : issueDirectoryGrant(event, result.filePaths[0], 'legacy-import')
  })

  ipcMain.handle('project:import-legacy-copy', async (
    event: { sender: { id: number } },
    sourceGrantId: string,
    targetGrantId: string,
  ) => {
    if (typeof sourceGrantId !== 'string' || typeof targetGrantId !== 'string') {
      return { state: 'blocked' as const, code: 'LEGACY_IMPORT_PATH_INVALID' }
    }
    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      buttons: [text('取消', 'Cancel'), text('开始导入', 'Start import')],
      defaultId: 0,
      cancelId: 0,
      message: text(
        '请先保存并关闭旧版程序，以及正在同步或编辑这个项目的程序。',
        'First save and close the legacy app and any program that is syncing or editing this project.',
      ),
      detail: text(
        '导入期间不要打开或修改旧项目。导入会建一份独立的新副本，旧项目保留，之后两份的修改不会同步。',
        'Do not open or change the legacy project during the import. The import creates an independent new copy; the legacy project is kept, and later changes to either do not sync.',
      ),
    })
    if (confirmation.response !== 1) return { state: 'cancelled' as const }
    // 副本位置只来自 dialog:select-project-restore-target 签发、绑定本窗口的一次性授权。
    let targetRoot: string
    let sourceRoot: string
    try {
      sourceRoot = externalFileGrants.resolveDirectoryPath({
        grantId: sourceGrantId, webContentsId: event.sender.id, operation: 'legacy-import',
      })
      targetRoot = externalFileGrants.resolveExactPath({
        grantId: targetGrantId,
        webContentsId: event.sender.id,
        operation: 'create',
      })
    } catch {
      return { state: 'blocked' as const, code: 'LEGACY_IMPORT_PATH_INVALID' }
    }
    let result: Awaited<ReturnType<typeof import('../services/legacy-project-copy-import').importLegacyProjectCopy>>
    try {
      const { importLegacyProjectCopy } = await import('../services/legacy-project-copy-import')
      result = await importLegacyProjectCopy({ sourceRoot, targetRoot })
    } catch {
      return { state: 'blocked' as const, code: 'LEGACY_IMPORT_IO_FAILED' }
    }
    if (result.state === 'ready') {
      try {
        registerRecentProject({ name: path.basename(sourceRoot), path: result.targetRoot, projectId: result.projectId, updatedAt: new Date().toISOString() })
      } catch {
        return { ...result, warning: 'LEGACY_IMPORT_RECENT_LIST_FAILED' }
      }
    }
    return result
  })

  ipcMain.handle('project:get-runtime-context', async () => {
    const activeProjectPath = getCurrentProjectPath()
    const database = getProjectDb()
    return {
      activeProjectPath,
      dbReady: activeProjectPath === null ? database === null : database !== null,
    }
  })

  ipcMain.handle('project:smoke-open-request', async () => {
    const projectPath = process.env.AI_NOVEL_SMOKE_OPEN_PROJECT?.trim()
    const markerPath = process.env.AI_NOVEL_SMOKE_PROJECT_MARKER?.trim()
    return projectPath && markerPath ? { projectPath, markerPath } : null
  })

  ipcMain.handle('project:smoke-open-confirm', async (_event, projectPath: string) => {
    try {
      const requestedProjectPath = process.env.AI_NOVEL_SMOKE_OPEN_PROJECT?.trim()
      const markerPath = process.env.AI_NOVEL_SMOKE_PROJECT_MARKER?.trim()
      const currentProjectPath = getCurrentProjectPath()
      if (
        !requestedProjectPath
        || !markerPath
        || !currentProjectPath
        || path.resolve(projectPath) !== path.resolve(requestedProjectPath)
        || path.resolve(currentProjectPath) !== path.resolve(requestedProjectPath)
      ) {
        // i18n-exempt: 只供打包烟测脚本确认项目已打开，不进界面
        return { success: false, error: '烟测项目未在应用中成功打开' }
      }
      fs.writeFileSync(markerPath, JSON.stringify({
        projectPath: path.resolve(currentProjectPath),
        openedAt: new Date().toISOString(),
      }), 'utf8')
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 创建新项目
  ipcMain.handle('project:create', async (
    event,
    config: CreateProjectConfig,
    requestToken: string,
  ) => {
    latestProjectOpenRequestToken = requestToken
    return serializeProjectOpen(async () => {
      await yieldToPendingOpenRequests()
      await stopExportsOfClosingProject()
      const isLatestRequest = () => latestProjectOpenRequestToken === requestToken
      const rollbackBoundary = captureProjectRollbackBoundary()
      if (!isLatestRequest()) {
        const databaseState = databaseStateForRollbackBoundary(rollbackBoundary)
        return {
          success: false,
          projectId: '',
          requestToken,
          stale: true,
          ...databaseState,
        }
      }

      try {
        const projectName = sanitizeProjectName(config.name)
        const parentPath = externalFileGrants.resolveDirectoryPath({
          grantId: config.parentGrantId, webContentsId: event.sender.id, operation: 'project-create',
        })
        const createdProject = projectAccess.createProject(parentPath, projectName)
        const projectId = createdProject.projectId
        const projectDir = createdProject.rootPath

        fs.mkdirSync(path.join(projectDir, DIR_PROMPTS), { recursive: true })
        createProjectDatabase(projectDir)
        initProjectDatabase(projectDir)
        ProjectCoreRepository.init(projectName, resolveWritingLanguage(config.writingLanguage))
        ProjectCoreRepository.update({
          genre: config.genre,
          targetAudience: config.targetAudience,
        })

        const updatedAt = new Date().toISOString()
        if (!isLatestRequest()) {
          let databaseState: ProjectDatabaseState
          try {
            databaseState = requireReadyDatabase(
              restoreProjectRollbackBoundary(rollbackBoundary),
              'PROJECT_ROLLBACK_DATABASE_UNAVAILABLE',
            )
          } catch (restoreError) {
            databaseState = failedDatabaseState()
            return {
              success: false,
              projectId: '',
              requestToken,
              stale: true,
              ...databaseState,
              error: String(restoreError),
            }
          }
          return {
            success: false,
            projectId: '',
            requestToken,
            stale: true,
            ...databaseState,
          }
        }

        registerRecentProject({
          name: projectName,
          path: projectDir,
          projectId,
          updatedAt,
        })
        // 创建只提交磁盘数据；渲染进程随后通过同一串行队列执行打开。
        // 在此之前恢复旧项目，避免主进程与仍显示旧项目的界面身份分裂。
        const databaseState = requireReadyDatabase(
          restoreProjectRollbackBoundary(rollbackBoundary),
          'PROJECT_ROLLBACK_DATABASE_UNAVAILABLE',
        )
        return {
          success: true,
          projectId,
          projectPath: projectDir,
          requestToken,
          ...databaseState,
        }
      } catch (error) {
        let databaseState: ProjectDatabaseState
        try {
          databaseState = requireReadyDatabase(
            restoreProjectRollbackBoundary(rollbackBoundary),
            'PROJECT_ROLLBACK_DATABASE_UNAVAILABLE',
          )
        } catch (restoreError) {
          console.error('[Project] 新建失败后没能回到原来的作品:', restoreError)
          databaseState = failedDatabaseState()
        }
        return {
          success: false,
          projectId: '',
          requestToken,
          ...databaseState,
          ...(projectStoragePreflightFailure(error) ?? {}),
          error: projectCreateFailure(error),
        }
      }
    })
  })

  // 打开现有项目
  ipcMain.handle('project:open', async (
    event,
    target: ProjectOpenTarget,
    requestToken: string,
  ) => {
    latestProjectOpenRequestToken = requestToken
    return serializeProjectOpen(async () => {
      // 让已经发出的后续打开请求先登记身份，避免旧请求抢先切换全局数据库。
      await yieldToPendingOpenRequests()
      const isLatestRequest = () => latestProjectOpenRequestToken === requestToken
      const rollbackBoundary = captureProjectRollbackBoundary()
      if (!isLatestRequest()) {
        const databaseState = databaseStateForRollbackBoundary(rollbackBoundary)
        return {
          success: false,
          project: null,
          requestToken,
          stale: true,
          ...databaseState,
        }
      }

      let legacyImportSource: ProjectDirectoryGrant | undefined
      let currentProjectClosed = false
      let openStep: 'resolve' | 'verify' | 'connect' | 'load' = 'resolve'
      try {
        const recent = typeof target === 'string'
          ? loadRecentProjects().find(project => project.path === target) : undefined
        const smokePath = process.env.AI_NOVEL_SMOKE_OPEN_PROJECT?.trim()
        // Persisted recent entries are main-owned project references, not arbitrary path authority.
        const projectPath = typeof target === 'string'
          ? recent?.path ?? (smokePath && target === smokePath ? smokePath : null)
          : externalFileGrants.resolveDirectoryPath({
            grantId: target?.grantId, webContentsId: event.sender.id, operation: 'project-open',
          })
        if (!projectPath) throw new Error('PROJECT_OPEN_GRANT_REQUIRED')
        const probedProject = projectAccess.probeExistingProject(projectPath)
        if (probedProject.kind === 'legacy' || probedProject.storageFormat === 'legacy') {
          if (recent?.projectId && (probedProject.kind !== 'manifest' || recent.projectId !== probedProject.projectId)) {
            throw new Error('PROJECT_OPEN_RECENT_IDENTITY_CHANGED')
          }
          if (fs.existsSync(path.join(probedProject.rootPath, '.ai-novel-migration'))) {
            throw new Error('PROJECT_MIGRATION_RECOVERY_REQUIRED')
          }
          const sqlite = probeProjectSqlite({ databasePath: path.join(probedProject.rootPath, '.vela', 'vela.db') })
          if (sqlite.schemaVersion !== 0) throw new Error('LEGACY_IMPORT_UNSUPPORTED_SOURCE')
          legacyImportSource = issueDirectoryGrant(event, probedProject.rootPath, 'legacy-import')
          throw new Error('PROJECT_LEGACY_IMPORT_REQUIRED')
        }
        const trustedProject = projectAccess.adoptLegacyProject(probedProject)
        const resolvedProjectPath = trustedProject.rootPath
        if (recent?.projectId && recent.projectId !== trustedProject.projectId) {
          throw new Error('PROJECT_OPEN_RECENT_IDENTITY_CHANGED')
        }
        const staleBeforeSwitch = () =>
          ({ success: false, project: null, requestToken, stale: true, ...databaseStateForRollbackBoundary(rollbackBoundary) })
        let admission: LedgerAdmission | undefined
        let busySince: number | undefined
        for (let attempt = 1; !admission; attempt++) {
          try {
            openStep = 'verify'
            // 重开当前这本时主进程正持有它，不另起 worker 校验（它已是当前版本）。
            const verified = sameProjectPath(getCurrentProjectPath(), resolvedProjectPath)
              ? undefined
              : await verifyCanonicalProjectData(resolvedProjectPath)
            if (!isLatestRequest()) return staleBeforeSwitch()
            // 校验期间旧书照常开着、可能又起了导出，所以紧挨换库再停。
            await stopExportsOfClosingProject()
            if (!isLatestRequest()) return staleBeforeSwitch()
            openStep = 'connect'
            currentProjectClosed = true
            admission = initProjectDatabase(resolvedProjectPath, verified)
          } catch (error) {
            busySince ??= Date.now()
            if (!filesStillMapped(error) || Date.now() - busySince >= FILES_BUSY_RETRY_MS) throw error
            // 等待期间别的请求要看到一本开着的书：先回到打开前的状态再等。
            if (currentProjectClosed) {
              requireReadyDatabase(restoreProjectRollbackBoundary(rollbackBoundary), 'PROJECT_ROLLBACK_DATABASE_UNAVAILABLE')
              currentProjectClosed = false
            }
            if (!isLatestRequest()) return staleBeforeSwitch()
            await new Promise(resolve => setTimeout(resolve, Math.min(25 * attempt, 200)))
            if (!isLatestRequest()) return staleBeforeSwitch()
          }
        }
        if (busySince !== undefined) console.warn('[Project] 作品文件暂时被占用，等它放开后打开', { waitedMs: Date.now() - busySince })
        openStep = 'load'
        const { sealedRootCount } = admission
        const openedDatabase = getProjectDb()
        if (openedDatabase) adoptTransferredCharacterContinuityOnOpen({ database: openedDatabase,
          projectRoot: resolvedProjectPath, projectId: trustedProject.projectId })

        // 从数据库读取配置
        const coreData = ProjectCoreRepository.get()
        if (!coreData) {
          // 如果是从空目录新建并打开，尝试初始化
          const folderName = path.basename(resolvedProjectPath)
          ProjectCoreRepository.init(folderName)
        }

        // 组装返回给前端的数据结构
        const updatedCoreData = ProjectCoreRepository.get()!
        const projectData: ProjectData = {
          id: trustedProject.projectId,
          name: updatedCoreData.projectName,
          path: resolvedProjectPath,
          novelConfig: {
            writingLanguage: updatedCoreData.writingLanguage,
            genre: updatedCoreData.genre,
            subGenre: updatedCoreData.subGenre,
            targetAudience: updatedCoreData.targetAudience,
            totalChapters: updatedCoreData.totalChapters,
            wordsPerChapter: updatedCoreData.wordsPerChapter,
            creativeStrategy: updatedCoreData.creativeStrategy,
            narrativeThreadDormantChapterThreshold: updatedCoreData.narrativeThreadDormantChapterThreshold,
            plotStructure: updatedCoreData.plotStructure as 'three_act' | 'heros_journey' | 'save_the_cat' | 'kishotenketsu' | 'multi_thread' | 'freeform',
            narrativePOV: updatedCoreData.narrativePov as 'third_limited' | 'first_person' | 'third_omniscient' | 'multi_pov',
            coreOutline: updatedCoreData.coreOutline,
            worldSetting: updatedCoreData.worldSetting,
            goldenFinger: updatedCoreData.goldenFinger,
            protagonistProfile: updatedCoreData.protagonistProfile,
            globalGuidance: updatedCoreData.globalGuidance,
            writingStyle: updatedCoreData.writingStyle,
            referenceWorks: updatedCoreData.referenceWorks,
          },
          aiSources: ProjectCoreRepository.getAiSources(),
          characterStates: updatedCoreData.characterStates,
          createdAt: new Date().toISOString(), // 数据库中实际上有，但这里先提供时间值避免前端报错
          updatedAt: new Date().toISOString(),
        }

        // 初始化与读取期间若同步触发了更新请求，旧事务必须恢复渲染进程仍展示的项目。
        // 此处不再主动让出事件循环，避免其他项目级进程通信观察到尚未提交的数据库连接。
        if (!isLatestRequest()) {
          let databaseState: ProjectDatabaseState
          try {
            databaseState = requireReadyDatabase(
              restoreProjectRollbackBoundary(rollbackBoundary),
              'PROJECT_ROLLBACK_DATABASE_UNAVAILABLE',
            )
          } catch (restoreError) {
            databaseState = failedDatabaseState()
            return {
              success: false,
              project: null,
              requestToken,
              stale: true,
              ...databaseState,
              error: String(restoreError),
            }
          }
          return {
            success: false,
            project: null,
            requestToken,
            stale: true,
            ...databaseState,
          }
        }

        registerRecentProject({
          name: projectData.name,
          path: resolvedProjectPath,
          updatedAt: projectData.updatedAt,
          projectId: trustedProject.projectId,
        })

        const databaseState = requireReadyDatabase(
          databaseStateFor(resolvedProjectPath),
          'PROJECT_OPEN_DATABASE_UNAVAILABLE',
        )
        const session = projectAccess.beginSession(trustedProject)
        projectData.sessionLease = session.leaseId
        revokeRecentPreviewCapabilities()
        const finalizationRepair = repairDuplicateFinalizationsOnOpen()
        return {
          success: true,
          project: projectData,
          requestToken,
          ...databaseState,
          finalizationRepair,
          sealedGenerationCount: sealedRootCount,
        }
      } catch (error) {
        let databaseState: ProjectDatabaseState
        try {
          databaseState = requireReadyDatabase(
            currentProjectClosed
              ? restoreProjectRollbackBoundary(rollbackBoundary)
              : databaseStateForRollbackBoundary(rollbackBoundary),
            'PROJECT_ROLLBACK_DATABASE_UNAVAILABLE',
          )
        } catch (restoreError) {
          console.error('[Project] 打开失败后没能回到原来的作品:', restoreError)
          databaseState = failedDatabaseState()
        }
        if (!legacyImportSource) console.error('[Project] 打开失败', { step: openStep, name: error instanceof Error ? error.name : typeof error, code: systemCode(error) })
        const selectionFailure = projectStoragePreflightFailure(error) ?? projectRootSelectionFailure(error) ?? projectFilesFailure(error)
        return {
          success: false,
          project: null,
          requestToken,
          ...databaseState,
          ...(selectionFailure ?? {}),
          ...(legacyImportSource ? { legacyImportSource } : {}),
          error: selectionFailure?.error ?? String(error),
        }
      }
    })
  })

  // 保存/更新项目配置
  // 注意：这个接口前端可能还传入许多小说配置字段，需要映射到数据库。
  ipcMain.handle('project:save', async (
    _event,
    _projectId: string,
    data: Partial<ProjectData>,
    expectedProjectPath?: string,
    context?: ProjectSessionContext,
  ) => {
    try {
      if (!data.path) return { success: false, error: 'PROJECT_CONTEXT_REQUIRED' }
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      assertExpectedProjectPath(data.path, expectedProjectPath)
      assertRequiredProjectSession(_projectId, data, getCurrentProjectPath(), context)

      const coreUpdate: Parameters<typeof ProjectCoreRepository.update>[0] = {}
      if (data.novelConfig) {
        if (data.novelConfig.writingLanguage !== undefined) {
          coreUpdate.writingLanguage = resolveWritingLanguage(data.novelConfig.writingLanguage)
        }
        Object.assign(coreUpdate, {
          genre: data.novelConfig.genre,
          subGenre: data.novelConfig.subGenre,
          targetAudience: data.novelConfig.targetAudience,
          totalChapters: data.novelConfig.totalChapters,
          wordsPerChapter: data.novelConfig.wordsPerChapter,
          ...creativeStrategyCoreUpdate(data.novelConfig),
          ...narrativeThreadSettingsCoreUpdate(data.novelConfig),
          plotStructure: data.novelConfig.plotStructure,
          narrativePov: data.novelConfig.narrativePOV,
          goldenFinger: data.novelConfig.goldenFinger,
          globalGuidance: data.novelConfig.globalGuidance,
          coreOutline: data.novelConfig.coreOutline,
          worldSetting: data.novelConfig.worldSetting,
          protagonistProfile: data.novelConfig.protagonistProfile,
          writingStyle: data.novelConfig.writingStyle ?? '',
          referenceWorks: data.novelConfig.referenceWorks ?? '',
        })
      }

      if (data.name) {
        coreUpdate.projectName = data.name
      }

      if (data.characterStates !== undefined) {
        coreUpdate.characterStates = data.characterStates
      }

      const db = getProjectDb()
      if (!db) throw new Error('PROJECT_NOT_OPEN')
      db.transaction(() => {
        ProjectCoreRepository.update(coreUpdate)
        if (data.aiSources) ProjectCoreRepository.setAiSources(data.aiSources)
      })()

      // 最近项目是导航便利数据，不属于项目核心提交。写入失败不能把已经
      // 已提交的数据库保存即使被误报为失败，也不能让渲染进程保留过期草稿。
      try {
        registerRecentProject({
          name: data.name ?? ProjectCoreRepository.get()?.projectName ?? 'Unknown',
          path: data.path,
          projectId: _projectId,
          updatedAt: new Date().toISOString(),
        })
        return { success: true, recentProjectUpdated: true }
      } catch (recentProjectError) {
        console.warn('[Project] 项目核心数据已保存，但最近项目列表更新失败:', recentProjectError)
        return {
          success: true,
          recentProjectUpdated: false,
          warning: 'PROJECT_RECENT_LIST_UPDATE_FAILED',
        }
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 项目配置更新遵循相同规则。
  ipcMain.handle('project:update-config', async (
    _event,
    _projectId: string,
    data: Partial<ProjectData>,
    expectedProjectPath?: string,
    context?: ProjectSessionContext,
  ) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      assertRequiredProjectSession(_projectId, data, getCurrentProjectPath(), context)
      if (data.novelConfig) {
        ProjectCoreRepository.update({
          genre: data.novelConfig.genre,
          subGenre: data.novelConfig.subGenre,
          targetAudience: data.novelConfig.targetAudience,
          totalChapters: data.novelConfig.totalChapters,
          wordsPerChapter: data.novelConfig.wordsPerChapter,
          ...creativeStrategyCoreUpdate(data.novelConfig),
          ...narrativeThreadSettingsCoreUpdate(data.novelConfig),
          plotStructure: data.novelConfig.plotStructure,
          narrativePov: data.novelConfig.narrativePOV,
          goldenFinger: data.novelConfig.goldenFinger,
          globalGuidance: data.novelConfig.globalGuidance,
          coreOutline: data.novelConfig.coreOutline,
          worldSetting: data.novelConfig.worldSetting,
          protagonistProfile: data.novelConfig.protagonistProfile,
          writingStyle: data.novelConfig.writingStyle ?? '',
          referenceWorks: data.novelConfig.referenceWorks ?? '',
        })
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('project:recent-list', async () => {
    revokeRecentPreviewCapabilities()
    return loadRecentProjects().map(project => {
      const capability = projectPeekService.issueCapability(project.path)
      if (!capability) return project
      recentPreviewCapabilities.set(capability.capabilityId, project.path)
      return {
        ...project,
        previewCapabilityId: capability.capabilityId,
        projectId: capability.projectId,
      }
    })
  })

  ipcMain.handle('project:peek-overview', async (_event, capabilityId: string) => {
    if (!recentPreviewCapabilities.has(capabilityId)) return { state: 'unavailable' as const }
    return projectPeekService.peek(capabilityId)
  })

  ipcMain.handle('project:overview-current', async (_event, context?: ProjectSessionContext) => {
    try {
      const active = projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath())
      const database = getProjectDb()
      if (!database) return { state: 'unavailable' as const }
      return projectPeekService.readCurrent(active.projectId, database)
    } catch {
      return { state: 'unavailable' as const }
    }
  })

  ipcMain.handle('project:recent-remove', async (_event, projectPath: string) => {
    try {
      removeRecentProject(projectPath)
      revokeRecentPreviewCapabilities(projectPath)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle(
    'project:delete',
    async (
      _event,
      projectPath: string,
      _legacyProjectId: string,
      _legacySessionLease: string,
      context?: ProjectSessionContext,
    ) => {
    let resolvedPath: string
    let deletedProjectId: string
    let deletedLeaseId: string
    let deletingCurrentProject = false
    let databaseClosed = false
    try {
      const activeSession = projectAccess.assertCurrentProjectContext(
        context,
        getCurrentProjectPath(),
      )
      deletedProjectId = activeSession.projectId
      deletedLeaseId = activeSession.leaseId
      resolvedPath = projectAccess.authorizeDeletion({
        projectId: activeSession.projectId,
        leaseId: activeSession.leaseId,
      }, projectPath)
      const currentProjectPath = getCurrentProjectPath()
      if (!sameProjectPath(currentProjectPath, resolvedPath)) {
        throw new ProjectSessionStaleError('PROJECT_SESSION_DATABASE_MISMATCH')
      }
      deletingCurrentProject = true

      if (deletingCurrentProject) {
        // 在途导出占着知识库闸门和源库句柄，先停掉再关库删目录；等待期间作品可能被切走、目录可能被换，停完按删除授权重新核对。
        await stopPortableExports(resolvedPath)
        projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath())
        const reauthorized = projectAccess.authorizeDeletion({
          projectId: activeSession.projectId,
          leaseId: activeSession.leaseId,
        }, projectPath)
        if (!sameProjectPath(getCurrentProjectPath(), resolvedPath) || !sameProjectPath(reauthorized, resolvedPath)) {
          throw new ProjectSessionStaleError('PROJECT_SESSION_DATABASE_MISMATCH')
        }
        closeVectorConnection(resolvedPath)
        closeProjectDatabase()
        databaseClosed = true
      }
    } catch (error) {
      return {
        success: false,
        directoryDeleted: false,
        databaseRestored: true,
        error: String(error),
      }
    }

    let deletionError: unknown
    try {
      await removeDirectoryWithWindowsRetry(resolvedPath)
    } catch (error) {
      deletionError = error
    }

    // 删除目录是不可逆提交点。rmSync 即使抛错也可能已经完成删除，
    // 因此必须以磁盘事实决定返回语义，而不是只看异常。
    const directoryDeleted = !fs.existsSync(resolvedPath)
    if (deletionError) console.error('[Project] 删除作品文件夹时出错:', deletionError)
    if (!directoryDeleted) {
      let databaseRestored = !deletingCurrentProject || !databaseClosed
      if (deletingCurrentProject && databaseClosed) {
        try {
          initProjectDatabase(resolvedPath)
          databaseRestored = true
        } catch (restoreError) {
          console.error('[Project] 删除没删完后没能重新打开作品:', restoreError)
          databaseRestored = false
        }
      }
      return { success: false, directoryDeleted: false, databaseRestored, error: DELETE_FAILURE_CODES[systemCode(deletionError) ?? ''] ?? 'PROJECT_DELETE_FAILED' }
    }

    let bindingCleanupWarning: string | undefined
    try {
      options.removeDeletedProjectBinding?.(deletedProjectId)
    } catch {
      bindingCleanupWarning = text(
        '项目目录已删除，但本机云备份绑定暂未清理',
        'The project folder was deleted, but its local cloud backup binding was not cleaned up yet',
      )
    }
    // 删目录时没占着打开队列，期间可能已经开了另一本书。
    if (projectAccess.captureCurrentSession()?.leaseId === deletedLeaseId) projectAccess.invalidateCurrentSession()
    try {
      removeRecentProject(resolvedPath)
      return {
        success: true,
        directoryDeleted: true,
        databaseRestored: false,
        ...(bindingCleanupWarning ? { warning: bindingCleanupWarning } : {}),
      }
    } catch (recentProjectError) {
      console.error('[Project] 作品已删除，但最近项目列表更新失败:', recentProjectError)
      return {
        success: true,
        directoryDeleted: true,
        databaseRestored: false,
        warning: [
          bindingCleanupWarning,
          text(
            '项目目录已删除，但最近项目列表更新失败',
            'The project folder was deleted, but the recent project list could not be updated',
          ),
        ].filter(Boolean).join(text('；', '; ')),
      }
    }
    },
  )

  ipcMain.handle('dialog:select-folder', async (event, purpose: 'project-create' | 'project-open') => {
    if (purpose !== 'project-create' && purpose !== 'project-open') throw new Error('PROJECT_DIRECTORY_GRANT_PURPOSE_INVALID')
    const result = await showOpenDialogInLastDirectory(purpose, {
      properties: ['openDirectory', 'createDirectory'],
      title: purpose === 'project-create'
        ? text('选择项目保存位置', 'Choose where to save the project')
        : text('选择项目目录', 'Choose the project folder'),
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return issueDirectoryGrant(event, result.filePaths[0], purpose)
  })
}
