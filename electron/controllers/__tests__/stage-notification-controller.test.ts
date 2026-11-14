import { beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: { sender: { owner: FakeWindow } }, ...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => {
  const notifications: FakeNotification[] = []
  class FakeNotification {
    readonly listeners = new Map<string, () => void>()
    readonly show = vi.fn()
    constructor(readonly options: { title: string; body: string }) { notifications.push(this) }
    on(event: string, listener: () => void) { this.listeners.set(event, listener); return this }
    static isSupported() { return true }
    static handleActivation(callback: () => void) { activation.callback = callback }
  }
  const activation = { callback: null as (() => void) | null }
  return { handlers: new Map<string, IpcHandler>(), notifications, config: {} as Record<string, unknown>, FakeNotification, activation, windows: [] as unknown[] }
})

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)) },
  BrowserWindow: { fromWebContents: vi.fn((sender: { owner: FakeWindow }) => sender.owner), getAllWindows: () => mocks.windows },
  Notification: mocks.FakeNotification,
}))

vi.mock('../../utils/config-utils', () => ({
  GLOBAL_CONFIG_PATH: 'config.json',
  DEFAULT_GLOBAL_CONFIG: {},
  readJsonFile: () => mocks.config,
}))

import { registerStageNotificationController } from '../stage-notification-controller'

class FakeWindow {
  focused = false
  minimized = false
  readonly isDestroyed = vi.fn(() => false)
  readonly isFocused = vi.fn(() => this.focused)
  readonly isMinimized = vi.fn(() => this.minimized)
  readonly restore = vi.fn(() => { this.minimized = false })
  readonly show = vi.fn()
  readonly focus = vi.fn(() => { this.focused = true })
}

const notice = { title: '第 3 章审稿完成', body: '回到书童查看结果。' }

function notify(win: FakeWindow) {
  const handler = mocks.handlers.get('window:notify-stage')
  if (!handler) throw new Error('Missing IPC handler: window:notify-stage')
  return handler({ sender: { owner: win } }, notice)
}

describe('后台阶段通知', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.notifications.length = 0
    mocks.config = {}
    mocks.activation.callback = null
    mocks.windows = []
    registerStageNotificationController()
  })

  it('窗口没有焦点时发系统通知', async () => {
    const win = new FakeWindow()
    await notify(win)
    expect(mocks.notifications).toHaveLength(1)
    expect(mocks.notifications[0].options).toMatchObject(notice)
    expect(mocks.notifications[0].show).toHaveBeenCalledOnce()
  })

  it('窗口最小化时发系统通知', async () => {
    const win = new FakeWindow()
    win.focused = true
    win.minimized = true
    await notify(win)
    expect(mocks.notifications).toHaveLength(1)
  })

  it('窗口在前台时不发，交给应用内提示', async () => {
    const win = new FakeWindow()
    win.focused = true
    await notify(win)
    expect(mocks.notifications).toHaveLength(0)
  })

  it('设置里关掉后不发', async () => {
    mocks.config = { backgroundStageNotifications: false }
    await notify(new FakeWindow())
    expect(mocks.notifications).toHaveLength(0)
  })

  it('从没设置过时默认发', async () => {
    mocks.config = { autoOpenNextChapterAfterFinalize: true }
    await notify(new FakeWindow())
    expect(mocks.notifications).toHaveLength(1)
  })

  it('点通知把最小化的窗口还原并聚焦', async () => {
    const win = new FakeWindow()
    win.minimized = true
    await notify(win)
    mocks.notifications[0].listeners.get('click')?.()
    expect(win.restore).toHaveBeenCalledOnce()
    expect(win.show).toHaveBeenCalledOnce()
    expect(win.focus).toHaveBeenCalledOnce()
  })

  it('Windows 横幅超时收进操作中心后，再点通知仍把窗口带回前台', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      mocks.activation.callback = null
      registerStageNotificationController()
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
    const win = new FakeWindow()
    win.minimized = true
    mocks.windows = [win]
    await notify(win)
    mocks.notifications[0].listeners.get('close')?.()
    mocks.activation.callback?.()
    expect(win.restore).toHaveBeenCalledOnce()
    expect(win.focus).toHaveBeenCalledOnce()
  })
})
