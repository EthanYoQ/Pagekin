import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (event: unknown, ...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({ listeners: new Map<string, Listener>() }))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, listener: Listener) => { mocks.listeners.set(channel, listener) }) },
}))

import { handle } from '../../ipc/handle'
import { registerUpdateController, type UpdateServiceFacade } from '../update-controller'
import { UpdateService, type UpdateBackend, type UpdateError, type UpdateState } from '../../services/update-service'
import { ipc } from '../../../src/services/ipc-client'
import { getUpdatePresentation, responseProblem, type UpdateProblem } from '../../../src/services/update-presentation'
import { getUpdateCardCopy } from '../../../src/components/updates/update-card-copy'
import { getUpdateRetryAction } from '../../../src/components/updates/update-retry-action'
import { selectCopy } from '../../../src/i18n/core'
import { shown } from '../../../src/i18n/__tests__/shown-locale'
import MASTER from './fixtures/update-card-copy.master.json'

const LOCALES = ['zh-CN', 'en-US', 'ja-JP'] as const
const STATE: UpdateState = { status: 'available', currentVersion: '1.2.2', availableVersion: '1.2.3', updateAction: 'download', isReminderDeferred: false }
const RAW = 'getaddrinfo ENOTFOUND api.github.com at GetAddrInfoReqWrap.onlookup (C:\\Users\\writer\\AppData\\Local\\pagekin-updater\\latest.yml)'

const CHANNEL: Record<UpdateError['code'], string> = {
  UPDATES_DISABLED: 'update:check',
  UPDATE_CONFIGURATION_MISSING: 'update:check',
  CHECK_FAILED: 'update:check',
  DOWNLOAD_NOT_READY: 'update:download',
  DOWNLOAD_FAILED: 'update:download',
  INSTALL_NOT_READY: 'update:quit-and-install',
  INSTALL_FAILED: 'update:quit-and-install',
  OPEN_RELEASE_FAILED: 'update:open-release',
  REMINDER_NOT_AVAILABLE: 'update:defer-reminder',
  REMINDER_SAVE_FAILED: 'update:defer-reminder',
  INVALID_REMINDER_DELAY: 'update:defer-reminder',
}

function register(service: Partial<UpdateServiceFacade>) {
  registerUpdateController({ subscribe: () => () => undefined, getState: () => STATE, ...service } as UpdateServiceFacade, { ipc: { handle }, publish: () => undefined })
}

async function received(channel: string, ...args: unknown[]): Promise<Record<string, unknown>> {
  const wire = await mocks.listeners.get(channel)!({ sender: { id: 1 } }, ...args)
  const crossed = JSON.parse(JSON.stringify(wire)) as unknown
  vi.stubGlobal('window', { aiNovelAPI: { invoke: vi.fn(async () => crossed) } })
  return await (ipc.invoke as unknown as (name: string) => Promise<Record<string, unknown>>)(channel)
}

function card(problem: UpdateProblem | undefined) {
  const presentation = getUpdatePresentation({ state: STATE, manualCheckRequested: true, manualActionError: problem })
  return Object.fromEntries(LOCALES.map(locale => [locale, getUpdateCardCopy(presentation, STATE, (zh, en) => selectCopy(locale, zh, en), shown(locale), problem)]))
}

beforeEach(() => {
  mocks.listeners.clear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** master 的日文目录照搬了英文，PR-H2 补了日文：日文说明要是日文，标题和中英文仍与 master 相同。 */
function withJapaneseDescription(expected: typeof MASTER[number]['card'], actual: ReturnType<typeof card>) {
  expect(actual['ja-JP'].description).toMatch(/[぀-ヿ]/u)
  return { ...expected, 'ja-JP': { ...expected['ja-JP'], description: actual['ja-JP'].description } }
}

describe('更新卡片按原因的说明与 master 逐字相同（日文说明除外）', () => {
  it.each(MASTER.map(row => [`${row.code}/${row.reason}`, row] as const))('%s', async (_name, row) => {
    const error = { code: row.code, phase: 'check', reason: row.reason, retryable: row.retryable, safeTechnicalDetails: 'UPDATE_OPERATION_FAILED' } as UpdateError
    const respond = vi.fn(async () => ({ success: false, checked: true, updateAvailable: false, state: STATE, error }))
    register({ checkManually: respond, downloadUpdate: respond, openRelease: respond, deferReminder: respond, requestInstall: respond })

    const result = await received(CHANNEL[error.code], 7)
    const problem = responseProblem(result)

    expect(result).not.toHaveProperty('error')
    const shownCard = card(problem)
    expect(shownCard).toEqual(withJapaneseDescription(row.card, shownCard))
    expect(problem?.retryable ? getUpdateRetryAction(problem.failure.code) : null).toBe(row.retry)
  })
})

describe('更新失败时作者看不到主进程原文', () => {
  const updater = (failure: Error): UpdateBackend => ({
    checkForUpdates: async () => { throw failure },
    downloadUpdate: async () => [],
    quitAndInstall: () => undefined,
    on: () => undefined,
  })

  it('updater 抛出带路径的原文，卡片三语都只给分类后的说明', async () => {
    const service = new UpdateService({ updater: updater(new Error(RAW)), currentVersion: '1.2.2', isPackaged: true, preferences: { read: () => ({}), write: () => true } })
    registerUpdateController(service, { ipc: { handle }, publish: () => undefined })

    const result = await received('update:check')

    expect(JSON.stringify(result)).not.toContain('ENOTFOUND')
    expect(card(responseProblem(result))['en-US'].description).toBe('Could not reach the update service. Check your network connection and try again.')
    for (const shownCard of Object.values(card(responseProblem(result)))) expect(shownCard.description).not.toMatch(/ENOTFOUND|api\.github|C:\\|latest\.yml/u)
  })

  it('处理器自己抛出原文时，渲染端收到的只有通用码', async () => {
    register({ checkManually: async () => { throw new Error(RAW) } })

    await expect(received('update:check')).rejects.toThrow(/^IPC_HANDLER_FAILED$/u)
  })
})
