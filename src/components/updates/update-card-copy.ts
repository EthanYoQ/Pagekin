import { catalogNote, failureText } from '../../i18n/app-errors'
import type { ErrorDisplayLocale } from '../../i18n/types'
import { stateProblem, type UpdatePresentation, type UpdateProblem, type UpdateState } from '../../services/update-presentation'

export type UpdateText = (zhCNText: string, enUSText: string) => string

export function getUpdateCardCopy(
  presentation: UpdatePresentation,
  state: UpdateState,
  text: UpdateText,
  locale: ErrorDisplayLocale,
  manualActionError?: UpdateProblem,
) {
  const version = state.availableVersion ? `v${state.availableVersion}` : text('新版本', 'A new version')

  switch (presentation.kind) {
    case 'checking':
      return { title: text('正在检查更新', 'Checking for updates'), description: text('正在检查 GitHub Release 中的新正式版。', 'Checking GitHub Releases for a new stable version.') }
    case 'not-available':
      return { title: text('已是最新版本', 'You are up to date'), description: text('当前安装的版本已经是最新正式版。', 'The installed version is already the latest stable release.') }
    case 'available':
      return state.updateAction === 'open-release'
        ? { title: text('发现新版本', 'New version found'), description: text(`${version} 已可获取。打开下载页可获取适用于 macOS 的安装包。`, `${version} is available. Open the download page to get the macOS installer.`) }
        : { title: text('发现新版本', 'New version found'), description: text(`${version} 已可获取。点击“下载更新”后将在后台准备安装包。`, `${version} is available. Select “Download update” to prepare the installer in the background.`) }
    case 'downloading':
      return { title: text('正在下载更新', 'Downloading update'), description: text(`${version} 正在后台下载，您可以继续创作。`, `${version} is downloading in the background. You can keep writing.`) }
    case 'downloaded':
      return { title: text('更新已准备就绪', 'Update ready to install'), description: text(`${version} 已下载完成。重启后将开始安装。`, `${version} has finished downloading. Restart to begin installation.`) }
    case 'manual-error':
      return { title: text('无法完成更新操作', 'Could not complete update action'), description: failureText(locale, (manualActionError ?? stateProblem(state.error))?.failure, { fallback: catalogNote('error.updateOperationFailed') }) }
    default:
      return { title: '', description: '' }
  }
}
