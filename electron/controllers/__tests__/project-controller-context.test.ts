import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { appErrorMessage, displayedErrorMessage, failureText, projectDeleteFailureMessage, projectOpenFailureMessage, receivedIpcResult, resultFailure } from '../../../src/i18n/app-errors'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  currentProjectPath: '',
  existingPaths: new Set<string>(),
  initCalls: [] as string[],
  initVerified: [] as unknown[],
  verifyCanonicalProjectData: vi.fn(),
  createCalls: [] as string[],
  createdVelaDirectories: new Set<string>(),
  failCorePaths: new Set<string>(),
  failInitPaths: new Set<string>(),
  sealedRootCount: 0,
  onCoreGet: null as null | (() => void),
  coreAiSources: {} as Record<string, unknown>,
  setAiSources: vi.fn(),
  projectCoreGet: vi.fn(),
  projectCoreInit: vi.fn(),
  projectCoreUpdate: vi.fn(),
  closeProjectDatabase: vi.fn(),
  stopPortableExports: vi.fn<(projectPath?: string) => Promise<void>>(async () => {}),
  transaction: vi.fn((operation: () => void) => operation),
  writeJsonFile: vi.fn(),
  recentProjects: [] as Array<{ name: string; path: string; updatedAt: string; projectId?: string }>,
  rmSync: vi.fn(),
  removeDirectoryWithWindowsRetry: vi.fn(),
  showMessageBox: vi.fn(),
  importLegacyProjectCopy: vi.fn(),
  repairDuplicateFinalizations: vi.fn(),
  resolveExactPath: vi.fn(),
  resolveDirectoryPath: vi.fn(),
  issueDirectory: vi.fn(),
  probeProjectSqlite: vi.fn(),
  revokeWebContents: vi.fn(),
  showOpenDialog: vi.fn(),
  projectAccess: {
    createProject: vi.fn(),
    probeExistingProject: vi.fn(),
    adoptLegacyProject: vi.fn(),
    beginSession: vi.fn(),
    captureCurrentSession: vi.fn(),
    sameCanonicalProjectRoot: vi.fn(),
    assertCurrentSession: vi.fn(),
    assertCurrentProjectContext: vi.fn(),
    authorizeDeletion: vi.fn(),
    invalidateCurrentSession: vi.fn(),
  },
  activeSession: null as null | {
    kind: 'manifest'
    projectId: string
    rootPath: string
    leaseId: string
  },
  leaseSequence: 0,
  /** 作者在设置里保存过的界面语言；没保存时主进程按系统语言选。 */
  storedLocale: undefined as undefined | 'zh-CN' | 'en-US',
  systemLocale: 'zh-CN',
  projectPeekService: {
    issueCapability: vi.fn(),
    revokeCapability: vi.fn(),
    peek: vi.fn(),
    readCurrent: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  app: { getLocale: () => mocks.systemLocale },
  dialog: {
    showOpenDialog: mocks.showOpenDialog,
    showMessageBox: mocks.showMessageBox,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn((target: string) => mocks.existingPaths.has(path.resolve(target))),
    mkdirSync: vi.fn(),
    rmSync: mocks.rmSync,
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    writeFileSync: vi.fn(),
  },
}))

vi.mock('../../database', () => ({
  closeProjectDatabase: mocks.closeProjectDatabase.mockImplementation(() => {
    mocks.currentProjectPath = ''
  }),
  getCurrentProjectPath: () => mocks.currentProjectPath || null,
  getProjectDb: () => mocks.currentProjectPath
    ? { transaction: mocks.transaction }
    : null,

  createProjectDatabase: vi.fn((projectPath: string) => { mocks.createCalls.push(path.resolve(projectPath)) }),
  initProjectDatabase: vi.fn((projectPath: string, verified?: unknown) => {
    const resolved = path.resolve(projectPath)
    mocks.initCalls.push(resolved)
    mocks.initVerified.push(verified)
    // Mirrors the production initializer's `.vela/vela.db` parent creation.
    mocks.createdVelaDirectories.add(path.join(resolved, '.vela'))
    if (mocks.failInitPaths.has(resolved)) {
      throw new Error(`cannot initialize ${resolved}`)
    }
    mocks.currentProjectPath = resolved
    return { sealedRootCount: mocks.sealedRootCount }
  }),
}))

vi.mock('../../vector-store', () => ({
  closeConnection: vi.fn(),
}))

vi.mock('../../utils/remove-directory', () => ({
  removeDirectoryWithWindowsRetry: mocks.removeDirectoryWithWindowsRetry,
}))

vi.mock('../../utils/config-utils', () => ({
  RECENT_PROJECTS_PATH: 'recent-projects.json',
  readJsonFile: vi.fn(() => mocks.recentProjects),
  writeJsonFile: mocks.writeJsonFile,
}))

vi.mock('../../repositories/project-core-repository', () => ({
  ProjectCoreRepository: {
    get: mocks.projectCoreGet.mockImplementation(() => {
      const callback = mocks.onCoreGet
      if (callback) {
        mocks.onCoreGet = null
        callback()
      }
      if (mocks.failCorePaths.has(mocks.currentProjectPath)) {
        throw new Error(`cannot read ${mocks.currentProjectPath}`)
      }
      return {
        projectName: path.basename(mocks.currentProjectPath),
        genre: '',
        subGenre: '',
        targetAudience: '',
        totalChapters: 100,
        wordsPerChapter: 3000,
        writingLanguage: 'en-US',
        plotStructure: 'three_act',
        narrativePov: 'third_limited',
        coreOutline: '独立核心大纲',
        worldSetting: '独立世界设定',
        protagonistProfile: '独立主角设定',
        synopsis: '',
        worldbuilding: '',
        goldenFinger: '',
        charactersArch: '',
        globalGuidance: '',
        writingStyle: '',
        referenceWorks: '',
        characterStates: '',
      }
    }),
    getAiSources: () => mocks.coreAiSources,
    setAiSources: mocks.setAiSources,
    init: mocks.projectCoreInit,
    update: mocks.projectCoreUpdate,
  },
}))

vi.mock('../../services/sqlite-project-migration', () => ({
  probeProjectSqlite: mocks.probeProjectSqlite,
}))
vi.mock('../../services/project-access', () => ({
  projectAccess: mocks.projectAccess,
  ProjectSessionStaleError: class ProjectSessionStaleError extends Error {
    constructor(readonly code = 'PROJECT_SESSION_STALE') {
      super(code)
      this.name = 'ProjectSessionStaleError'
    }
  },
}))

vi.mock('../../i18n', () => ({
  mainText: (systemLocale: string | undefined, zhCNText: string, enUSText: string) =>
    (mocks.storedLocale ?? (systemLocale?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US')) === 'en-US' ? enUSText : zhCNText,
}))

vi.mock('../../services/project-peek', () => ({
  projectPeekService: mocks.projectPeekService,
}))

vi.mock('../../services/external-file-grant-service', () => ({
  externalFileGrants: { resolveExactPath: mocks.resolveExactPath, resolveDirectoryPath: mocks.resolveDirectoryPath,
    issueDirectory: mocks.issueDirectory, revokeWebContents: mocks.revokeWebContents },
}))

vi.mock('../../services/legacy-project-copy-import', () => ({
  importLegacyProjectCopy: mocks.importLegacyProjectCopy,
}))

vi.mock('../../repositories/finalization-repository', () => ({
  FinalizationRepository: { repairDuplicateFinalizations: mocks.repairDuplicateFinalizations },
}))

vi.mock('../../services/portable-export-host', () => ({ stopPortableExports: mocks.stopPortableExports }))
vi.mock('../../services/project-data-locator', () => ({ verifyCanonicalProjectData: mocks.verifyCanonicalProjectData }))

import { registerProjectController } from '../project-controller'
import { createProjectDatabase, initProjectDatabase } from '../../database'
import { shown } from '../../../src/i18n/__tests__/shown-locale'

const BetterSqlite = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

function selectedProject(projectPath: string) {
  return { grantId: `selected:${projectPath}`, displayName: path.basename(projectPath) }
}

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

function projectSession(
  projectId = 'project-A',
  projectPath = projectA,
  leaseId = 'lease-project-A',
) {
  return { projectId, leaseId, projectPath }
}

const projectA = path.resolve('C:/projects/A')
const projectB = path.resolve('C:/projects/B')
const projectC = path.resolve('C:/projects/C')
const projectD = path.resolve('C:/projects/D')
const ordinaryDirectory = path.resolve('C:/ordinary-directory')

beforeAll(() => {
  registerProjectController()
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.repairDuplicateFinalizations.mockReturnValue({ chapters: [] })
  mocks.sealedRootCount = 0
  mocks.coreAiSources = {}
  mocks.currentProjectPath = projectA
  mocks.existingPaths = new Set([
    projectA,
    projectB,
    projectD,
    path.join(projectA, '.vela'),
    path.join(projectB, '.vela'),
    path.join(projectD, '.vela'),
  ])
  mocks.initCalls = []
  mocks.initVerified = []
  mocks.verifyCanonicalProjectData.mockImplementation(async (projectPath: string) => ({ verifiedIn: 'worker', projectPath }))
  mocks.createCalls = []
  mocks.createdVelaDirectories = new Set()
  mocks.failCorePaths = new Set()
  mocks.failInitPaths = new Set()
  mocks.onCoreGet = null
  mocks.leaseSequence = 0
  mocks.activeSession = {
    kind: 'manifest',
    projectId: 'project-A',
    rootPath: projectA,
    leaseId: 'lease-project-A',
  }
  mocks.recentProjects = []
  mocks.probeProjectSqlite.mockReset().mockReturnValue({ schemaVersion: 0 })
  mocks.issueDirectory.mockReturnValue({ grantId: 'legacy-source-grant' })
  mocks.resolveDirectoryPath.mockImplementation(({ grantId }: { grantId: string }) => {
    if (!grantId?.startsWith('selected:')) throw new Error('EXTERNAL_FILE_GRANT_NOT_FOUND')
    return grantId.slice(9)
  })
  mocks.rmSync.mockImplementation(() => undefined)
  mocks.removeDirectoryWithWindowsRetry.mockImplementation(async () => undefined)
  mocks.writeJsonFile.mockImplementation((_target: string, data: unknown) => {
    mocks.recentProjects = data as Array<{ name: string; path: string; updatedAt: string; projectId?: string }>
  })
  mocks.projectAccess.createProject.mockImplementation((parentPath: string, name: string) => ({
    kind: 'manifest',
    projectId: `project-${name}`,
    rootPath: path.resolve(parentPath, name),
  }))
  mocks.projectAccess.probeExistingProject.mockImplementation((projectPath: string) => ({
    kind: 'manifest',
    projectId: `project-${path.basename(projectPath)}`,
    rootPath: path.resolve(projectPath),
  }))
  mocks.projectAccess.adoptLegacyProject.mockImplementation((project: unknown) => project)
  mocks.projectAccess.beginSession.mockImplementation((project: {
    projectId: string
    rootPath: string
  }) => {
    const session = {
      kind: 'manifest' as const,
      ...project,
      leaseId: `lease-${project.projectId}-${++mocks.leaseSequence}`,
    } as const
    mocks.activeSession = session
    return session
  })
  mocks.projectAccess.captureCurrentSession.mockImplementation(() => (
    mocks.activeSession ? { ...mocks.activeSession } : null
  ))
  mocks.projectAccess.sameCanonicalProjectRoot.mockImplementation((left: string, right: string) => (
    path.resolve(left).toLocaleLowerCase('en-US')
      === path.resolve(right).toLocaleLowerCase('en-US')
  ))
  mocks.projectAccess.assertCurrentSession.mockImplementation((lease: {
    projectId?: string
    leaseId?: string
  }) => {
    const active = mocks.activeSession
    if (
      !active
      || !lease.projectId
      || !lease.leaseId
      || active.projectId !== lease.projectId
      || active.leaseId !== lease.leaseId
    ) {
      throw new Error('PROJECT_SESSION_STALE')
    }
    return { ...active }
  })
  mocks.projectAccess.assertCurrentProjectContext.mockImplementation((context: {
    projectId?: string
    leaseId?: string
    projectPath?: string
  } | undefined, currentProjectPath: string | null) => {
    if (!context?.projectId || !context.leaseId || !context.projectPath) {
      throw new Error('PROJECT_SESSION_REQUIRED')
    }
    const active = mocks.activeSession
    if (
      !active
      || active.projectId !== context.projectId
      || active.leaseId !== context.leaseId
      || !mocks.projectAccess.sameCanonicalProjectRoot(active.rootPath, context.projectPath)
    ) {
      throw new Error('PROJECT_SESSION_STALE')
    }
    if (!currentProjectPath || !mocks.projectAccess.sameCanonicalProjectRoot(context.projectPath, currentProjectPath)) {
      throw new Error('PROJECT_SESSION_DATABASE_MISMATCH')
    }
    return { ...active }
  })
  mocks.projectAccess.authorizeDeletion.mockImplementation((lease: unknown, projectPath: string) => {
    const credential = lease as { projectId?: string; leaseId?: string }
    if (!credential.projectId || !credential.leaseId) {
      throw new Error('PROJECT_SESSION_STALE')
    }
    return path.resolve(projectPath)
  })
  mocks.projectAccess.invalidateCurrentSession.mockImplementation(() => {
    mocks.activeSession = null
  })
  mocks.projectPeekService.issueCapability.mockImplementation((projectPath: string) => ({
    capabilityId: `peek-${path.basename(projectPath)}`,
    projectId: `project-${path.basename(projectPath)}`,
  }))
  mocks.projectPeekService.peek.mockReturnValue({ state: 'unavailable' })
  mocks.projectPeekService.readCurrent.mockReturnValue({ state: 'unavailable' })
})

describe('native dialogs follow the interface language (#474)', () => {
  it('falls back to the system language when no interface language was saved', async () => {
    mocks.storedLocale = undefined
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    for (const [systemLocale, title] of [['zh-CN', '选择项目目录'], ['en-US', 'Choose the project folder']]) {
      mocks.systemLocale = systemLocale
      await handler('dialog:select-folder')({ sender: { id: 17, once: vi.fn() } }, 'project-open')
      expect(mocks.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ title }))
    }
    mocks.systemLocale = 'zh-CN'
    mocks.storedLocale = 'en-US'
    await handler('dialog:select-folder')({ sender: { id: 17, once: vi.fn() } }, 'project-create')
    expect(mocks.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Choose where to save the project' }))
    mocks.storedLocale = undefined
  })
})

describe('project controller project identity', () => {
  it('issues only purpose-specific chooser grants and treats chooser cancellation normally', async () => {
    const sender = { id: 17, once: vi.fn() }
    mocks.issueDirectory.mockReturnValue({ grantId: 'chosen-grant' })
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [projectB] })
    for (const purpose of ['project-create', 'project-open'] as const) {
      await expect(handler('dialog:select-folder')({ sender }, purpose)).resolves.toEqual({ grantId: 'chosen-grant', displayName: 'B' })
      expect(mocks.issueDirectory).toHaveBeenLastCalledWith({
        webContentsId: 17, directoryPath: projectB, operations: [purpose], ttlMs: 600_000,
      })
    }
    await expect(handler('dialog:select-legacy-project')({ sender })).resolves.toEqual({ grantId: 'chosen-grant', displayName: 'B' })
    expect(mocks.issueDirectory).toHaveBeenLastCalledWith({
      webContentsId: 17, directoryPath: projectB, operations: ['legacy-import'], ttlMs: 600_000,
    })
    sender.once.mock.calls[0][1]()
    expect(mocks.revokeWebContents).toHaveBeenCalledWith(17)
    mocks.issueDirectory.mockClear()
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(handler('dialog:select-folder')({ sender }, 'project-open')).resolves.toBeNull()
    await expect(handler('dialog:select-legacy-project')({ sender })).resolves.toBeNull()
    expect(mocks.issueDirectory).not.toHaveBeenCalled()
    await expect(handler('dialog:select-folder')({ sender }, 'write')).rejects.toThrow('IPC_HANDLER_FAILED')
  })

  it('rejects an unselected, unregistered raw project path before probing it', async () => {
    await expect(handler('project:open')({ sender: { id: 17 } }, ordinaryDirectory, 'ungranted'))
      .resolves.toMatchObject({ success: false })
    expect(mocks.projectAccess.probeExistingProject).not.toHaveBeenCalled()
  })

  it('rejects raw creation paths and refused chooser grants before project access', async () => {
    const sender = { sender: { id: 17 } }
    await expect(handler('project:create')(sender, { name: 'B', path: projectB }, 'raw-create'))
      .resolves.toMatchObject({ success: false })
    expect(mocks.projectAccess.createProject).not.toHaveBeenCalled()
    mocks.resolveDirectoryPath.mockImplementation(() => { throw new Error('EXTERNAL_FILE_GRANT_EXPIRED') })
    await expect(handler('project:open')(sender, selectedProject(projectB), 'expired-open'))
      .resolves.toMatchObject({ success: false })
    expect(mocks.projectAccess.probeExistingProject).not.toHaveBeenCalled()
  })

  it('reopens persisted recent projects and rejects replaced identities before opening the database', async () => {
    mocks.recentProjects = [{ name: 'B', path: projectB, updatedAt: '', projectId: 'project-B' }]
    await expect(handler('project:open')({ sender: { id: 17 } }, projectB, 'history-open'))
      .resolves.toMatchObject({ success: true })
    expect(mocks.resolveDirectoryPath).not.toHaveBeenCalled()
    mocks.initCalls = []
    mocks.recentProjects = [{ name: 'B', path: projectD, updatedAt: '', projectId: 'different-id' }]
    await expect(handler('project:open')({ sender: { id: 17 } }, projectD, 'history-replaced'))
      .resolves.toMatchObject({ success: false })
    expect(mocks.initCalls).not.toContain(projectD)
  })
  it('issues opaque preview capabilities for valid recent projects', async () => {
    mocks.recentProjects = [{ name: 'Project B', path: projectB, updatedAt: '2026-09-21T00:00:00.000Z' }]

    await expect(handler('project:recent-list')({})).resolves.toEqual([{
      name: 'Project B',
      path: projectB,
      updatedAt: '2026-09-21T00:00:00.000Z',
      previewCapabilityId: 'peek-B',
      projectId: 'project-B',
    }])
    expect(mocks.projectPeekService.issueCapability).toHaveBeenCalledWith(projectB)
  })

  it('previews only capabilities issued by the current recent-project listing', async () => {
    mocks.recentProjects = [{ name: 'Project B', path: projectB, updatedAt: '2026-09-21T00:00:00.000Z' }]
    mocks.projectPeekService.peek.mockReturnValue({ state: 'ready', projectId: 'project-B' })
    await handler('project:recent-list')({})

    await expect(handler('project:peek-overview')({}, 'not-issued')).resolves.toEqual({ state: 'unavailable' })
    expect(mocks.projectPeekService.peek).not.toHaveBeenCalled()
    await expect(handler('project:peek-overview')({}, 'peek-B')).resolves.toMatchObject({ state: 'ready' })
    expect(mocks.projectPeekService.peek).toHaveBeenCalledWith('peek-B')
  })

  it('reads the current overview only through the validated project session', async () => {
    mocks.projectPeekService.readCurrent.mockReturnValue({ state: 'ready', projectId: 'project-A' })

    await expect(handler('project:overview-current')({}, projectSession())).resolves.toMatchObject({
      state: 'ready',
      projectId: 'project-A',
    })
    expect(mocks.projectAccess.assertCurrentProjectContext).toHaveBeenCalledWith(projectSession(), projectA)
    expect(mocks.projectPeekService.readCurrent).toHaveBeenCalledWith('project-A', expect.any(Object))
  })

  it('reports the live main-process project database context', async () => {
    await expect(handler('project:get-runtime-context')({})).resolves.toEqual({
      activeProjectPath: projectA,
      dbReady: true,
    })
  })

  it('opens a probe-verified project with its stable identity and a fresh main-process lease', async () => {
    await expect(handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'request-open-B', projectA))
      .resolves.toMatchObject({
        success: true,
        project: {
          id: 'project-B',
          path: projectB,
          sessionLease: 'lease-project-B-1',
          novelConfig: {
            writingLanguage: 'en-US',
            coreOutline: '独立核心大纲',
            worldSetting: '独立世界设定',
            protagonistProfile: '独立主角设定',
          },
        },
      })
    expect(mocks.projectAccess.probeExistingProject).toHaveBeenCalledWith(projectB)
    expect(mocks.projectAccess.adoptLegacyProject).toHaveBeenCalled()
    expect(mocks.projectAccess.beginSession).toHaveBeenCalled()
    expect(mocks.createCalls).toEqual([])
  })

  it.each([
    ['project:open', () => handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'request-open-B-after-export', projectA)],
    ['project:create', () => handler('project:create')({ sender: { id: 17 } },
      { name: 'C', parentGrantId: `selected:${path.resolve('C:/projects')}`, genre: 'fantasy', targetAudience: 'all' }, 'request-create-C-after-export')],
  ])('%s：先等当前这本书的在途导出停完，再换库（#702）', async (_channel, run) => {
    let stopped!: () => void
    mocks.stopPortableExports.mockImplementationOnce(() => new Promise<void>(resolve => { stopped = resolve }))

    const switching = run()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mocks.stopPortableExports).toHaveBeenCalledWith(projectA)
    expect(mocks.initCalls).toEqual([])
    stopped()
    await expect(switching).resolves.toMatchObject({ success: true })
    expect(mocks.initCalls).not.toEqual([])
  })

  // #702：长篇升级要半分钟，放在 worker 里跑；期间旧书照常开着，验完才换库。
  it('project:open：另一本书在 worker 里升级校验，验完才换库，换库用的就是这次校验', async () => {
    let verified!: (value: unknown) => void
    mocks.verifyCanonicalProjectData.mockImplementationOnce(() => new Promise(resolve => { verified = resolve }))

    const opening = handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'open-B-upgrading', projectA)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mocks.verifyCanonicalProjectData).toHaveBeenCalledExactlyOnceWith(projectB)
    expect(mocks.currentProjectPath).toBe(projectA)
    expect(mocks.initCalls).toEqual([])
    verified({ verifiedIn: 'worker', projectPath: projectB })
    await expect(opening).resolves.toMatchObject({ success: true, activeProjectPath: projectB })
    expect(mocks.initCalls).toEqual([projectB])
    expect(mocks.initVerified).toEqual([{ verifiedIn: 'worker', projectPath: projectB }])
  })

  it('project:open：worker 校验期间当前这本书又开始导出，换库前也要等它停完', async () => {
    let verified!: (value: unknown) => void
    mocks.verifyCanonicalProjectData.mockImplementationOnce(() => new Promise(resolve => { verified = resolve }))
    const opening = handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'open-B-export-during-verify', projectA)
    await new Promise(resolve => setTimeout(resolve, 20))

    let stopped!: () => void
    mocks.stopPortableExports.mockImplementationOnce(() => new Promise<void>(resolve => { stopped = resolve }))
    verified({ verifiedIn: 'worker', projectPath: projectB })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mocks.stopPortableExports).toHaveBeenLastCalledWith(projectA)
    expect(mocks.initCalls).toEqual([])
    stopped()
    await expect(opening).resolves.toMatchObject({ success: true, activeProjectPath: projectB })
    expect(mocks.initCalls).toEqual([projectB])
  })

  it('project:open：另一本书校验失败时，当前这本书原样开着，不关库重开', async () => {
    mocks.verifyCanonicalProjectData.mockRejectedValueOnce(new Error('CORRUPT_SCHEMA'))
    const result = await handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'open-B-corrupt', projectA)
    expect(result).toMatchObject({
      success: false, activeProjectPath: projectA, databaseRestored: true, dbReady: true,
      error: expect.stringContaining('CORRUPT_SCHEMA'),
    })
    expect(mocks.initCalls).toEqual([])
    expect(mocks.currentProjectPath).toBe(projectA)
  })

  it('project:open：等旧书导出停下期间又打开了别的书，这次作废，不先换库再回滚', async () => {
    let stopped!: () => void
    mocks.stopPortableExports.mockImplementationOnce(() => new Promise<void>(resolve => { stopped = resolve }))
    const older = handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'open-B-while-stopping', projectA)
    await new Promise(resolve => setTimeout(resolve, 20))
    const newer = handler('project:open')({ sender: { id: 17 } }, selectedProject(projectD), 'open-D-after-stop', projectA)
    stopped()
    await expect(older).resolves.toMatchObject({ success: false, stale: true, activeProjectPath: projectA })
    await expect(newer).resolves.toMatchObject({ success: true, activeProjectPath: projectD })
    expect(mocks.initCalls).toEqual([projectD])
  })

  it('project:open：worker 校验期间又打开了别的书，这次作废，不换库', async () => {
    let verified!: (value: unknown) => void
    mocks.verifyCanonicalProjectData.mockImplementationOnce(() => new Promise(resolve => { verified = resolve }))

    const older = handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'open-B-superseded', projectA)
    await new Promise(resolve => setTimeout(resolve, 20))
    const newer = handler('project:open')({ sender: { id: 17 } }, selectedProject(projectD), 'open-D-latest', projectA)
    verified({ verifiedIn: 'worker', projectPath: projectB })
    await expect(older).resolves.toMatchObject({ success: false, stale: true, activeProjectPath: projectA })
    await expect(newer).resolves.toMatchObject({ success: true, activeProjectPath: projectD })
    expect(mocks.initCalls).toEqual([projectD])
  })

  it('project:open：重开正开着的这本书不进 worker，主进程照旧校验', async () => {
    await expect(handler('project:open')({ sender: { id: 17 } }, selectedProject(projectA), 'reopen-A', projectA))
      .resolves.toMatchObject({ success: true, activeProjectPath: projectA })
    expect(mocks.verifyCanonicalProjectData).not.toHaveBeenCalled()
    expect(mocks.initVerified).toEqual([undefined])
  })

  it('opens the project and reports what the duplicate-finalization repair found', async () => {
    const chapters = [{ chapterNumber: 2, keptDraftId: 3, keptVersion: 2,
      superseded: [{ draftId: 2, version: 1, knowledgeDocumentId: 'doc-2', targetFileName: '第2章.txt' }] }]
    mocks.repairDuplicateFinalizations.mockReturnValueOnce({ chapters })
    await expect(handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'repair-B', projectA))
      .resolves.toMatchObject({ success: true, finalizationRepair: { status: 'checked', chapters } })

    await expect(handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'repair-B-again', projectB))
      .resolves.toMatchObject({ success: true, finalizationRepair: { status: 'checked', chapters: [] } })
  })

  it('returns how many generations this open sealed, and 0 for a healthy book', async () => {
    mocks.sealedRootCount = 2
    await expect(handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'sealed-B', projectA))
      .resolves.toMatchObject({ success: true, sealedGenerationCount: 2 })

    mocks.sealedRootCount = 0
    await expect(handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'sealed-B-again', projectB))
      .resolves.toMatchObject({ success: true, sealedGenerationCount: 0 })
  })

  it('still opens the project when the duplicate-finalization repair fails, and returns the failure', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failure = new Error('SQLITE_BUSY: database is locked')
    mocks.repairDuplicateFinalizations.mockImplementationOnce(() => { throw failure })

    await expect(handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'repair-fails-B', projectA))
      .resolves.toMatchObject({
        success: true,
        project: { id: 'project-B', sessionLease: 'lease-project-B-1' },
        finalizationRepair: { status: 'failed', error: 'SQLITE_BUSY: database is locked' },
      })
    expect(logged).toHaveBeenCalledWith(expect.any(String), failure)
    logged.mockRestore()
  })

  it('does not repair duplicate finalizations in a project whose open then fails', async () => {
    mocks.projectAccess.beginSession.mockImplementationOnce(() => { throw new Error('PROJECT_SESSION_BEGIN_FAILED') })

    await expect(handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'open-fails-B', projectA))
      .resolves.toMatchObject({ success: false })
    expect(mocks.repairDuplicateFinalizations).not.toHaveBeenCalled()
  })

  it('opens a complete imported target after its publish ACK is lost and adds it to recent projects', async () => {
    await expect(handler('project:recent-list')({})).resolves.toEqual([])
    await expect(handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'recover-imported-B', projectA))
      .resolves.toMatchObject({ success: true, project: { id: 'project-B', path: projectB } })
    expect(mocks.projectAccess.probeExistingProject).toHaveBeenCalledWith(projectB)
    expect(mocks.initCalls).toContain(projectB)
    expect(mocks.createCalls).toEqual([])
    await expect(handler('project:recent-list')({})).resolves.toEqual([
      expect.objectContaining({ path: projectB, projectId: 'project-B', previewCapabilityId: 'peek-B' }),
    ])
  })

  it('reopens the same project with a new lease while preserving its stable ProjectId', async () => {
    const first = await handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'request-open-B-1', projectA)
    const second = await handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'request-open-B-2', projectB)

    expect(first).toMatchObject({
      success: true,
      project: { id: 'project-B', sessionLease: 'lease-project-B-1' },
    })
    expect(second).toMatchObject({
      success: true,
      project: { id: 'project-B', sessionLease: 'lease-project-B-2' },
    })
  })

  it('deduplicates recent projects across Windows path casing, separators, and trailing slashes', async () => {
    mocks.recentProjects = [{
      name: 'old A',
      path: 'c:/PROJECTS/A/',
      updatedAt: 'old',
    }]

    await expect(handler('project:open')({ sender: { id: 17 } }, selectedProject(projectA), 'request-open-A', projectA))
      .resolves.toMatchObject({ success: true })

    expect(mocks.recentProjects).toEqual([
      expect.objectContaining({ path: projectA }),
    ])
  })

  it('serializes concurrent opens and rolls back when the latest request fails', async () => {
    let latestRequest: Promise<unknown> | null = null
    mocks.failCorePaths.add(projectD)
    mocks.onCoreGet = () => {
      latestRequest = handler('project:open')({ sender: { id: 17 } }, selectedProject(projectD), 'request-D', projectA)
    }

    const olderRequest = handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'request-B', projectA)
    const olderResult = await olderRequest
    expect(latestRequest).not.toBeNull()
    const latestResult = await latestRequest!

    expect(olderResult).toMatchObject({
      success: false,
      stale: true,
      requestToken: 'request-B',
    })
    expect(latestResult).toMatchObject({
      success: false,
      requestToken: 'request-D',
      activeProjectPath: projectA,
      databaseRestored: true,
      dbReady: true,
    })
    expect(mocks.initCalls).toEqual([projectB, projectA, projectD, projectA])
    expect(mocks.currentProjectPath).toBe(projectA)
  })

  it('rolls a failed open back only to the captured trusted lease root, never the renderer path', async () => {
    mocks.existingPaths.add(ordinaryDirectory)
    mocks.failCorePaths.add(projectD)

    await expect(handler('project:open')({ sender: { id: 17 } }, selectedProject(projectD),
      'request-open-D-untrusted-renderer-path',
      ordinaryDirectory,
    )).resolves.toMatchObject({
      success: false,
      requestToken: 'request-open-D-untrusted-renderer-path',
      activeProjectPath: projectA,
      databaseRestored: true,
      dbReady: true,
    })

    // `initProjectDatabase` creates `<root>/.vela/vela.db` in production. A
    // renderer-supplied ordinary directory must never reach that authority.
    expect(mocks.initCalls).toEqual([projectD, projectA])
    expect(mocks.initCalls).not.toContain(ordinaryDirectory)
    expect(mocks.createdVelaDirectories).not.toContain(path.join(ordinaryDirectory, '.vela'))
    expect(mocks.projectAccess.captureCurrentSession).toHaveBeenCalledOnce()
    expect(mocks.activeSession).toMatchObject({
      rootPath: projectA,
      leaseId: 'lease-project-A',
    })
  })

  it('rolls a failed create back only to the captured trusted lease root, never the renderer path', async () => {
    mocks.existingPaths.add(ordinaryDirectory)
    mocks.projectCoreUpdate.mockImplementationOnce(() => {
      throw new Error('cannot initialize project core')
    })

    await expect(handler('project:create')(
      { sender: { id: 17 } },
      {
        name: 'C',
        parentGrantId: `selected:${path.resolve('C:/projects')}`,
        genre: 'fantasy',
        targetAudience: 'all',
      },
      'request-create-C-untrusted-renderer-path',
      ordinaryDirectory,
    )).resolves.toMatchObject({
      success: false,
      requestToken: 'request-create-C-untrusted-renderer-path',
      activeProjectPath: projectA,
      databaseRestored: true,
      dbReady: true,
    })

    expect(mocks.initCalls).toEqual([projectC, projectA])
    expect(mocks.initCalls).not.toContain(ordinaryDirectory)
    expect(mocks.createdVelaDirectories).not.toContain(path.join(ordinaryDirectory, '.vela'))
    expect(mocks.projectAccess.captureCurrentSession).toHaveBeenCalledOnce()
  })

  it('returns a typed storage-path error before initializing a rejected project database', async () => {
    mocks.projectAccess.createProject.mockImplementationOnce(() => {
      throw Object.assign(new Error('请改用更靠近磁盘根目录的位置'), {
        code: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
      })
    })

    await expect(handler('project:create')(
      { sender: { id: 17 } },
      {
        name: 'C',
        parentGrantId: `selected:${path.resolve('C:/projects')}`,
        genre: 'fantasy',
        targetAudience: 'all',
      },
      'request-create-C-unsafe-storage-path',
      projectA,
    )).resolves.toMatchObject({
      success: false,
      errorCode: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
      databaseRestored: true,
      dbReady: true,
    })

    expect(mocks.initCalls).toEqual([projectA])
    expect(mocks.initCalls).not.toContain(projectC)
  })

  it('returns an actionable typed error when the selected folder is not a project root', async () => {
    mocks.projectAccess.probeExistingProject.mockImplementationOnce(() => {
      throw Object.assign(new Error('selected parent is not a project root'), {
        code: 'PROJECT_ROOT_REQUIRED',
      })
    })

    await expect(handler('project:open')({ sender: { id: 17 } }, selectedProject(ordinaryDirectory),
      'request-open-parent-directory',
      projectA,
    )).resolves.toMatchObject({
      success: false,
      errorCode: 'PROJECT_ROOT_REQUIRED',
      databaseRestored: true,
      dbReady: true,
    })

    expect(mocks.initCalls).toEqual([])
    expect(mocks.initCalls).not.toContain(ordinaryDirectory)
  })

  it('offers the selected recognized legacy project as a window-bound import source without opening it', async () => {
    mocks.recentProjects = [{ name: 'B', path: projectB, updatedAt: '' }]
    mocks.projectAccess.probeExistingProject.mockReturnValueOnce({
      kind: 'manifest', projectId: 'old-B', rootPath: projectB, storageFormat: 'legacy',
    })
    mocks.projectAccess.adoptLegacyProject.mockImplementation(() => { throw new Error('PROJECT_MIGRATION_NOT_QUALIFIED') })
    const sender = { id: 17, once: vi.fn() }
    const result = await handler('project:open')({ sender }, projectB, 'request-legacy-B')
    expect(result).toMatchObject({
      success: false,
      errorCode: 'PROJECT_LEGACY_IMPORT_REQUIRED',
      legacyImportSource: { grantId: 'legacy-source-grant', displayName: 'B' },
      databaseRestored: true,
      dbReady: true,
    })
    expect(mocks.issueDirectory).toHaveBeenCalledWith({
      webContentsId: 17, directoryPath: projectB, operations: ['legacy-import'], ttlMs: 600_000,
    })
    expect(mocks.initCalls).not.toContain(projectB)
    expect(mocks.importLegacyProjectCopy).not.toHaveBeenCalled()
  })

  it.each([
    ['PROJECT_MIGRATION_RECOVERY_REQUIRED', '项目格式转换尚未具备安全迁移条件，已保留原项目且未写入。请通过“导入旧项目”创建完整副本。', 'This project cannot be converted safely yet. The original was kept and nothing was written. Use Import legacy project to create a complete copy.'],
    ['UNRECOGNIZED_SCHEMA', '无法识别项目格式，已拒绝打开。请核查创建该项目的软件和版本。', 'The project format is not recognized, so it was not opened. Check which app and version created it.'],
    ['CORRUPT_SCHEMA', '项目数据结构已损坏，已拒绝打开。请保留原件并从备份恢复。', 'The project data structure is damaged, so it was not opened. Keep the original and restore from a backup.'],
    ['NEWER_SCHEMA_READ_ONLY', '该项目由更新版本创建，已拒绝打开。请升级软件后再打开。', 'This project was created by a newer version, so it was not opened. Update the app, then open it again.'],
    ['LEGACY_IMPORT_UNSUPPORTED_SOURCE', '此项目版本不支持旧项目导入。请用原版本软件打开或导出。', 'Projects from this version cannot be imported as legacy projects. Open or export it with the app version that created it.'],
  ])(
    'explains %s without offering an import grant for a legacy project', async (reason, zhCN, enUS) => {
      mocks.projectAccess.probeExistingProject.mockReturnValueOnce({
        kind: 'manifest', projectId: 'old-B', rootPath: projectB, storageFormat: 'legacy',
      })
      mocks.projectAccess.adoptLegacyProject.mockImplementation(() => { throw new Error('PROJECT_MIGRATION_NOT_QUALIFIED') })
      if (reason === 'PROJECT_MIGRATION_RECOVERY_REQUIRED') {
        mocks.existingPaths.add(path.join(projectB, '.ai-novel-migration'))
      } else if (reason === 'LEGACY_IMPORT_UNSUPPORTED_SOURCE') {
        mocks.probeProjectSqlite.mockReturnValueOnce({ schemaVersion: 7 })
      } else {
        mocks.probeProjectSqlite.mockImplementationOnce(() => { throw new Error(reason) })
      }
      const result = await handler('project:open')({ sender: { id: 17, once: vi.fn() } }, selectedProject(projectB), 'request-legacy-blocked') as { error: string }
      expect(appErrorMessage(shown('zh-CN'), result.error)).toBe(zhCN)
      expect(appErrorMessage(shown('en-US'), result.error)).toBe(enUS)
      expect(result).toMatchObject({
        success: false,
        databaseRestored: true,
        dbReady: true,
        activeProjectPath: projectA,
      })
      expect(result).not.toHaveProperty('legacyImportSource')
      expect(mocks.issueDirectory).not.toHaveBeenCalled()
      expect(mocks.initCalls).not.toContain(projectB)
      expect(mocks.initCalls).toEqual([])
      expect(mocks.currentProjectPath).toBe(projectA)
    },
  )
  it('preserves the actionable migration refusal instead of overwriting it with an internal code', async () => {
    mocks.projectAccess.probeExistingProject.mockImplementationOnce(() => {
      throw new Error('PROJECT_MIGRATION_NOT_QUALIFIED')
    })
    const result = await handler('project:open')({ sender: { id: 17 } }, selectedProject(ordinaryDirectory), 'request-unqualified-legacy') as { error: string }
    expect(result).not.toHaveProperty('errorCode')
    expect(appErrorMessage(shown('en-US'), result.error)).toBe('This project cannot be converted safely yet. The original was kept and nothing was written. Use Import legacy project to create a complete copy.')
    expect(result).toMatchObject({
      success: false,
      databaseRestored: true,
      dbReady: true,
    })
    expect(mocks.initCalls).toEqual([])
    expect(mocks.initCalls).not.toContain(ordinaryDirectory)
  })

  it('creates from a first-ever neutral runtime, returns to no database or lease, then opens explicitly', async () => {
    mocks.currentProjectPath = ''
    mocks.activeSession = null

    const created = await handler('project:create')(
      { sender: { id: 17 } },
      {
        name: 'C',
        parentGrantId: `selected:${path.resolve('C:/projects')}`,
        genre: 'fantasy',
        targetAudience: 'all',
      },
      'request-create-C-first-ever',
    )

    expect(created).toMatchObject({
      success: true,
      projectId: 'project-C',
      projectPath: projectC,
      requestToken: 'request-create-C-first-ever',
      activeProjectPath: null,
      databaseRestored: true,
      dbReady: true,
    })
    expect(mocks.currentProjectPath).toBe('')
    expect(mocks.activeSession).toBeNull()
    await expect(handler('project:get-runtime-context')({})).resolves.toEqual({
      activeProjectPath: null,
      dbReady: true,
    })

    expect(mocks.createCalls).toEqual([projectC])
    await expect(handler('project:open')({ sender: { id: 17 } }, selectedProject(projectC), 'request-open-created-C'))
      .resolves.toMatchObject({
        success: true,
        project: {
          id: 'project-C',
          path: projectC,
          sessionLease: 'lease-project-C-1',
        },
        activeProjectPath: projectC,
        databaseRestored: true,
        dbReady: true,
      })
    expect(mocks.activeSession).toMatchObject({
      projectId: 'project-C',
      rootPath: projectC,
      leaseId: 'lease-project-C-1',
    })
  })

  it('initializes a new project with the writing language selected at creation time', async () => {
    mocks.currentProjectPath = ''
    mocks.activeSession = null

    await expect(handler('project:create')(
      { sender: { id: 17 } },
      {
        name: 'English novel',
        parentGrantId: `selected:${path.resolve('C:/projects')}`,
        genre: 'fantasy',
        targetAudience: 'all',
        writingLanguage: 'en-US',
      },
      'request-create-English-novel',
    )).resolves.toMatchObject({ success: true })

    expect(mocks.projectCoreInit).toHaveBeenCalledWith('English novel', 'en-US')
  })

  it('restores a failed first-ever create to neutral without touching an ordinary renderer path or reviving a lease', async () => {
    mocks.currentProjectPath = ''
    mocks.activeSession = null
    mocks.existingPaths.add(ordinaryDirectory)
    mocks.projectCoreUpdate.mockImplementationOnce(() => {
      throw new Error('cannot initialize project core')
    })

    await expect(handler('project:create')(
      { sender: { id: 17 } },
      {
        name: 'C',
        parentGrantId: `selected:${path.resolve('C:/projects')}`,
        genre: 'fantasy',
        targetAudience: 'all',
      },
      'request-create-C-first-ever-failure',
      ordinaryDirectory,
    )).resolves.toMatchObject({
      success: false,
      requestToken: 'request-create-C-first-ever-failure',
      activeProjectPath: null,
      databaseRestored: true,
      dbReady: true,
      error: 'PROJECT_CREATE_FAILED',
    })

    expect(mocks.initCalls).toEqual([projectC])
    expect(mocks.initCalls).not.toContain(ordinaryDirectory)
    expect(mocks.createdVelaDirectories).not.toContain(path.join(ordinaryDirectory, '.vela'))
    expect(mocks.currentProjectPath).toBe('')
    expect(mocks.activeSession).toBeNull()
    expect(mocks.projectAccess.beginSession).not.toHaveBeenCalled()
  })

  it('uses the captured trusted root for a stale open instead of creating a database below rendererProjectPath', async () => {
    let latestRequest: Promise<unknown> | null = null
    mocks.existingPaths.add(ordinaryDirectory)
    mocks.failCorePaths.add(projectD)
    mocks.onCoreGet = () => {
      latestRequest = handler('project:open')({ sender: { id: 17 } }, selectedProject(projectD), 'request-D-after-B', projectA)
    }

    const olderResult = await handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB),
      'request-B-before-D',
      ordinaryDirectory,
    )
    expect(latestRequest).not.toBeNull()
    await latestRequest!

    expect(olderResult).toMatchObject({
      success: false,
      stale: true,
      requestToken: 'request-B-before-D',
      activeProjectPath: projectA,
      databaseRestored: true,
      dbReady: true,
    })
    expect(mocks.initCalls).toEqual([projectB, projectA, projectD, projectA])
    expect(mocks.initCalls).not.toContain(ordinaryDirectory)
    expect(mocks.createdVelaDirectories).not.toContain(path.join(ordinaryDirectory, '.vela'))
  })

  it('fails closed rather than reviving an old same-root lease after that lease expires during recovery', async () => {
    mocks.failCorePaths.add(projectD)
    mocks.onCoreGet = () => {
      // Same root, but a later open has already issued a new lease. The old
      // operation's snapshot is no longer trusted even though its path matches.
      mocks.activeSession = {
        kind: 'manifest',
        projectId: 'project-A',
        rootPath: projectA,
        leaseId: 'lease-project-A-new',
      }
    }

    await expect(handler('project:open')({ sender: { id: 17 } }, selectedProject(projectD),
      'request-open-D-expired-rollback',
      projectA,
    )).resolves.toMatchObject({
      success: false,
      requestToken: 'request-open-D-expired-rollback',
      activeProjectPath: null,
      databaseRestored: false,
      dbReady: false,
    })

    expect(mocks.initCalls).toEqual([projectD])
    expect(mocks.projectAccess.assertCurrentSession).toHaveBeenCalledWith(expect.objectContaining({
      leaseId: 'lease-project-A',
    }))
    expect(mocks.closeProjectDatabase).toHaveBeenCalledOnce()
    expect(mocks.projectAccess.invalidateCurrentSession).toHaveBeenCalledOnce()
    expect(mocks.activeSession).toBeNull()
  })

  it('fails closed when a failed open has no trusted rollback snapshot', async () => {
    mocks.activeSession = null
    mocks.existingPaths.add(ordinaryDirectory)
    mocks.failCorePaths.add(projectD)

    const result = await handler('project:open')({ sender: { id: 17 } }, selectedProject(projectD),
      'request-open-D-no-rollback-snapshot',
      ordinaryDirectory,
    )
    expect(result).toMatchObject({
      success: false,
      requestToken: 'request-open-D-no-rollback-snapshot',
      activeProjectPath: null,
      databaseRestored: false,
      dbReady: false,
      error: 'PROJECT_OPERATION_FAILED', failure: { code: 'PROJECT_OPERATION_FAILED' },
    })
    expect((result as { error: string }).error).not.toMatch(/PROJECT_ROLLBACK/)

    expect(mocks.initCalls).toEqual([projectD])
    expect(mocks.createdVelaDirectories).not.toContain(path.join(ordinaryDirectory, '.vela'))
    expect(mocks.closeProjectDatabase).toHaveBeenCalledOnce()
    expect(mocks.projectAccess.invalidateCurrentSession).toHaveBeenCalledOnce()
  })

  it('serializes create with open and prevents a stale create from initializing a new database', async () => {
    const creating = handler('project:create')(
      { sender: { id: 17 } },
      {
        name: 'C',
        parentGrantId: `selected:${path.resolve('C:/projects')}`,
        genre: 'fantasy',
        targetAudience: 'all',
      },
      'request-create-C',
      projectA,
    )
    const opening = handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'request-open-B', projectA)

    await expect(creating).resolves.toMatchObject({
      success: false,
      stale: true,
      requestToken: 'request-create-C',
    })
    await expect(opening).resolves.toMatchObject({
      success: true,
      requestToken: 'request-open-B',
      activeProjectPath: projectB,
      databaseRestored: true,
      dbReady: true,
    })
    expect(mocks.initCalls).not.toContain(projectC)
    expect(mocks.currentProjectPath).toBe(projectB)
  })

  it('fails closed when open fails and trusted rollback cannot restore the previous project', async () => {
    mocks.failCorePaths.add(projectD)
    mocks.failInitPaths.add(projectA)

    const result = await handler('project:open')({ sender: { id: 17 } }, selectedProject(projectD),
      'request-open-D',
      projectA,
    )
    expect(result).toMatchObject({
      success: false,
      requestToken: 'request-open-D',
      activeProjectPath: null,
      databaseRestored: false,
      dbReady: false,
      error: 'PROJECT_OPERATION_FAILED', failure: { code: 'PROJECT_OPERATION_FAILED' },
    })
    expect((result as { error: string }).error).not.toMatch(/cannot initialize/)
    expect(mocks.projectAccess.beginSession).not.toHaveBeenCalled()
    expect(mocks.closeProjectDatabase).toHaveBeenCalledOnce()
    expect(mocks.projectAccess.invalidateCurrentSession).toHaveBeenCalledOnce()
  })

  it('fails closed when create fails and trusted rollback cannot restore the previous project', async () => {
    mocks.projectCoreUpdate.mockImplementationOnce(() => {
      throw new Error('cannot initialize project core')
    })
    mocks.failInitPaths.add(projectA)

    await expect(handler('project:create')(
      { sender: { id: 17 } },
      {
        name: 'C',
        parentGrantId: `selected:${path.resolve('C:/projects')}`,
        genre: 'fantasy',
        targetAudience: 'all',
      },
      'request-create-C-fail',
      projectA,
    )).resolves.toMatchObject({
      success: false,
      requestToken: 'request-create-C-fail',
      activeProjectPath: null,
      databaseRestored: false,
      dbReady: false,
      error: 'PROJECT_CREATE_FAILED',
    })
    expect(mocks.projectAccess.beginSession).not.toHaveBeenCalled()
    expect(mocks.closeProjectDatabase).toHaveBeenCalledOnce()
    expect(mocks.projectAccess.invalidateCurrentSession).toHaveBeenCalledOnce()
  })

  it('rejects missing or stale project identities before project config writes', async () => {
    const data = {
      path: projectA,
      sessionLease: 'lease-project-A',
      name: 'Project A',
      novelConfig: {
        genre: 'fantasy',
      },
    }

    const saveWithoutIdentity = await handler('project:save')({}, 'main', data)
    const saveWithStaleIdentity = await handler('project:save')({}, 'main', data, projectB)
    const saveWithMismatchedPayload = await handler('project:save')(
      {},
      'main',
      { ...data, path: projectB },
      projectA,
    )
    const updateWithoutIdentity = await handler('project:update-config')({}, 'main', data)
    const updateWithStaleIdentity = await handler('project:update-config')(
      {},
      'main',
      data,
      projectB,
    )

    expect(saveWithoutIdentity).toMatchObject({ success: false })
    expect(saveWithStaleIdentity).toMatchObject({ success: false })
    expect(saveWithMismatchedPayload).toMatchObject({ success: false })
    expect(updateWithoutIdentity).toMatchObject({ success: false })
    expect(updateWithStaleIdentity).toMatchObject({ success: false })
    expect(mocks.projectCoreUpdate).not.toHaveBeenCalled()
  })

  it('rejects a project config write that omits its session lease even when its path is current', async () => {
    const result = await handler('project:save')({}, 'project-A', {
      path: projectA,
      name: 'Project A',
      novelConfig: { genre: 'fantasy' },
    }, projectA)

    expect(result).toMatchObject({
      success: false,
      error: 'PROJECT_SESSION_REQUIRED', failure: { code: 'PROJECT_SESSION_REQUIRED' },
    })
    expect(mocks.projectCoreUpdate).not.toHaveBeenCalled()
  })

  it('allows project config writes only for the explicitly active project', async () => {
    const data = {
      path: projectA,
      sessionLease: 'lease-project-A',
      name: 'Project A',
      novelConfig: {
        genre: 'fantasy',
      },
    }

    await expect(handler('project:save')({}, 'project-A', data, projectA, projectSession()))
      .resolves.toMatchObject({ success: true, recentProjectUpdated: true })
    await expect(handler('project:update-config')({}, 'project-A', data, projectA, projectSession()))
      .resolves.toEqual({ success: true })
    expect(mocks.projectCoreUpdate).toHaveBeenCalled()
    expect(mocks.transaction).toHaveBeenCalled()
  })

  it('persists the project creative strategy independently from model settings', async () => {
    const data = {
      path: projectA,
      sessionLease: 'lease-project-A',
      name: 'Project A',
      novelConfig: {
        genre: 'fantasy',
        creativeStrategy: 'consistency-first',
      },
    }

    await expect(handler('project:save')({}, 'project-A', data, projectA, projectSession()))
      .resolves.toMatchObject({ success: true })
    expect(mocks.projectCoreUpdate).toHaveBeenCalledWith(expect.objectContaining({
      creativeStrategy: 'consistency-first',
    }))
  })

  it('设定细则的 AI 来源标记随保存写入，重开作品时与设定并列带回，不进设定', async () => {
    const aiSources = { worldSetting: { kind: 'filled', hash: '1a2b3c4d' } }
    const data = { path: projectA, sessionLease: 'lease-project-A', name: 'Project A', novelConfig: { genre: 'fantasy' }, aiSources }
    await expect(handler('project:save')({}, 'project-A', data, projectA, projectSession())).resolves.toMatchObject({ success: true })
    expect(mocks.setAiSources).toHaveBeenCalledWith(aiSources)

    mocks.coreAiSources = aiSources
    type Opened = { project: { novelConfig: Record<string, unknown>; aiSources: unknown } }
    const reopened = await handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'ai-sources-marked', projectA) as Opened
    expect(reopened.project.aiSources).toEqual(aiSources)
    expect(reopened.project.novelConfig).not.toHaveProperty('aiSources')
  })

  it('persists the project writing language independently from the application locale', async () => {
    const data = {
      path: projectA,
      sessionLease: 'lease-project-A',
      name: 'Project A',
      novelConfig: {
        genre: 'fantasy',
        writingLanguage: 'en-US',
      },
    }

    await expect(handler('project:save')({}, 'project-A', data, projectA, projectSession()))
      .resolves.toMatchObject({ success: true })
    expect(mocks.projectCoreUpdate).toHaveBeenCalledWith(expect.objectContaining({
      writingLanguage: 'en-US',
    }))
  })

  it('does not reset a saved creative strategy during an unrelated partial config write', async () => {
    const data = {
      path: projectA,
      sessionLease: 'lease-project-A',
      novelConfig: { genre: 'mystery' },
    }

    await expect(handler('project:update-config')({}, 'project-A', data, projectA, projectSession()))
      .resolves.toEqual({ success: true })
    expect(mocks.projectCoreUpdate).toHaveBeenCalledOnce()
    expect(mocks.projectCoreUpdate.mock.calls[0]?.[0]).not.toHaveProperty('creativeStrategy')
  })

  it('rejects a supplied stale session lease before a project config write commits', async () => {
    mocks.projectAccess.assertCurrentProjectContext.mockImplementationOnce(() => {
      throw new Error('PROJECT_SESSION_STALE')
    })
    const data = {
      path: projectA,
      sessionLease: 'stale-lease',
      novelConfig: { genre: 'fantasy' },
    }

    await expect(handler('project:save')({}, 'project-A', data, projectA, projectSession('project-A', projectA, 'stale-lease')))
      .resolves.toMatchObject({
        success: false,
        error: 'PROJECT_SESSION_STALE', failure: { code: 'PROJECT_SESSION_STALE' },
      })
    expect(mocks.projectCoreUpdate).not.toHaveBeenCalled()
  })

  it('reports the SQLite commit accurately when updating recent projects fails afterward', async () => {
    mocks.writeJsonFile.mockImplementationOnce(() => {
      throw new Error('recent list locked')
    })
    const data = {
      path: projectA,
      sessionLease: 'lease-project-A',
      name: 'Project A',
      characterStates: 'committed',
    }

    await expect(handler('project:save')({}, 'project-A', data, projectA, projectSession())).resolves.toMatchObject({
      success: true,
      recentProjectUpdated: false,
    })
    expect(mocks.projectCoreUpdate).toHaveBeenCalledWith(expect.objectContaining({
      projectName: 'Project A',
      characterStates: 'committed',
    }))
  })

  it('removes a missing project from recent navigation without deleting project data', async () => {
    const movedProject = path.resolve('C:/projects/moved-away')
    mocks.recentProjects = [
      { name: 'Moved', path: movedProject, updatedAt: '2026-09-01T00:00:00.000Z' },
      { name: 'Project A', path: projectA, updatedAt: '2026-09-02T00:00:00.000Z' },
    ]

    await expect(handler('project:recent-remove')({}, movedProject)).resolves.toEqual({ success: true })

    expect(mocks.recentProjects).toEqual([
      { name: 'Project A', path: projectA, updatedAt: '2026-09-02T00:00:00.000Z' },
    ])
    expect(mocks.removeDirectoryWithWindowsRetry).not.toHaveBeenCalled()
    expect(mocks.projectAccess.assertCurrentProjectContext).not.toHaveBeenCalled()
  })

  it('等导出停完后重新核对删除目标：目录在等待期间被换掉就不关库也不删（#702）', async () => {
    mocks.stopPortableExports.mockImplementationOnce(async () => {
      mocks.projectAccess.authorizeDeletion.mockImplementationOnce(() => { throw new Error('PROJECT_IDENTITY_CHANGED') })
    })

    await expect(handler('project:delete')({}, projectA, 'project-A', 'lease-project-A', projectSession())).resolves.toMatchObject({
      success: false,
      directoryDeleted: false,
      error: 'PROJECT_OPERATION_FAILED', failure: { code: 'PROJECT_OPERATION_FAILED' },
    })
    expect(mocks.removeDirectoryWithWindowsRetry).not.toHaveBeenCalled()
    expect(mocks.closeProjectDatabase).not.toHaveBeenCalled()
  })

  it('reopens the active database and reports failure when the project directory remains', async () => {
    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce(() => {
      throw new Error('directory locked')
    })

    await expect(handler('project:delete')({}, projectA, 'project-A', 'lease-project-A', projectSession())).resolves.toMatchObject({
      success: false,
      directoryDeleted: false,
      databaseRestored: true,
      error: 'PROJECT_DELETE_FAILED',
    })
    expect(mocks.initCalls).toContain(projectA)
    expect(mocks.currentProjectPath).toBe(projectA)
    expect(mocks.projectAccess.invalidateCurrentSession).not.toHaveBeenCalled()
  })

  it('reports that the database was not restored after a failed active-project delete', async () => {
    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce(() => {
      throw new Error('directory locked')
    })
    mocks.failInitPaths.add(projectA)

    await expect(handler('project:delete')({}, projectA, 'project-A', 'lease-project-A', projectSession())).resolves.toMatchObject({
      success: false,
      directoryDeleted: false,
      databaseRestored: false,
      error: 'PROJECT_DELETE_FAILED',
    })
    expect(mocks.currentProjectPath).toBe('')
  })

  it('reports deletion success when the directory commit succeeds but recent-list cleanup fails', async () => {
    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce((target: string) => {
      mocks.existingPaths.delete(path.resolve(target))
    })
    mocks.writeJsonFile.mockImplementationOnce(() => {
      throw new Error('recent list locked')
    })

    await expect(handler('project:delete')({}, projectA, 'project-A', 'lease-project-A', projectSession())).resolves.toMatchObject({
      success: true,
      directoryDeleted: true,
      databaseRestored: false,
      warning: 'PROJECT_DELETE_RECENT_LIST_FAILED',
    })
    expect(mocks.currentProjectPath).toBe('')
    expect(mocks.projectAccess.invalidateCurrentSession).toHaveBeenCalledOnce()
    expect(mocks.removeDirectoryWithWindowsRetry).toHaveBeenCalledWith(projectA)
  })

  it('删目录期间另一本书打开完成，删完不清掉新书的会话', async () => {
    let removed!: () => void
    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce((target: string) => new Promise<void>(resolve => {
      removed = () => { mocks.existingPaths.delete(path.resolve(target)); resolve() }
    }))
    const deleting = handler('project:delete')({}, projectA, 'project-A', 'lease-project-A', projectSession())
    await new Promise(resolve => setTimeout(resolve, 20))
    const opened = await handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'open-B-during-delete', null)
    expect(opened).toMatchObject({ success: true, activeProjectPath: projectB })
    removed()
    await expect(deleting).resolves.toMatchObject({ success: true, directoryDeleted: true })
    expect(mocks.activeSession).toMatchObject({ rootPath: projectB, leaseId: (opened as { project: { sessionLease: string } }).project.sessionLease })
  })

  it('rejects deletion without a current project session context before touching the filesystem', async () => {
    await expect(handler('project:delete')({}, projectA)).resolves.toMatchObject({
      success: false,
      directoryDeleted: false,
      error: 'PROJECT_SESSION_REQUIRED', failure: { code: 'PROJECT_SESSION_REQUIRED' },
    })
    expect(mocks.removeDirectoryWithWindowsRetry).not.toHaveBeenCalled()
  })

  it('rejects a stale session context for deletion even when the same project path is still open', async () => {
    mocks.projectAccess.assertCurrentProjectContext.mockImplementationOnce(() => {
      throw new Error('PROJECT_SESSION_STALE')
    })

    await expect(handler('project:delete')(
      {},
      projectA,
      'project-A',
      'legacy-lease-argument',
      projectSession('project-A', projectA, 'stale-lease'),
    )).resolves.toMatchObject({
      success: false,
      directoryDeleted: false,
      error: 'PROJECT_SESSION_STALE', failure: { code: 'PROJECT_SESSION_STALE' },
    })
    expect(mocks.removeDirectoryWithWindowsRetry).not.toHaveBeenCalled()
  })

  it('rejects a leased deletion when its project is no longer the active database root', async () => {
    mocks.currentProjectPath = projectB

    await expect(handler('project:delete')({}, projectA, 'project-A', 'lease-project-A', projectSession('project-A', projectA)))
      .resolves.toMatchObject({
        success: false,
        directoryDeleted: false,
        error: expect.stringContaining('PROJECT_SESSION_DATABASE_MISMATCH'),
      })
    expect(mocks.removeDirectoryWithWindowsRetry).not.toHaveBeenCalled()
  })

  it('cleans the local cloud binding only after the project directory deletion commits', async () => {
    const removeDeletedProjectBinding = vi.fn()
    registerProjectController({ removeDeletedProjectBinding })
    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce((target: string) => {
      mocks.existingPaths.delete(path.resolve(target))
    })

    await expect(handler('project:delete')(
      {},
      projectA,
      'project-A',
      'lease-project-A',
      projectSession(),
    )).resolves.toMatchObject({ success: true, directoryDeleted: true })
    expect(removeDeletedProjectBinding).toHaveBeenCalledWith('project-A')

    registerProjectController()
  })
})

describe('legacy project copy import target grant', () => {
  const sender = { sender: { id: 17 } }
  const legacyRoot = path.resolve('C:/old/book')
  const grantedTarget = path.resolve('C:/new/book-copy')

  beforeEach(() => {
    mocks.showMessageBox.mockReset().mockResolvedValue({ response: 1 })
    mocks.importLegacyProjectCopy.mockReset().mockImplementation(async (input: { targetRoot: string }) => ({
      state: 'ready', projectId: 'copy-id', targetRoot: input.targetRoot,
    }))
    mocks.resolveExactPath.mockReset().mockReturnValue(grantedTarget)
  })

  it('imports into the main-process path resolved from the sender-bound chooser grant', async () => {
    await expect(handler('project:import-legacy-copy')(sender, `selected:${legacyRoot}`, 'restore-target-grant'))
      .resolves.toEqual({ state: 'ready', projectId: 'copy-id', targetRoot: grantedTarget })

    expect(mocks.resolveExactPath).toHaveBeenCalledExactlyOnceWith({
      grantId: 'restore-target-grant', webContentsId: 17, operation: 'create',
    })
    expect(mocks.importLegacyProjectCopy).toHaveBeenCalledExactlyOnceWith({
      sourceRoot: legacyRoot, targetRoot: grantedTarget,
    })
  })

  it('never reaches the importer when the grant is refused or the argument is not a grant id', async () => {
    mocks.resolveExactPath.mockImplementation(() => { throw new Error('EXTERNAL_FILE_GRANT_WRONG_WINDOW') })

    await expect(handler('project:import-legacy-copy')(sender, `selected:${legacyRoot}`, path.resolve('C:/attacker/raw-target')))
      .resolves.toEqual({ state: 'blocked', code: 'LEGACY_IMPORT_PATH_INVALID' })
    await expect(handler('project:import-legacy-copy')(sender, `selected:${legacyRoot}`, undefined))
      .resolves.toEqual({ state: 'blocked', code: 'LEGACY_IMPORT_PATH_INVALID' })

    expect(mocks.importLegacyProjectCopy).not.toHaveBeenCalled()
  })

  it('does not consume the grant when the user cancels the confirmation', async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 })

    await expect(handler('project:import-legacy-copy')(sender, `selected:${legacyRoot}`, 'restore-target-grant'))
      .resolves.toEqual({ state: 'cancelled' })

    expect(mocks.resolveExactPath).not.toHaveBeenCalled()
    expect(mocks.importLegacyProjectCopy).not.toHaveBeenCalled()
  })
})

// #702：强杀书童后马上重开，旧进程还没拆掉 project.db-shm 的映射段，SQLite 首个连接截断它时报这个错。
const shmStillMapped = () => Object.assign(new Error('disk I/O error'), { name: 'SqliteError', code: 'SQLITE_IOERR_TRUNCATE' })

describe('project:open：作品文件暂时被占用（#702）', () => {
  it('worker 校验撞上旧进程还没放开的映射段，等它放开后照常打开', async () => {
    mocks.verifyCanonicalProjectData
      .mockRejectedValueOnce(shmStillMapped())
      .mockRejectedValueOnce(shmStillMapped())

    const result = await handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'open-B-mapped', projectA)

    expect(result).toMatchObject({ success: true, activeProjectPath: projectB })
    expect(mocks.initCalls).toEqual([projectB])
  })

  it('主进程连接撞上映射段：等待时旧书照常开着，放开后换库打开', async () => {
    const init = vi.mocked(initProjectDatabase)
    let openDuringWait: string | undefined
    init.mockImplementationOnce(() => {
      mocks.currentProjectPath = ''
      setTimeout(() => { openDuringWait = mocks.currentProjectPath }, 0)
      throw shmStillMapped()
    })

    const result = await handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'open-B-mapped-main', projectA)

    expect(openDuringWait).toBe(projectA)
    expect(result).toMatchObject({ success: true, activeProjectPath: projectB })
  })

  it('一直被占用：约 3 秒后放弃，旧书原样开着，报登记的码而不是 SqliteError 原文', async () => {
    vi.useFakeTimers()
    try {
      mocks.verifyCanonicalProjectData.mockRejectedValue(shmStillMapped())
      const opening = handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'open-B-held', projectA)
      await vi.advanceTimersByTimeAsync(2_500)
      let settled = false
      void opening.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      await vi.runAllTimersAsync()
      const result = await opening as { error: string }

      expect(result).toMatchObject({ success: false, activeProjectPath: projectA, dbReady: true, errorCode: 'PROJECT_OPEN_FILES_BUSY' })
      expect(appErrorMessage(shown('zh-CN'), result)).not.toMatch(/SqliteError|disk I\/O/u)
      expect(mocks.initCalls).toEqual([])
    } finally { vi.useRealTimers() }
  })

  it('一直被占用期间改点另一本书：这次马上作废、不再起校验，新书不用等满 3 秒', async () => {
    mocks.verifyCanonicalProjectData.mockImplementation(async (projectPath: string) => {
      if (projectPath === projectB) throw shmStillMapped()
      return { verifiedIn: 'worker', projectPath }
    })
    const started = Date.now()
    const older = handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'open-B-held-superseded', projectA)
    await new Promise(resolve => setTimeout(resolve, 100))
    const probesBeforeSwitch = mocks.verifyCanonicalProjectData.mock.calls.length
    const newer = handler('project:open')({ sender: { id: 17 } }, selectedProject(projectD), 'open-D-while-B-held', projectA)

    await expect(older).resolves.toMatchObject({ success: false, stale: true, activeProjectPath: projectA, dbReady: true })
    await expect(newer).resolves.toMatchObject({ success: true, activeProjectPath: projectD })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(mocks.verifyCanonicalProjectData.mock.calls.filter(([p]) => p === projectB)).toHaveLength(probesBeforeSwitch)
  })

  it('主进程连接一直被占用、已回到旧书时改点另一本书：作废结果报旧书开着', async () => {
    const init = vi.mocked(initProjectDatabase)
    const real = init.getMockImplementation()!
    init.mockImplementation((projectPath, verified) => {
      if (path.resolve(projectPath) !== projectB) return real(projectPath, verified)
      mocks.initCalls.push(projectB)
      mocks.currentProjectPath = ''
      throw shmStillMapped()
    })
    try {
      const started = Date.now()
      const older = handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'open-B-main-held-superseded', projectA)
      await new Promise(resolve => setTimeout(resolve, 100))
      const connectsBeforeSwitch = mocks.initCalls.filter(p => p === projectB).length
      const probesBeforeSwitch = mocks.verifyCanonicalProjectData.mock.calls.filter(([p]) => p === projectB).length
      const newer = handler('project:open')({ sender: { id: 17 } }, selectedProject(projectD), 'open-D-while-B-main-held', projectA)

      await expect(older).resolves.toMatchObject({ success: false, stale: true, activeProjectPath: projectA, dbReady: true })
      await expect(newer).resolves.toMatchObject({ success: true, activeProjectPath: projectD })
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(mocks.initCalls.filter(p => p === projectB)).toHaveLength(connectsBeforeSwitch)
      expect(mocks.verifyCanonicalProjectData.mock.calls.filter(([p]) => p === projectB)).toHaveLength(probesBeforeSwitch)
    } finally { init.mockImplementation(real) }
  })

  it('别的磁盘读写错误不重试，报「没能读取作品文件」的码', async () => {
    mocks.verifyCanonicalProjectData.mockRejectedValueOnce(Object.assign(new Error('disk I/O error'), { name: 'SqliteError', code: 'SQLITE_IOERR_READ' }))

    const result = await handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), 'open-B-ioerr', projectA)

    expect(result).toMatchObject({ success: false, activeProjectPath: projectA, errorCode: 'PROJECT_OPEN_IO_FAILED' })
    expect(mocks.verifyCanonicalProjectData).toHaveBeenCalledOnce()
  })
})

const systemError = (name: string, code: string, message: string) => Object.assign(new Error(message), { name, code })
const RAW_SYSTEM_TEXT = /SqliteError|malformed|not a database|EBUSY|EPERM|EACCES|SQLITE_|PROJECT_|novels|resource busy|not permitted|rollback|回滚|cannot/u

describe('project:open：作品文件坏了、被占用或没有权限时，说真正的原因和办法（#702）', () => {
  const openFailing = async (error: Error) => {
    mocks.verifyCanonicalProjectData.mockRejectedValueOnce(error)
    return handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), `open-B-${error.message}`, projectA)
  }
  // 与 project-store 一样：带 errorCode 时按整个结果说明，否则按 error。
  const explain = (shownResult: unknown) => {
    const result = shownResult as { errorCode?: string, error?: string }
    const failure = result.errorCode ? result : result.error
    return {
      zh: projectOpenFailureMessage(shown('zh-CN'), failure, '灯塔'),
      en: projectOpenFailureMessage(shown('en-US'), failure, '灯塔'),
      ja: projectOpenFailureMessage(shown('ja-JP'), failure, '灯塔'),
    }
  }

  it.each([
    systemError('SqliteError', 'SQLITE_CORRUPT', 'database disk image is malformed'),
    systemError('SqliteError', 'SQLITE_NOTADB', 'file is not a database'),
  ])('作品库损坏（$code）：说作品文件损坏，指向「从本地存档恢复副本」', async (error) => {
    const result = await openFailing(error)

    expect(result).toMatchObject({ success: false, activeProjectPath: projectA, dbReady: true })
    const { zh, en, ja } = explain(result)
    expect(zh).toMatch(/损坏[\s\S]*「项目备份」[\s\S]*「从本地存档恢复副本」/u)
    expect(en).toMatch(/damaged[\s\S]*Project backup[\s\S]*Restore a copy from local archive/u)
    expect(ja).toMatch(/破損[\s\S]*「Project backup」[\s\S]*「ローカルアーカイブからコピーを復元」/u)
    for (const shownText of [zh, en, ja]) expect(shownText).not.toMatch(RAW_SYSTEM_TEXT)
  })

  it.each([
    systemError('Error', 'EBUSY', `EBUSY: resource busy or locked, open '${projectB}\\.ai-novel\\project.db'`),
    systemError('Error', 'EBUSY', 'EBUSY: resource busy or locked, read'),
  ])('作品库被别的程序占住：说被占用，稍等再点「打开《书名》」', async (error) => {
    const { zh, en, ja } = explain(await openFailing(error))

    expect(zh).toMatch(/别的程序[\s\S]*稍等几秒，再点「打开《灯塔》」/u)
    expect(en).toMatch(/Another program[\s\S]*Open “灯塔”/u)
    expect(ja).toMatch(/別のプログラム[\s\S]*「Open “灯塔”」/u)
    for (const shownText of [zh, en, ja]) expect(shownText).not.toMatch(RAW_SYSTEM_TEXT)
  })

  it.each([
    systemError('Error', 'EPERM', `EPERM: operation not permitted, open '${projectB}\\.ai-novel\\project.db'`),
    systemError('Error', 'EACCES', `EACCES: permission denied, open '${projectB}/.ai-novel/project.db'`),
  ])('没有权限读作品文件（$code）：说没有权限，检查权限或换个位置', async (error) => {
    const { zh, en, ja } = explain(await openFailing(error))

    expect(zh).toMatch(/没有权限[\s\S]*文件夹的权限[\s\S]*位置/u)
    expect(en).toMatch(/permission[\s\S]*folder[\s\S]*location/u)
    expect(ja).toMatch(/権限[\s\S]*フォルダー/u)
    for (const shownText of [zh, en, ja]) expect(shownText).not.toMatch(RAW_SYSTEM_TEXT)
  })

  it.each([
    systemError('SqliteError', 'SQLITE_READONLY', 'attempt to write a readonly database'),
    systemError('SqliteError', 'SQLITE_READONLY_DIRECTORY', 'attempt to write a readonly database'),
  ])('别的程序复制作品库时不让写（$code）：说被占用，稍等再点「打开《书名》」', async (error) => {
    mocks.verifyCanonicalProjectData.mockResolvedValueOnce({ verifiedIn: 'worker', projectPath: projectB })
    vi.mocked(initProjectDatabase).mockImplementationOnce(() => {
      mocks.currentProjectPath = ''
      throw error
    })

    const result = await handler('project:open')({ sender: { id: 17 } }, selectedProject(projectB), `open-B-${error.code}`, projectA)

    expect(result).toMatchObject({ success: false, activeProjectPath: projectA, dbReady: true })
    const { zh, en, ja } = explain(result)
    expect(zh).toMatch(/别的程序[\s\S]*稍等几秒，再点「打开《灯塔》」/u)
    expect(en).toMatch(/Another program[\s\S]*Open “灯塔”/u)
    expect(ja).toMatch(/別のプログラム[\s\S]*「Open “灯塔”」/u)
    for (const shownText of [zh, en, ja]) {
      expect(shownText).not.toMatch(RAW_SYSTEM_TEXT)
      expect(shownText).not.toMatch(/没有受影响|没有改动|not affected|影響はありません/u)
    }
  })

  it('打开失败后原来那本书也没能恢复：只说打开失败的原因，不拼回滚的原文', async () => {
    mocks.failInitPaths.add(projectA)
    mocks.verifyCanonicalProjectData.mockResolvedValueOnce({ verifiedIn: 'worker', projectPath: projectD })
    vi.mocked(initProjectDatabase).mockImplementationOnce(() => {
      mocks.currentProjectPath = ''
      throw systemError('SqliteError', 'SQLITE_CORRUPT', 'database disk image is malformed')
    })

    const result = await handler('project:open')({ sender: { id: 17 } }, selectedProject(projectD), 'open-D-corrupt-no-rollback', projectA)

    expect(result).toMatchObject({ success: false, databaseRestored: false, dbReady: false })
    const { zh, en, ja } = explain(result)
    expect(zh).toMatch(/损坏/u)
    for (const shownText of [zh, en, ja]) expect(shownText).not.toMatch(RAW_SYSTEM_TEXT)
  })
})

const RAW_CREATE_DELETE_TEXT = /SqliteError|EBUSY|EPERM|EACCES|SQLITE_|PROJECT_|resource busy|not permitted|disk I\/O|rollback|回滚|cannot|[A-Z]:[\\/]/u

describe('新建、删除作品失败时，说真正的原因和办法，不露码和英文（#702）', () => {
  const createBook = (token: string, rendererProjectPath: string | null = projectA) => handler('project:create')(
    { sender: { id: 17 } },
    { name: 'C', parentGrantId: `selected:${path.resolve('C:/projects')}`, genre: 'fantasy', targetAudience: 'all' },
    token,
    rendererProjectPath,
  ) as Promise<{ success: boolean, error?: string, databaseRestored?: boolean }>
  const deleteBook = () => handler('project:delete')({}, projectA, 'project-A', 'lease-project-A', projectSession()) as
    Promise<{ success: boolean, error?: string, warning?: string, databaseRestored?: boolean }>
  const explain = (error: unknown) => ({
    zh: appErrorMessage(shown('zh-CN'), error),
    en: appErrorMessage(shown('en-US'), error),
    ja: appErrorMessage(shown('ja-JP'), error),
  })

  it.each([
    systemError('Error', 'EPERM', `EPERM: operation not permitted, mkdir '${projectC}'`),
    systemError('Error', 'EACCES', `EACCES: permission denied, mkdir '${projectC}'`),
  ])('所选位置没有写权限（$code）：说没有权限，换一个保存位置', async (error) => {
    mocks.projectAccess.createProject.mockImplementationOnce(() => { throw error })

    const result = await createBook(`create-denied-${error.message}`)

    expect(result).toMatchObject({ success: false, databaseRestored: true })
    const { zh, en, ja } = explain(result.error)
    expect(zh).toMatch(/没有权限[\s\S]*换一个保存位置/u)
    expect(en).toMatch(/permission[\s\S]*another location/u)
    expect(ja).toMatch(/権限[\s\S]*保存場所/u)
    for (const shownText of [zh, en, ja]) expect(shownText).not.toMatch(RAW_CREATE_DELETE_TEXT)
  })

  it('建库时读写出错：说这次没能新建，换个名称或保存位置再试（文件夹可能已留下）', async () => {
    vi.mocked(createProjectDatabase).mockImplementationOnce(() => {
      throw systemError('SqliteError', 'SQLITE_IOERR_WRITE', 'disk I/O error')
    })

    const result = await createBook('create-io-failed')

    expect(result).toMatchObject({ success: false, databaseRestored: true })
    const { zh, en, ja } = explain(result.error)
    expect(zh).toMatch(/没能新建作品[\s\S]*换一个作品名称或保存位置/u)
    expect(en).toMatch(/could not be created[\s\S]*another (book )?name or location/iu)
    expect(ja).toMatch(/作成できません[\s\S]*作品名か保存場所/u)
    for (const shownText of [zh, en, ja]) expect(shownText).not.toMatch(RAW_CREATE_DELETE_TEXT)
  })

  it('新建失败后原来那本书也没能恢复：只说新建失败的原因，不拼回滚的原文', async () => {
    mocks.projectCoreUpdate.mockImplementationOnce(() => {
      throw systemError('SqliteError', 'SQLITE_IOERR_WRITE', 'disk I/O error')
    })
    mocks.failInitPaths.add(projectA)

    const result = await createBook('create-fail-no-rollback')

    expect(result).toMatchObject({ success: false, databaseRestored: false, dbReady: false })
    const { zh, en, ja } = explain(result.error)
    expect(zh).toMatch(/没能新建作品/u)
    for (const shownText of [zh, en, ja]) expect(shownText).not.toMatch(RAW_CREATE_DELETE_TEXT)
  })

  it('作品文件夹里有文件被别的程序占着、没删完：说没删完和原因，不露路径和英文原文', async () => {
    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce(() => {
      throw systemError('Error', 'EBUSY', `EBUSY: resource busy or locked, unlink '${path.join(projectA, '人物小传.docx')}'`)
    })

    const result = await deleteBook()

    expect(result).toMatchObject({ success: false, directoryDeleted: false, databaseRestored: true })
    const { zh, en, ja } = explain(result.error)
    expect(zh).toMatch(/没删完[\s\S]*别的程序/u)
    expect(en).toMatch(/not fully deleted[\s\S]*another program/u)
    expect(ja).toMatch(/別のプログラム[\s\S]*削除しきれ/u)
    for (const shownText of [zh, en, ja]) expect(shownText).not.toMatch(RAW_CREATE_DELETE_TEXT)
  })

  it.runIf(process.platform === 'win32')('作品库被别的程序开着：几秒内就告诉作者被占用，不让作者干等', async () => {
    const { removeDirectoryWithWindowsRetry } = await vi.importActual<typeof import('../../utils/remove-directory')>('../../utils/remove-directory')
    const root = await mkdtemp(path.join(os.tmpdir(), 'delete-busy-'))
    await mkdir(path.join(root, '.ai-novel'))
    await writeFile(path.join(root, '正文.md'), '第一章')
    const otherProgram = new BetterSqlite(path.join(root, '.ai-novel', 'project.db'))
    otherProgram.exec('create table chapters (body text)')
    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce(() => removeDirectoryWithWindowsRetry(root))
    try {
      const started = performance.now()
      const result = await deleteBook()
      const waitedSeconds = (performance.now() - started) / 1000

      expect(waitedSeconds).toBeLessThan(5)
      expect(result).toMatchObject({ success: false, directoryDeleted: false })
      const { zh, en, ja } = explain(result.error)
      expect(zh).toMatch(/没删完[\s\S]*别的程序/u)
      expect(en).toMatch(/not fully deleted[\s\S]*another program/u)
      expect(ja).toMatch(/別のプログラム[\s\S]*削除しきれ/u)
    } finally {
      otherProgram.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    systemError('Error', 'EPERM', `EPERM: operation not permitted, unlink '${path.join(projectA, '.ai-novel', 'project.db')}'`),
    systemError('Error', 'EACCES', `EACCES: permission denied, rmdir '${projectA}'`),
  ])('没有删除权限（$code）、没删完：说没有删除权限，检查文件夹权限', async (error) => {
    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce(() => { throw error })

    const result = await deleteBook()

    expect(result).toMatchObject({ success: false, directoryDeleted: false, databaseRestored: true })
    const { zh, en, ja } = explain(result.error)
    expect(zh).toMatch(/没删完[\s\S]*没有删除[\s\S]*权限/u)
    expect(en).toMatch(/not fully deleted[\s\S]*no permission[\s\S]*permissions/u)
    expect(ja).toMatch(/権限がない[\s\S]*削除しきれ/u)
    for (const shownText of [zh, en, ja]) expect(shownText).not.toMatch(RAW_CREATE_DELETE_TEXT)
  })

  it.each([
    ['EIO', () => { throw systemError('Error', 'EIO', `EIO: i/o error, unlink '${path.join(projectA, '人物小传.docx')}'`) }],
    ['EROFS', () => { throw systemError('Error', 'EROFS', `EROFS: read-only file system, unlink '${path.join(projectA, '人物小传.docx')}'`) }],
    ['ENOTEMPTY', () => { throw systemError('Error', 'ENOTEMPTY', `ENOTEMPTY: directory not empty, rmdir '${projectA}'`) }],
    ['没有报错但文件夹还在', () => undefined],
  ])('没删完、原因没查明（%s）：只说没删完，不说被别的程序占用或没有权限', async (_label, removeDirectory) => {
    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce(removeDirectory)

    const result = await deleteBook()

    expect(result).toMatchObject({ success: false, directoryDeleted: false, databaseRestored: true })
    const { zh, en, ja } = explain(result.error)
    expect(zh).toMatch(/没删完/u)
    expect(en).toMatch(/not fully deleted/u)
    expect(ja).toMatch(/削除しきれ/u)
    expect(zh).not.toMatch(/别的程序|占用|权限/u)
    expect(en).not.toMatch(/another program|permission/iu)
    expect(ja).not.toMatch(/別のプログラム|権限/u)
    for (const shownText of [zh, en, ja]) expect(shownText).not.toMatch(RAW_CREATE_DELETE_TEXT)
  })

  it('没删完、原来的书也没能恢复：只说没删完，不拼恢复失败的原文', async () => {
    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce(() => {
      throw systemError('Error', 'EBUSY', `EBUSY: resource busy or locked, unlink '${path.join(projectA, '人物小传.docx')}'`)
    })
    mocks.failInitPaths.add(projectA)

    const result = await deleteBook()

    expect(result).toMatchObject({ success: false, directoryDeleted: false, databaseRestored: false })
    const { zh, en, ja } = explain(result.error)
    expect(zh).toMatch(/没删完/u)
    for (const shownText of [zh, en, ja]) expect(shownText).not.toMatch(RAW_CREATE_DELETE_TEXT)
  })

  it('作品已删掉、只是最近项目列表没更新：提示里不带英文原文', async () => {
    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce((target: string) => {
      mocks.existingPaths.delete(path.resolve(target))
    })
    mocks.writeJsonFile.mockImplementationOnce(() => {
      throw systemError('Error', 'EPERM', `EPERM: operation not permitted, open 'C:/Users/a/recent-projects.json'`)
    })

    const result = await deleteBook()

    expect(result).toMatchObject({ success: true, directoryDeleted: true })
    expect(displayedErrorMessage(shown('zh-CN'), result.warning!)).toMatch(/最近项目/u)
    expect(displayedErrorMessage(shown('zh-CN'), result.warning!)).not.toMatch(RAW_CREATE_DELETE_TEXT)
  })
})

type ProjectResult = { success: boolean, error?: string, errorCode?: string, warning?: string, failure?: Parameters<typeof failureText>[1] }

const received = async (raw: unknown) => receivedIpcResult(await raw) as ProjectResult
const projectFailure = (result: ProjectResult) => resultFailure(result) ?? (result.errorCode ? result : result.error)
const LOCALES = ['zh-CN', 'en-US'] as const

describe('作品与备份控制器失败时作者看不到主进程原文', () => {
  it('保存作品设置时 SQLite 报错：作者看到的说明里没有原文', async () => {
    mocks.projectCoreUpdate.mockImplementationOnce(() => { throw systemError('SqliteError', 'SQLITE_CORRUPT', 'database disk image is malformed') })
    const result = await received(handler('project:save')({}, 'project-A', { path: projectA, characterStates: 'x' }, projectA, projectSession()))

    expect(result.success).toBe(false)
    const failure = resultFailure(result)
    for (const locale of LOCALES) {
      const text = failure ? failureText(shown(locale), failure) : appErrorMessage(shown(locale), result.error)
      expect(text).not.toMatch(/SqliteError|malformed|SQLITE_/u)
    }
  })

  it('日文界面：删除作品后两条提醒说日文', async () => {
    registerProjectController({ removeDeletedProjectBinding: () => { throw new Error('binding store locked') } })
    mocks.systemLocale = 'ja-JP'
    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce((target: string) => { mocks.existingPaths.delete(path.resolve(target)) })
    mocks.writeJsonFile.mockImplementationOnce(() => { throw new Error('recent list locked') })
    try {
      const result = await received(handler('project:delete')({}, projectA, 'project-A', 'lease-project-A', projectSession()))
      expect(result).toMatchObject({ success: true, directoryDeleted: true })
      expect(displayedErrorMessage(shown('ja-JP'), result.warning)).toMatch(/[\p{Script=Hiragana}\p{Script=Katakana}]/u)
    } finally {
      registerProjectController()
    }
  })
})

describe('作品、归档、更新与云备份失败的说明与 master 逐字相同', () => {
  const createBook = (token: string) => handler('project:create')(
    { sender: { id: 17 } },
    { name: 'C', parentGrantId: `selected:${path.resolve('C:/projects')}`, genre: 'fantasy', targetAudience: 'all' },
    token,
    projectA,
  )
  const deleteBook = () => handler('project:delete')({}, projectA, 'project-A', 'lease-project-A', projectSession())

  it.each(LOCALES)('%s', async locale => {
    const shownText: Record<string, string> = {}

    mocks.verifyCanonicalProjectData.mockResolvedValueOnce({ verifiedIn: 'worker', projectPath: projectD })
    vi.mocked(initProjectDatabase).mockImplementationOnce(() => { throw new Error('cannot open the book for an unknown reason') })
    shownText.openUnknown = projectOpenFailureMessage(shown(locale), projectFailure(await received(
      handler('project:open')({ sender: { id: 17 } }, selectedProject(projectD), `open-unknown-${locale}`, projectA))))

    mocks.projectAccess.createProject.mockImplementationOnce(() => { throw systemError('Error', 'EPERM', 'EPERM: operation not permitted') })
    const created = await received(createBook(`create-denied-${locale}`))
    shownText.createDenied = created.failure ? failureText(shown(locale), created.failure) : appErrorMessage(shown(locale), projectFailure(created))

    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce(() => { throw systemError('Error', 'EBUSY', 'EBUSY: resource busy or locked') })
    shownText.deleteBusy = projectDeleteFailureMessage(shown(locale), projectFailure(await received(deleteBook())))

    mocks.projectAccess.authorizeDeletion.mockImplementationOnce(() => { throw new Error('PROJECT_DELETE_TARGET_MISMATCH') })
    shownText.deleteTargetMismatch = projectDeleteFailureMessage(shown(locale), projectFailure(await received(deleteBook())))

    shownText.saveWithoutPath = appErrorMessage(shown(locale), projectFailure(await received(handler('project:save')({}, 'project-A', {}, projectA, projectSession()))))

    mocks.storedLocale = locale
    registerProjectController({ removeDeletedProjectBinding: () => { throw new Error('binding store locked') } })
    mocks.removeDirectoryWithWindowsRetry.mockImplementationOnce((target: string) => { mocks.existingPaths.delete(path.resolve(target)) })
    mocks.writeJsonFile.mockImplementationOnce(() => { throw new Error('recent list locked') })
    try {
      shownText.deleteWarnings = displayedErrorMessage(shown(locale), (await received(deleteBook())).warning)
    } finally {
      registerProjectController()
    }

    expect(shownText).toMatchSnapshot()
  })
})
