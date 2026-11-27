import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../blueprint-character-sync', () => ({ syncBlueprintCharacterCandidates: vi.fn().mockResolvedValue(undefined) }))

import { retryAllPendingDirectoryCharacterSyncs, retryDirectoryCharacterSync } from '../directory-character-sync-recovery'
import { shown } from '../../../i18n/__tests__/shown-locale'

const session = { projectId: 'NovelA', leaseId: 'lease-NovelA', projectPath: 'C:/NovelA' }

function stubIpc(results: Record<string, unknown>) {
  vi.stubGlobal('window', {
    aiNovelAPI: { invoke: vi.fn((channel: string) => Promise.resolve(results[channel])), on: vi.fn(), once: vi.fn(), send: vi.fn() },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('蓝图角色同步重试的失败说明按界面语言显示（#471）', () => {
  it('英文界面：待重试的操作不存在时说明是英文', async () => {
    stubIpc({ 'db:blueprint-character-sync-get': null })

    await expect(retryDirectoryCharacterSync('op-1', 'C:/NovelA', session, shown('en-US')))
      .rejects.toThrow(/^The pending blueprint character-proposal operation no longer exists\.$/u)
  })

  const writeFailed = { success: false, failure: { code: 'CHARACTER_ROSTER_WRITE_FAILED', note: { key: 'error.characterRosterWriteFailed' } } }

  it.each([['en-US', /^The blueprint character proposals were saved, but their receipt could not be stored\.$/u], ['zh-CN', /^蓝图角色提议已保存，但回执未能持久化$/u]] as const)(
    '%s：回执没写进作品时只给本处的说明，不接「角色卡没有改动」', async (locale, expected) => {
      stubIpc({
        'db:blueprint-character-sync-list-pending': [{ operationId: 'op-1', status: 'pending' }],
        'db:blueprint-character-sync-get': { operationId: 'op-1', status: 'pending', characterSyncInput: [] },
        'db:blueprint-character-sync-complete': writeFailed,
      })

      await expect(retryAllPendingDirectoryCharacterSyncs('C:/NovelA', session, shown(locale))).rejects.toThrow(expected)
    })

  it('中文界面：已登记的原因接在说明后面', async () => {
    stubIpc({
      'db:blueprint-character-sync-get': { operationId: 'op-1', status: 'pending', characterSyncInput: [] },
      'db:blueprint-character-sync-complete': { success: false, failure: { code: 'PROJECT_NOT_OPEN' } },
    })

    await expect(retryDirectoryCharacterSync('op-1', 'C:/NovelA', session, shown('zh-CN')))
      .rejects.toThrow(/^蓝图角色提议已保存，但回执未能持久化：请先打开项目。$/u)
  })
})
