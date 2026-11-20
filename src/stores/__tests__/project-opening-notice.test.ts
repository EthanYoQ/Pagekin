import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../project-store'

const { invoke, pushToast, closeToast } = vi.hoisted(() => {
  const closeToast = vi.fn()
  return { invoke: vi.fn(), pushToast: vi.fn(() => closeToast), closeToast }
})

vi.mock('../../services/ipc-client', () => ({
  ipc: {
    invoke,
    invokeWithProjectSession: (_context: unknown, channel: string, ...args: unknown[]) => invoke(channel, ...args),
  },
}))
vi.mock('../../components/ui/ToastStack', () => ({ pushToast }))
vi.mock('../../components/ui/AlertDialog', () => ({ alertError: vi.fn() }))
vi.mock('../../services/project-service', () => ({
  onProjectOpening: vi.fn(),
  onProjectOpened: vi.fn(async () => undefined),
  onProjectClosed: vi.fn(),
}))

/** 主进程拒绝打开：这里只看等待提示，回包内容无关。 */
function answerOpenAfter(ms: number) {
  invoke.mockImplementation((channel: string, _target: unknown, requestToken: string) => channel === 'project:open'
    ? new Promise(resolve => setTimeout(() => resolve({ success: false, project: null, requestToken,
        activeProjectPath: null, databaseRestored: true, dbReady: true, error: 'Error: PROJECT_DIRECTORY_MISSING' }), ms))
    : Promise.resolve(undefined))
}

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockReset()
  pushToast.mockClear()
  closeToast.mockClear()
  useProjectStore.setState({ currentProject: null, loading: false })
})
afterEach(() => { vi.useRealTimers() })

describe('打开作品要等一会儿时告诉作者（#702）', () => {
  it('半秒还没开好就提示正在打开，开完收起', async () => {
    answerOpenAfter(3_000)
    const opening = useProjectStore.getState().openProject('C:\\novels\\long')

    await vi.advanceTimersByTimeAsync(499)
    expect(pushToast).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(pushToast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tone: 'info', duration: 0,
      message: expect.stringMatching(/^正在打开作品…/) }))
    expect(closeToast).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_500)
    await opening
    expect(closeToast).toHaveBeenCalledOnce()
  })

  it('先点的那次先结束，后点的还在等：提示留到后点的那次开完才收起', async () => {
    answerOpenAfter(3_000)
    const first = useProjectStore.getState().openProject('C:\\novels\\long')
    await vi.advanceTimersByTimeAsync(1_000)
    answerOpenAfter(5_000)
    const second = useProjectStore.getState().openProject('C:\\novels\\other')

    await vi.advanceTimersByTimeAsync(2_500)
    await first
    expect(closeToast).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_500)
    await second
    expect(closeToast).toHaveBeenCalledOnce()
  })

  it('很快开好的书不弹提示', async () => {
    answerOpenAfter(100)
    await Promise.all([useProjectStore.getState().openProject('C:\\novels\\short'), vi.advanceTimersByTimeAsync(1_000)])

    expect(pushToast).not.toHaveBeenCalled()
  })
})
