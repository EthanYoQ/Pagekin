import { beforeEach, describe, expect, it, vi } from 'vitest'

import { exportNovel } from '../export-service'
import { ipc } from '../ipc-client'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { useLocaleStore } from '../../stores/locale-store'

vi.mock('../ipc-client', () => ({ ipc: { invoke: vi.fn(), invokeWithProjectSession: vi.fn() } }))
vi.mock('../../stores/workflow-store', () => ({ useWorkflowStore: { getState: () => ({ addLog: vi.fn() }) } }))

const projectSession: ProjectSessionContext = { projectId: 'p', leaseId: 'l', projectPath: 'C:/novels/p' }
const snapshot = { id: 'p', sessionLease: 'l', path: 'C:/novels/p', name: 'P', novelConfig: { genre: 'g', targetAudience: 'a', writingLanguage: 'zh-CN' as const } }
const run = () => exportNovel({ format: 'merged-md', grantId: 'grant', includeOutline: false }, snapshot, projectSession)

function snapshotChannel(reply: () => unknown) {
  vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (_session: ProjectSessionContext, channel: string) => {
    if (channel === 'db:draft-export-snapshot') return reply()
    throw new Error(`Unexpected channel: ${channel}`)
  }) as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  setActiveProjectSessionContext(projectSession)
})

describe('导出失败的说明', () => {
  it('导出失败不显示异常原文', async () => {
    // db:draft-export-snapshot 是直连通道，主进程读库抛的异常原样过 IPC（electron/controllers/db-controller.ts 的读通道 catch 原样重抛）。
    snapshotChannel(() => { throw new Error("Error invoking remote method 'db:draft-export-snapshot': SqliteError: database disk image is malformed") })
    for (const [locale, expected] of [['en-US', 'Something unexpected went wrong. Try again.'], ['zh-CN', '出了意外问题，暂时说不清原因。请再试一次。']] as const) {
      useLocaleStore.setState({ locale, interfaceLocale: locale })
      const result = await run()
      expect(result.success).toBe(false)
      expect(result.error).not.toMatch(/malformed|SqliteError|invoking/u)
      expect(result.error).toBe(expected)
    }
  })

  it('导出前核对定稿快照不通过时，说明与 master 相同', async () => {
    snapshotChannel(() => [{ draftId: 1, chapterNumber: 1, version: 1, title: '', content: '', finalizationId: null, contentHash: 'a'.repeat(64) }])
    useLocaleStore.setState({ locale: 'zh-CN', interfaceLocale: 'zh-CN' })
    expect((await run()).error).toBe('定稿导出快照身份或正文无效')
    snapshotChannel(() => 'not-a-list')
    useLocaleStore.setState({ locale: 'en-US', interfaceLocale: 'en-US' })
    expect((await run()).error).toBe('The finalized export snapshot is invalid.')
  })
})
