/**
 * Git 作品同步的跨进程契约。
 *
 * 数据模型是「一个书库仓库 + 多本书」：
 *   书库根目录（.git 在这里）
 *     └─ 书名A/  ← 一本作品的根（内含 .ai-novel/）
 *     └─ 书名B/
 * 一本书仍然是它自己的项目根，书库只是在外面套了一层，用来一次管多本。
 * 路径、token、git 命令都不进渲染进程。
 */

/** 支持的托管站：都走「个人访问令牌 + REST」，不需要浏览器跳转。 */
export type GitSyncHost = 'github' | 'gitee'

export interface GitSyncProjectSessionContext {
  projectId: string
  leaseId: string
  projectPath: string
}

export type GitSyncErrorCode =
  | 'GIT_SYNC_INPUT_INVALID'
  | 'GIT_SYNC_PROJECT_REQUIRED'
  | 'GIT_SYNC_NOT_CONFIGURED'
  | 'GIT_SYNC_GIT_MISSING'
  | 'GIT_SYNC_NOT_INITIALIZED'
  | 'GIT_SYNC_URL_INVALID'
  | 'GIT_SYNC_CREDENTIAL_UNAVAILABLE'
  | 'GIT_SYNC_AUTH_FAILED'
  | 'GIT_SYNC_NETWORK_FAILED'
  | 'GIT_SYNC_REMOTE_EMPTY'
  | 'GIT_SYNC_REMOTE_INVALID'
  | 'GIT_SYNC_LOCAL_CHANGES'
  | 'GIT_SYNC_DIVERGED'
  | 'GIT_SYNC_SAVE_PENDING'
  | 'GIT_SYNC_SNAPSHOT_FAILED'
  | 'GIT_SYNC_SESSION_STALE'
  | 'GIT_SYNC_LIBRARY_MISSING'
  | 'GIT_SYNC_HOST_AUTH_FAILED'
  | 'GIT_SYNC_HOST_NAME_TAKEN'
  | 'GIT_SYNC_HOST_NETWORK_FAILED'
  | 'GIT_SYNC_HOST_FAILED'
  | 'GIT_SYNC_REPO_NOT_EMPTY'
  | 'GIT_SYNC_LIBRARY_AMBIGUOUS'
  | 'GIT_SYNC_BUSY'
  | 'GIT_SYNC_TIMEOUT'
  | 'GIT_SYNC_FAILED'

export interface GitSyncFailure {
  success: false
  errorCode: GitSyncErrorCode
  /** 只含 git 的一行摘要，绝不含凭据或完整远端文本 */
  detail?: string
  /**
   * 这次失败之前，主进程有没有关掉作品数据库。
   * 有就必须让界面重开作品，否则蓝图、章节都会是空的——
   * 界面不能靠 success 猜这件事：失败也可能发生在关库之后。
   */
  databaseClosed?: boolean
}

export interface GitSyncCommitView {
  sha: string
  subject: string
  committedAt: string
}

/** 书库里的一本书：以「书库根下的相对目录」标识，跨机器稳定。 */
export interface GitSyncBookView {
  /** 书库根下的相对路径，用 / 分隔，例如 「世界都是我的试验品」 */
  relativePath: string
  name: string
  /** 这本书在本机是否有未提交的改动 */
  changed: boolean
  /** 是不是当前打开的那本 */
  current: boolean
}

export interface GitSyncConfigView {
  /** 远端仓库地址（HTTPS），未配置为 null */
  remoteUrl: string | null
  /** 托管站；没配置时为 null */
  host: GitSyncHost | null
  branch: string
  /** 本机是否保存了可用的访问凭据（token 本身永不返回） */
  hasCredential: boolean
  credentialPersistence: 'os-backed' | 'session-only' | 'none'
  authorName: string
  /** 书库根目录（就是这台电脑上放所有作品的那个文件夹） */
  libraryPath: string | null
}

export interface GitSyncStatusView {
  initialized: boolean
  hasRemote: boolean
  branch: string
  /** 书库里已纳管的作品数 */
  bookCount: number
  /** 有未提交改动的作品数 */
  changedBooks: number
  /** 未提交的文件总数（全部作品合计） */
  pendingFiles: number
  ahead: number | null
  behind: number | null
  diverged: boolean
  lastCommit: GitSyncCommitView | null
  databaseOpen: boolean
  books: GitSyncBookView[]
}

export interface GitSyncViewResult {
  success: true
  config: GitSyncConfigView
  status: GitSyncStatusView
}

export interface GitSyncConfigureRequest {
  /** 当前作品（用于定位书库：作品的上一级目录） */
  projectSession: GitSyncProjectSessionContext
  remoteUrl: string
  branch?: string
  username: string
  /** 留空表示沿用本机已保存的 token */
  token?: string
}

/** 新电脑上：只给 token，自动识别账号、建私有仓库、接上书库。 */
export interface GitSyncCreateRepositoryRequest {
  projectSession: GitSyncProjectSessionContext
  host: GitSyncHost
  token: string
  /** 仓库名；留空按「作品所在书库文件夹名」生成 */
  repositoryName?: string
  /** 指定要连接的已有仓库（fullName）；不给就自动挑最像备份仓库的那个 */
  existingRepository?: string
  /** 明确要求「不要复用，强制新建」 */
  forceCreate?: boolean
}

export interface GitSyncCreateRepositoryResult {
  success: true
  repositoryUrl: string
  fullName: string
  /** 自动识别到的账号 */
  username: string
  /** 仓库里是否已有内容（本地书库非空而远端为空时才算「可上传」） */
  remoteEmpty: boolean
  /** reused = 账号下已有书童备份仓库，直接接上；created = 这次新建的 */
  action: 'reused' | 'created'
  /** 账号下发现的其他书童备份仓库，供作者改选 */
  otherCandidates: Array<{ fullName: string; cloneUrl: string; updatedAt: string }>
}

export interface GitSyncUploadRequest {
  projectSession: GitSyncProjectSessionContext
}

export interface GitSyncDownloadRequest {
  projectSession: GitSyncProjectSessionContext
}

export interface GitSyncUploadBookResult {
  relativePath: string
  committed: boolean
  /** 这次上传是否真的动了这本书（没有改动就跳过） */
  uploaded: boolean
}

export interface GitSyncUploadResult {
  success: true
  state: 'uploaded' | 'partial' | 'up-to-date'
  /** 这次推送的提交（没有新提交时为 null） */
  commit: GitSyncCommitView | null
  /** 逐本结果：只列出真正有改动、被提交的书 */
  books: GitSyncUploadBookResult[]
  /** 因为数据库还开着（不是当前打开的书）而跳过的书 */
  skippedOpen: string[]
}

export interface GitSyncDownloadResult {
  success: true
  state: 'updated' | 'up-to-date'
  commit: GitSyncCommitView | null
  /** 拉取后本地发生变化、需要重新打开的书 */
  changedBooks: string[]
  /** 分叉自动对齐时，本机保留 / 采用远端 的作品 */
  keptLocal?: string[]
  tookRemote?: string[]
  /** 「以远端为准」时，本机此前的提交存到了哪个备份分支（可从 git 找回） */
  backupRef?: string | null
}

/** 拉取时怎么处理分叉：默认 fast-forward，给了方向就强制对齐。 */
export type GitSyncResolveStrategy = 'local' | 'remote'

export interface GitSyncResolveRequest {
  projectSession: GitSyncProjectSessionContext
  strategy: GitSyncResolveStrategy
}

export interface GitSyncResolveResult {
  success: true
  state: 'aligned' | 'up-to-date'
  commit: GitSyncCommitView | null
  /** 本机这一版保留的作品 */
  keptLocal: string[]
  /** 采用远端那一版的作品 */
  tookRemote: string[]
  /** 以远端为准时，本机原提交存成的备份分支 */
  backupRef: string | null
}

export interface GitSyncChannels {
  'git-sync:view': {
    args: [projectSession: GitSyncProjectSessionContext]
    return: GitSyncViewResult | GitSyncFailure
  }
  'git-sync:configure': {
    args: [request: GitSyncConfigureRequest]
    return: { success: true; config: GitSyncConfigView } | GitSyncFailure
  }
  'git-sync:create-repository': {
    args: [request: GitSyncCreateRepositoryRequest]
    return: GitSyncCreateRepositoryResult | GitSyncFailure
  }
  'git-sync:upload': {
    args: [request: GitSyncUploadRequest]
    return: GitSyncUploadResult | GitSyncFailure
  }
  'git-sync:download': {
    args: [request: GitSyncDownloadRequest]
    return: GitSyncDownloadResult | GitSyncFailure
  }
  'git-sync:resolve-diverged': {
    args: [request: GitSyncResolveRequest]
    return: GitSyncResolveResult | GitSyncFailure
  }
  'git-sync:forget-credential': {
    args: [projectSession: GitSyncProjectSessionContext]
    return: { success: true; config: GitSyncConfigView } | GitSyncFailure
  }
}
