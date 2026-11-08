import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, CloudCog, RefreshCw } from 'lucide-react'

import { displayedErrorMessage } from '../../../i18n/app-errors'
import { ipc } from '../../../services/ipc-client'
import type {
  GitSyncConfigView,
  GitSyncFailure,
  GitSyncHost,
  GitSyncStatusView,
} from '../../../shared/git-sync'
import { projectSessionContextFromProject } from '../../../shared/project-session-context'
import { useLocaleStore } from '../../../stores/locale-store'
import { saveDirtyEditorChangesForExit } from '../../../stores/editor-store'
import { useProjectStore } from '../../../stores/project-store'
import { actionToast } from '../../ui/ActionToast'
import { Button } from '../../ui/Button'

type Notice = { kind: 'error' | 'success' | 'info'; text: string } | null

const errorText = (error: unknown) => displayedErrorMessage(useLocaleStore.getState().locale, error)

function commitLabel(sha: string | undefined, subject: string | undefined): string {
  if (!sha) return ''
  return `${sha.slice(0, 7)} · ${subject ?? ''}`
}

/**
 * 作品同步：把作品文件夹接到一个私有 git 仓库，用「上传进度 / 拉取最新」两个按钮
 * 在两台电脑之间交接。刻意不做实时同步：书童的库是 SQLite + 向量目录，没有跨机锁，
 * 两个写入者会互相破坏，所以这里只保证「一台在写、显式交接」。
 */
export default function GitSyncSection() {
  const project = useProjectStore(s => s.currentProject)
  const projectSession = projectSessionContextFromProject(project)
  // 换作品/换会话就换一个新的子组件：本地输入与读数一起重置，不在 effect 里改 state。
  const sessionKey = projectSession ? `${projectSession.projectId}\0${projectSession.leaseId}` : 'none'
  return <GitSyncSectionSession key={sessionKey} project={project} projectSession={projectSession} />
}

function GitSyncSectionSession({
  project,
  projectSession,
}: {
  project: ReturnType<typeof useProjectStore.getState>['currentProject']
  projectSession: ReturnType<typeof projectSessionContextFromProject>
}) {
  const text = useLocaleStore(s => s.text)
  const openProject = useProjectStore(s => s.openProject)
  const [config, setConfig] = useState<GitSyncConfigView | null>(null)
  const [status, setStatus] = useState<GitSyncStatusView | null>(null)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [username, setUsername] = useState('')
  const [token, setToken] = useState('')
  const [branch, setBranch] = useState('main')
  const [host, setHost] = useState<GitSyncHost>('github')
  const [repositoryName, setRepositoryName] = useState('')
  const [candidates, setCandidates] = useState<Array<{ fullName: string; cloneUrl: string; updatedAt: string }>>([])
  const [busy, setBusy] = useState<null | 'view' | 'configure' | 'upload' | 'download'>(null)
  // 这次动作有没有真的让主进程关掉数据库：决定结束后要不要重开作品。
  const closedDatabase = useRef(false)
  const [notice, setNotice] = useState<Notice>(null)
  const mounted = useRef(true)

  useEffect(() => () => { mounted.current = false }, [])

  const applyView = useCallback((result: { config: GitSyncConfigView; status: GitSyncStatusView }) => {
    setConfig(result.config)
    setStatus(result.status)
    setRemoteUrl(current => current || result.config.remoteUrl || '')
    setBranch(result.config.branch || 'main')
    setUsername(current => current || result.config.authorName || '')
  }, [])

  const refresh = useCallback(async () => {
    if (!projectSession) return
    setBusy('view')
    try {
      const result = await ipc.invoke('git-sync:view', projectSession)
      if (!mounted.current) return
      if (!result.success) {
        setNotice({ kind: 'error', text: errorText(result.errorCode) })
        return
      }
      applyView(result)
    } catch (error) {
      if (mounted.current) setNotice({ kind: 'error', text: errorText(error) })
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [applyView, projectSession])

  // 首次进入这一页时读一次状态：setState 只在 Promise 回调里发生。
  useEffect(() => {
    let active = true
    void ipc.invoke('git-sync:view', projectSession as never).then(result => {
      if (!active) return
      if (!result.success) { setNotice({ kind: 'error', text: errorText(result.errorCode) }); return }
      applyView(result)
    }).catch(error => {
      if (active) setNotice({ kind: 'error', text: errorText(error) })
    })
    return () => { active = false }
    // 同一件作品的一次打开内只读一次；换作品由外层 key 重新挂载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 同步会关掉数据库再重开作品，页内提示会被这次重开冲掉，所以结论一律用通知说。
  const failureNotice = (result: GitSyncFailure) => {
    const base = errorText(result.errorCode)
    const message = result.detail ? `${base}（${result.detail}）` : base
    setNotice({ kind: 'error', text: message })
    actionToast.show({ type: 'error', message, duration: 0 })
  }

  const configure = async () => {
    if (!projectSession) return
    setBusy('configure')
    setNotice(null)
    try {
      const result = await ipc.invoke('git-sync:configure', {
        projectSession,
        remoteUrl: remoteUrl.trim(),
        branch: branch.trim() || 'main',
        username: username.trim(),
        token: token.trim() || undefined,
      })
      if (!result.success) { failureNotice(result); return }
      setToken('')
      setConfig(result.config)
      setNotice({ kind: 'success', text: text('已保存同步设置。', 'Sync settings saved.') })
      await refresh()
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
    } finally {
      setBusy(null)
    }
  }

  /**
   * 新电脑上的一步到位：只填 token → 认出账号 → 建私有仓库 → 接上书库 → 首次上传。
   */
  const createRepository = async (existingRepository?: string) => {
    if (!projectSession) return
    if (!token.trim()) { setNotice({ kind: 'error', text: text('请先填入访问令牌。', 'Enter an access token first.') }); return }
    setBusy('configure')
    setNotice(null)
    try {
      const created = await ipc.invoke('git-sync:create-repository', {
        projectSession,
        host,
        token: token.trim(),
        repositoryName: repositoryName.trim() || undefined,
        existingRepository,
      })
      if (!created.success) { failureNotice(created); return }
      setToken('')
      setUsername(created.username)
      setRemoteUrl(created.repositoryUrl)
      setCandidates(created.otherCandidates)
      const reused = created.action === 'reused'
      const message = reused
        ? text(
          `这个账号下已有书童备份仓库 ${created.fullName}，已直接连上（不会再建一个）。`,
          `This account already has a Pagekin backup repository ${created.fullName}; connected to it instead of creating another.`,
        )
        : text(
          `已新建私有仓库 ${created.fullName}，正在上传…`,
          `Created private repository ${created.fullName}. Uploading…`,
        )
      setNotice({ kind: 'success', text: message })
      actionToast.show({ type: 'success', message })
      await refresh()
      // 接上已有仓库时先拉取（拿回另一端的最新进度），新建仓库才直接上传。
      if (reused) await download()
      else await upload()
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  /**
   * 上传：先把编辑器里没保存的稿子存进库（主进程会在快照前关库），
   * 传完再把作品重新打开——关库会让渲染进程的会话失效。
   */
  const upload = async () => {
    if (!projectSession || !project) return
    setBusy('upload')
    setNotice(null)
    closedDatabase.current = false
    try {
      const saved = await saveOpenDrafts()
      if (!saved) { setNotice({ kind: 'error', text: text('还有未保存的稿件，已取消上传。', 'Some drafts are unsaved, so the upload was cancelled.') }); return }
      const result = await ipc.invoke('git-sync:upload', { projectSession })
      closedDatabase.current = result.success
      if (!result.success) { failureNotice(result); return }
      const uploadedBooks = result.books.filter(book => book.uploaded).map(book => book.relativePath)
      const message = uploadedBooks.length > 0
        ? text(
          `已上传 ${uploadedBooks.length} 本：${uploadedBooks.join('、')}（${commitLabel(result.commit?.sha, result.commit?.subject)}）`,
          `Uploaded ${uploadedBooks.length} book(s): ${uploadedBooks.join(', ')} (${commitLabel(result.commit?.sha, result.commit?.subject)})`,
        )
        : text('所有作品都没有新改动，无需上传。', 'No book has new changes, so nothing was uploaded.')
      setNotice({ kind: 'success', text: message })
      actionToast.show({ type: 'success', message })
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
    } finally {
      if (mounted.current) setBusy(null)
      // 只有真的关过库才需要重开；被拦下的动作没有动过数据库。
      await reopenAfterSync(closedDatabase.current)
    }
  }

  const download = async () => {
    if (!projectSession || !project) return
    setBusy('download')
    setNotice(null)
    closedDatabase.current = false
    try {
      const saved = await saveOpenDrafts()
      if (!saved) { setNotice({ kind: 'error', text: text('还有未保存的稿件，已取消拉取。', 'Some drafts are unsaved, so the pull was cancelled.') }); return }
      const result = await ipc.invoke('git-sync:download', { projectSession })
      closedDatabase.current = result.success
      if (!result.success) { failureNotice(result); return }
      const message = result.state === 'updated'
        ? text(
          `已拉到最新，更新了：${result.changedBooks.join('、') || '（无）'}（${commitLabel(result.commit?.sha, result.commit?.subject)}）`,
          `Pulled the latest; updated: ${result.changedBooks.join(', ') || '(none)'} (${commitLabel(result.commit?.sha, result.commit?.subject)})`,
        )
        : text('本来就是最新，无需拉取。', 'Already up to date; nothing to pull.')
      setNotice({ kind: 'success', text: message })
      actionToast.show({ type: 'success', message })
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
    } finally {
      if (mounted.current) setBusy(null)
      await reopenAfterSync(closedDatabase.current)
    }
  }

  /**
   * 只有主进程真的关过库（成功上传/拉取）才需要重开作品；
   * 被拦下的动作没动数据库，重开只会把作者从设置页弹走。
   */
  const reopenAfterSync = async (closed: boolean) => {
    if (!closed || !project) return
    try {
      await openProject(project.path)
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
    }
  }

  /** 把编辑器里未保存的稿子先落盘，再动数据库。 */
  const saveOpenDrafts = async (): Promise<boolean> => {
    try {
      await saveDirtyEditorChangesForExit(project?.path, 'project')
      return true
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
      return false
    }
  }

  const forgetCredential = async () => {
    if (!projectSession) return
    setBusy('configure')
    try {
      const result = await ipc.invoke('git-sync:forget-credential', projectSession)
      if (!result.success) { failureNotice(result); return }
      setToken('')
      setConfig(result.config)
      setNotice({ kind: 'info', text: text('已清除本机保存的访问令牌。', 'The access token on this computer was cleared.') })
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
    } finally {
      setBusy(null)
    }
  }

  if (!project) {
    return <p className="stage-set-row-desc">{text('请先打开一个作品，再配置同步。', 'Open a book before configuring sync.')}</p>
  }

  const configured = Boolean(config?.remoteUrl) && Boolean(config?.hasCredential)
  const pending = status?.pendingFiles ?? 0
  const diverged = Boolean(status?.diverged)

  return (
    <div className="stage-set-rows">
      <div className="stage-set-row">
        <div>
          <p className="stage-set-row-title">{text('同步位置', 'Sync location')}</p>
          <p className="stage-set-row-desc">{text(
            '作品文件夹会连到一个私有 git 仓库（GitHub / Gitee 的私有仓库）。两台电脑不要同时写，收工上传、开工拉取。',
            'The book folder connects to a private git repository (GitHub or Gitee). Never write on two computers at once: upload when you stop, pull when you start.',
          )}</p>
        </div>
        <div className="stage-set-row-ctl">
          <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={busy !== null}>
            <RefreshCw size={14} aria-hidden="true" />{text('刷新状态', 'Refresh')}
          </Button>
        </div>
      </div>

      <div className="stage-set-row">
        <div>
          <p className="stage-set-row-title">{text('新电脑：用令牌直接建仓库', 'New computer: create a repository from a token')}</p>
          <p className="stage-set-row-desc">{text(
            '不用先去网页上建仓库。选好托管站、填入访问令牌（GitHub 需要 repo 权限），点一下就会建好私有仓库并上传。',
            'No need to create the repository on the website first. Pick a host, paste an access token (repo scope on GitHub), and one click creates the private repository and uploads.',
          )}</p>
        </div>
      </div>
      <div className="stage-set-form">
        <div className="stage-set-field">
          <label htmlFor="git-sync-host">{text('托管站', 'Host')}</label>
          <select id="git-sync-host" className="stage-select" value={host}
            onChange={event => setHost(event.target.value as GitSyncHost)}>
            <option value="github">GitHub</option>
            <option value="gitee">{text('Gitee（码云）', 'Gitee')}</option>
          </select>
        </div>
        <div className="stage-set-field stage-set-field--grow">
          <label htmlFor="git-sync-repo-name">{text('仓库名（留空自动取文件夹名）', 'Repository name (blank = library folder name)')}</label>
          <input id="git-sync-repo-name" className="pi-input" value={repositoryName}
            placeholder={text('例如 pagekin-library', 'e.g. pagekin-library')}
            onChange={event => setRepositoryName(event.target.value)} />
        </div>
      </div>
      <div className="stage-set-foot">
        <Button variant="primary" size="sm" onClick={() => void createRepository()} disabled={busy !== null || !token.trim()}>
          <CloudCog size={14} aria-hidden="true" />
          {busy === 'configure' ? text('正在建仓库…', 'Creating…') : text('建仓库并上传', 'Create repository and upload')}
        </Button>
        <span>{text('会新建一个私有仓库，不会往已有仓库里写。', 'Creates a new private repository; never writes into an existing one.')}</span>
      </div>

      {candidates.length > 0 && (
        <div className="stage-set-row">
          <div>
            <p className="stage-set-row-title">{text('这个账号下的其他备份仓库', 'Other backup repositories on this account')}</p>
            <p className="stage-set-row-desc">{text(
              '如果连上的不是你想要的，点下面任意一个改连过去。',
              'If this is not the one you want, connect to another below.',
            )}</p>
          </div>
          <ul className="stage-set-row-extra" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {candidates.map(candidate => (
              <li key={candidate.fullName} className="stage-set-row-desc" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span>{candidate.fullName}</span>
                <Button variant="text" size="sm" onClick={() => void createRepository(candidate.fullName)} disabled={busy !== null}>
                  {text('连接这个', 'Connect')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="stage-set-row">
        <div>
          <p className="stage-set-row-title">{text('仓库地址', 'Repository URL')}</p>
          <p className="stage-set-row-desc">{text(
            '只接受 https 地址，例如 https://github.com/你的账号/pagekin-novel.git。',
            'HTTPS only, for example https://github.com/your-name/pagekin-novel.git.',
          )}</p>
        </div>
      </div>
      <div className="stage-set-form">
        <div className="stage-set-field stage-set-field--grow">
          <label htmlFor="git-sync-url">{text('仓库地址', 'Repository URL')}</label>
          <input id="git-sync-url" className="pi-input" value={remoteUrl} placeholder="https://github.com/…/pagekin-novel.git"
            onChange={event => setRemoteUrl(event.target.value)} />
        </div>
        <div className="stage-set-field">
          <label htmlFor="git-sync-branch">{text('分支', 'Branch')}</label>
          <input id="git-sync-branch" className="pi-input" value={branch} onChange={event => setBranch(event.target.value)} />
        </div>
      </div>
      <div className="stage-set-form">
        <div className="stage-set-field stage-set-field--grow">
          <label htmlFor="git-sync-user">{text('账号', 'Account')}</label>
          <input id="git-sync-user" className="pi-input" value={username} placeholder={text('GitHub / Gitee 用户名', 'GitHub or Gitee username')}
            onChange={event => setUsername(event.target.value)} />
        </div>
        <div className="stage-set-field stage-set-field--grow">
          <label htmlFor="git-sync-token">{text('访问令牌', 'Access token')}</label>
          <input id="git-sync-token" className="pi-input" type="password" value={token}
            placeholder={config?.hasCredential ? text('已保存，留空则不修改', 'Saved; leave blank to keep it') : text('在这里粘贴访问令牌', 'Paste the access token here')}
            onChange={event => setToken(event.target.value)} />
        </div>
      </div>
      <div className="stage-set-foot">
        <Button variant="secondary" size="sm" onClick={() => void configure()} disabled={busy !== null || !remoteUrl.trim() || !username.trim()}>
          <CloudCog size={14} aria-hidden="true" />{text('保存同步设置', 'Save sync settings')}
        </Button>
        {config?.hasCredential && (
          <Button variant="text" size="sm" onClick={() => void forgetCredential()} disabled={busy !== null}>
            {text('清除本机令牌', 'Clear token')}
          </Button>
        )}
        <span>
          {config?.credentialPersistence === 'session-only'
            ? text('令牌仅本次运行有效（系统未提供加密存储）。', 'The token lasts for this run only (no encrypted storage available).')
            : config?.hasCredential
              ? text('令牌已用系统钥匙串加密保存。', 'The token is encrypted with the OS keychain.')
              : text('还没有保存令牌。', 'No token saved yet.')}
        </span>
      </div>

      <div className="stage-set-row">
        <div>
          <p className="stage-set-row-title">{text('一键交接', 'One-click handoff')}</p>
          <p className="stage-set-row-desc">
            {status?.lastCommit
              ? text(`本机最新：${commitLabel(status.lastCommit.sha, status.lastCommit.subject)}`,
                `Latest here: ${commitLabel(status.lastCommit.sha, status.lastCommit.subject)}`)
              : text('本机还没有同步记录。', 'Nothing synced from this computer yet.')}
            {pending > 0 && text(` · 有 ${pending} 个文件待上传`, ` · ${pending} file(s) waiting to upload`)}
          </p>
        </div>
        <div className="stage-set-row-ctl">
          <Button variant="primary" size="sm" onClick={() => void upload()} disabled={busy !== null || !configured}>
            <ArrowUpFromLine size={14} aria-hidden="true" />
            {busy === 'upload' ? text('上传中…', 'Uploading…') : text('上传进度', 'Upload')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void download()} disabled={busy !== null || !configured || diverged}>
            <ArrowDownToLine size={14} aria-hidden="true" />
            {busy === 'download' ? text('拉取中…', 'Pulling…') : text('拉取最新', 'Pull latest')}
          </Button>
        </div>
        {diverged && (
          <p className="stage-set-row-extra stage-set-error">
            {text(
              '两台电脑各自都写过，仓库分叉了。为免悄悄丢章节，这里不会自动合并：请先在另一台上传，或把本机这次改动导出成存档后再处理。',
              'Both computers wrote, so the repository diverged. This never merges automatically: upload from the other computer first, or export this computer’s work as an archive.',
            )}
          </p>
        )}
      </div>

      {status && status.books.length > 0 && (
        <div className="stage-set-row">
          <div>
            <p className="stage-set-row-title">{text('这个书库里的作品', 'Books in this library')}</p>
            <p className="stage-set-row-desc">{text(
              '上传只提交有改动的作品；没改过的不会产生提交，也不会被别的书带着走。',
              'Upload commits only the books that changed; untouched books produce no commit.',
            )}</p>
          </div>
          <ul className="stage-set-row-extra" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {status.books.map(book => (
              <li key={book.relativePath} className="stage-set-row-desc" style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0' }}>
                <span aria-hidden="true">{book.changed ? '●' : '○'}</span>
                <span>{book.name}</span>
                {book.current && <span className="stage-set-foot">{text('（正在写）', '(open)')}</span>}
                <span className="stage-set-foot">
                  {book.changed ? text('有改动，会上传', 'changed, will upload') : text('无改动', 'unchanged')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!configured && (
        <p className="stage-set-row-desc">
          {text('填好仓库地址、账号和令牌并保存后，上面的两个按钮才可用。', 'Fill in the URL, account and token, then save to enable the two buttons above.')}
        </p>
      )}

      {notice && (
        <p role={notice.kind === 'error' ? 'alert' : 'status'} className={notice.kind === 'error' ? 'stage-set-error' : 'stage-set-foot'}>
          {notice.text}
        </p>
      )}
    </div>
  )
}
