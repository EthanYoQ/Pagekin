import { BrowserWindow, ipcMain, Notification } from 'electron'
import { DEFAULT_GLOBAL_CONFIG, GLOBAL_CONFIG_PATH, readJsonFile } from '../utils/config-utils'
import { focusExistingInstance } from '../services/single-instance-runtime'
import type { GlobalConfig, StageNotice } from '../../src/shared/ipc-channels'

// Windows 上通知对象被回收后点击不再回调，显示期间要留住引用。
const shown = new Set<Notification>()

export function registerStageNotificationController() {
  // 横幅超时收进操作中心后对象可能已被回收，实例的 click 不再触发；这个回调不依赖实例。
  if (process.platform === 'win32') Notification.handleActivation(() => focusExistingInstance(BrowserWindow.getAllWindows()[0]))
  ipcMain.handle('window:notify-stage', async (event, notice: StageNotice) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || (win.isFocused() && !win.isMinimized())) return { shown: false }
    if (readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG).backgroundStageNotifications === false) return { shown: false }
    if (!Notification.isSupported() || typeof notice?.title !== 'string' || typeof notice.body !== 'string') return { shown: false }
    const notification = new Notification({ title: notice.title, body: notice.body })
    shown.add(notification)
    notification.on('click', () => { shown.delete(notification); focusExistingInstance(win) })
    notification.on('close', () => shown.delete(notification))
    notification.show()
    return { shown: true }
  })
}
