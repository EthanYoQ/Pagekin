import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  projectPath: 'C:/projects/A',
  accessError: undefined as Error | undefined,
  db: {},
  exemptions: { list: vi.fn(), save: vi.fn(), revoke: vi.fn() },
  summaries: { listFinalizedContinuityBefore: vi.fn(), readFinalizedSource: vi.fn(), readContinuityNodesForWriting: vi.fn(), readContinuityNodesForPreflight: vi.fn() },
  blueprints: { committedRelationshipHints: vi.fn(), listPendingCharacterSyncOperations: vi.fn(), getCharacterSyncOperation: vi.fn(), completeCharacterSyncOperation: vi.fn() },
  characters: { getAll: vi.fn() },
  roster: { read: vi.fn() },
  commitRoster: vi.fn(),
  timeline: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) } },
}))
vi.mock('../../database', () => ({
  closeProjectDatabase: vi.fn(),
  getCurrentProjectPath: () => mocks.projectPath,
  getProjectDb: () => mocks.db,
}))
vi.mock('../../services/project-access', () => ({
  projectAccess: {
    assertCurrentProjectContext: () => {
      if (mocks.accessError) throw mocks.accessError
    },
    assertCurrentSession: () => undefined,
    captureCurrentSession: () => ({ projectId: 'project-A', leaseId: 'lease-A', rootPath: mocks.projectPath }),
  },
}))
vi.mock('../../repositories/consistency-exemption-repository', () => ({ ConsistencyExemptionRepository: mocks.exemptions }))
vi.mock('../../repositories/summary-repository', () => ({ SummaryRepository: mocks.summaries }))
vi.mock('../../repositories/blueprint-repository', () => ({ BlueprintRepository: mocks.blueprints }))
vi.mock('../../repositories/character-repository', () => ({ CharacterRepository: mocks.characters }))
vi.mock('../../repositories/character-roster-repository', () => ({ CharacterRosterRepository: mocks.roster }))
vi.mock('../../services/character-roster-author', () => ({ commitAuthorCharacterRoster: mocks.commitRoster }))
vi.mock('../../repositories/character-continuity-repository', () => ({ readCharacterContinuityTimeline: mocks.timeline }))

import { registerDatabaseController } from '../db-controller'
import { failureText, receivedIpcResult, resultFailure } from '../../../src/i18n/app-errors'
import { shown } from '../../../src/i18n/__tests__/shown-locale'
import { requireIpcSuccess } from '../../../src/services/ipc-result'
import { planFinalizationRetry } from '../../../src/shared/finalization-step-error'

const session = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args, session)

const sqliteFailure = () => Object.assign(new Error('database disk image is malformed'), { name: 'SqliteError', code: 'SQLITE_CORRUPT' })
const RAW = /SqliteError|malformed|SQLITE_|GENERATION_FINALIZATION_ADMISSION_REQUIRED/u
const PATH = 'C:/projects/A'
const ROSTER_REQUEST = { operationId: 'op-1', schemaVersion: 1, intent: 'manual_edit', expectedRevision: 1, entries: [] }

const EXEMPTION_WRITES = [
  ['db:consistency-exemption-save', ['relation:a', '作者确认是有意安排', null, PATH], mocks.exemptions.save],
  ['db:consistency-exemption-revoke', ['relation:a', null, PATH], mocks.exemptions.revoke],
] as const

const ROSTER_WRITES = [
  ['db:character-roster-commit', [ROSTER_REQUEST, PATH], mocks.commitRoster],
  ['db:blueprint-character-sync-complete', ['sync-1', PATH], mocks.blueprints.completeCharacterSyncOperation],
] as const

const WRITES = [...EXEMPTION_WRITES, ...ROSTER_WRITES]

const RETIRED_WRITES = [
  ['db:continuity-save-finalized', [{ draftId: 7 }, PATH]],
  ['db:continuity-save-character-state-candidates', [{ draftId: 7 }, PATH]],
] as const

const READS = [
  ['db:consistency-exemption-list', [PATH], mocks.exemptions.list],
  ['db:continuity-list-before', [3, PATH], mocks.summaries.listFinalizedContinuityBefore],
  ['db:continuity-read-source', [7, PATH], mocks.summaries.readFinalizedSource],
  ['db:character-continuity-nodes', [['c-1'], PATH], mocks.summaries.readContinuityNodesForWriting],
  ['db:character-continuity-timeline', ['c-1', PATH], mocks.timeline],
  ['db:character-continuity-preflight-nodes', [PATH], mocks.summaries.readContinuityNodesForPreflight],
  ['db:blueprint-relationship-hints', [[], PATH], mocks.blueprints.committedRelationshipHints],
  ['db:character-get-all', [PATH], mocks.characters.getAll],
  ['db:character-roster-read', [PATH], mocks.roster.read],
  ['db:blueprint-character-sync-list-pending', [PATH], mocks.blueprints.listPendingCharacterSyncOperations],
  ['db:blueprint-character-sync-get', ['sync-1', PATH], mocks.blueprints.getCharacterSyncOperation],
] as const

type Received = Parameters<typeof resultFailure>[0] & { success: boolean }

async function received(channel: string, args: readonly unknown[]): Promise<Received> {
  return receivedIpcResult(await invoke(channel, ...args)) as Received
}

const text = (locale: 'zh-CN' | 'en-US', result: Received) => failureText(shown(locale), resultFailure(result))
const zhShown = async (channel: string, args: readonly unknown[]) => text('zh-CN', await received(channel, args).catch((error: Error) => ({ success: false, error: error.message })))
const STALE = '项目已切换或重新打开，这次操作属于之前打开的项目，已拒绝执行。请在当前打开的项目里重新操作。'

beforeAll(() => registerDatabaseController())

beforeEach(() => {
  mocks.projectPath = PATH
  mocks.accessError = undefined
  for (const group of [mocks.exemptions, mocks.summaries, mocks.blueprints, mocks.characters, mocks.roster]) {
    for (const fn of Object.values(group)) fn.mockReset()
  }
  mocks.commitRoster.mockReset()
  mocks.timeline.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('一致性、连续性与角色名册失败时作者看不到主进程原文', () => {
  it.each(WRITES)('%s 遇到 SQLite 原文', async (channel, args, repository) => {
    repository.mockImplementation(() => { throw sqliteFailure() })
    const result = await received(channel, args)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toMatch(RAW)
    for (const locale of ['zh-CN', 'en-US'] as const) expect(text(locale, result), locale).not.toMatch(RAW)
  })

  it.each(RETIRED_WRITES)('%s 停用后只回通用码', async (channel, args) => {
    const result = await received(channel, args)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).not.toMatch(RAW)
  })

  it.each(READS)('%s 遇到 SQLite 原文', async (channel, args, repository) => {
    repository.mockImplementation(() => { throw sqliteFailure() })
    const rejection = await invoke(channel, ...args).then(() => undefined, (error: Error) => error)
    expect(rejection).toBeInstanceOf(Error)
    expect(rejection?.message).not.toMatch(RAW)
  })

  it.each([
    [EXEMPTION_WRITES, '一致性安排没有改动。这次修改没能写进作品，请再试一次。'],
    [ROSTER_WRITES, '角色卡没有改动。这次修改没能写进作品，请再试一次。'],
  ] as const)('每组的写失败说明先写保住了什么', async (writes, expected) => {
    for (const [channel, args, repository] of writes) {
      repository.mockImplementation(() => { throw sqliteFailure() })
      expect(text('zh-CN', await received(channel, args)), channel).toBe(expected)
    }
  })
})

describe('角色名册与连续性失败的说明与 master 逐字相同', () => {
  it('会话已换', async () => {
    mocks.accessError = new Error('PROJECT_SESSION_STALE')
    for (const [channel, args] of WRITES) expect(await zhShown(channel, args), channel).toBe(STALE)
  })

  it('作品路径对不上', async () => {
    mocks.projectPath = 'C:/projects/B'
    for (const [channel, args] of WRITES) expect(await zhShown(channel, args), channel).toBe(STALE)
  })

  it('角色卡在别处改过', async () => {
    mocks.commitRoster.mockImplementation(() => { throw new Error('CHARACTER_ID_REVISION_CONFLICT') })
    expect(resultFailure(await received(...ROSTER_WRITES[0].slice(0, 2) as [string, readonly unknown[]]))?.code).toBe('CHARACTER_ID_REVISION_CONFLICT')
  })

  it('豁免原因不合格', async () => {
    mocks.exemptions.save.mockImplementation(() => { throw new Error('CONSISTENCY_EXEMPTION_REASON_INVALID') })
    expect(text('zh-CN', await received(...EXEMPTION_WRITES[0].slice(0, 2) as [string, readonly unknown[]]))).toBe('请填写豁免原因（不超过 500 字）。')
  })

  it('读通道照旧抛出已登记的码', async () => {
    mocks.projectPath = 'C:/projects/B'
    for (const [channel, args] of READS) {
      const rejection = await invoke(channel, ...args).then(() => undefined, (error: Error) => error)
      expect(rejection?.message, channel).toMatch(/^PROJECT_/u)
    }
  })
})

describe('定稿后处理的重试规则不变', () => {
  it('旧的连续性写入失败后，存下的步骤原因仍按可重试处理', async () => {
    let stored = ''
    try {
      requireIpcSuccess(await received('db:continuity-save-finalized', [{ draftId: 7 }, PATH]), '保存定稿连续性事实')
    } catch (error) {
      stored = error instanceof Error ? error.message : String(error)
    }
    expect(stored).not.toBe('')
    const { rows, card } = planFinalizationRetry({ kb_import: { ok: true }, chapter_notes: { ok: false, error: stored } })
    expect({ rows: [...rows], card }).toEqual({ rows: [['chapter_notes', ['chapter_notes']]], card: ['chapter_notes'] })
  })
})
