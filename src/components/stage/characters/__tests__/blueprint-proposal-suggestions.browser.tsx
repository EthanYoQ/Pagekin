import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { CharacterProposalBatch, PendingFinalizedCharacterProposalSummary } from '../../../../shared/character-proposal'
import type { ProjectSessionContext } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useCharacterStore } from '../../../../stores/character-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import CharacterSuggestions from '../CharacterSuggestions'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session: ProjectSessionContext = { projectId: 'lighthouse', projectPath: 'C:/novels/lighthouse', leaseId: 'lease-1' }
const summary: PendingFinalizedCharacterProposalSummary = { proposalBatchId: 'cpb:blueprint', revision: 4, blueprintChapters: { from: 13, to: 13 }, itemCount: 1 }
const batch: CharacterProposalBatch = {
  proposalBatchId: 'cpb:blueprint', revision: 4, status: 'pending-approval', source: { kind: 'directory', operationId: 'sync-13' },
  items: [{ selectionKey: '13:0', sourceId: 'directory-13:13:0', fields: { name: '雾灯人', role: 'supporting' },
    relationships: [{ targetName: '林岚', relation: '暗中守护' }], resolution: { status: 'unresolved', candidateIds: [] } }],
}

let root: Root
let host: HTMLDivElement
let pending: PendingFinalizedCharacterProposalSummary[]
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>
const originalLocale = useLocaleStore.getState()
const originalProject = useProjectStore.getState()
const originalCharacters = useCharacterStore.getState()

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const button = (name: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === name || item.getAttribute('aria-label') === name)
const click = async (name: string) => { await act(async () => { button(name)!.click() }); await settle() }
const relationBox = () => [...host.querySelectorAll('label')].find(label => label.textContent?.includes('雾灯人 → 林岚：暗中守护'))?.querySelector('input')
const calls = (channel: string) => invoke.mock.calls.filter(([name]) => name === channel).map(call => call[1])

beforeEach(async () => {
  pending = [summary]
  useLocaleStore.setState({ locale: 'zh-CN' })
  setActiveProjectSessionContext(session)
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId } as never })
  useCharacterStore.setState({ characters: [{ characterId: 'heroine', name: '林岚', role: 'protagonist' }] as never, load: vi.fn(async () => {}) as never })
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'character-proposal:list-pending-finalized') return pending
    if (channel === 'character-proposal:read-pending-finalized') return batch
    if (channel === 'character-proposal:approve' || channel === 'character-proposal:cancel') { pending = []; return { batch, created: [] } }
    return []
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<CharacterSuggestions />))
  await settle()
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setActiveProjectSessionContext(null)
  useLocaleStore.setState(originalLocale, true)
  useProjectStore.setState(originalProject, true)
  useCharacterStore.setState(originalCharacters, true)
})

it('列表里写明是第几章蓝图的新角色，计入待处理数', () => {
  expect(host.textContent).toContain('1 项待处理的角色建议')
  expect(host.querySelector('[data-kind="decision"]')?.textContent).toContain('第 13 章蓝图的新角色（1 位）')
})

it('名单里只有一个林岚：关系默认勾上，直接接受就带上目标角色', async () => {
  await click('检查蓝图角色决策')
  expect(host.querySelector('[data-kind="decision"]')?.textContent).toContain('雾灯人 · 配角第 13 章蓝图首次出场')
  expect(relationBox()?.disabled).toBe(false)
  expect(relationBox()?.checked).toBe(true)
  await click('接受这些决策')
  expect(calls('character-proposal:approve')).toMatchObject([{ proposalBatchId: 'cpb:blueprint', expectedRevision: 4,
    selections: [{ selectionKey: '13:0', action: 'create' }], relationships: [{ sourceSelectionKey: '13:0', targetCharacterId: 'heroine', relation: '暗中守护' }] }])
  expect(host.querySelector('[data-kind="decision"]')).toBeNull()
})

it('取消勾选关系再接受：只采用角色，不带这条关系', async () => {
  await click('检查蓝图角色决策')
  await act(async () => { relationBox()!.click() })
  expect(relationBox()?.checked).toBe(false)
  await click('接受这些决策')
  expect(calls('character-proposal:approve')).toMatchObject([{ relationships: [] }])
})

it('名单里没有林岚时关系不默认勾，接受不带关系', async () => {
  useCharacterStore.setState({ characters: [{ characterId: 'keeper', name: '守塔人', role: 'supporting' }] as never })
  await settle()
  await click('检查蓝图角色决策')
  expect(relationBox()?.checked).toBe(false)
  await click('接受这些决策')
  expect(calls('character-proposal:approve')).toMatchObject([{ relationships: [] }])
})

it('拒绝走 cancel', async () => {
  await click('检查蓝图角色决策')
  await click('拒绝这些决策')
  expect(calls('character-proposal:cancel')).toEqual([{ proposalBatchId: 'cpb:blueprint', expectedRevision: 4 }])
  expect(calls('character-proposal:approve')).toEqual([])
})

it('名单里有两个同名林岚时不猜目标，关系不能勾选', async () => {
  useCharacterStore.setState({ characters: [{ characterId: 'heroine', name: '林岚', role: 'protagonist' }, { characterId: 'twin', name: '林岚', role: 'minor' }] as never })
  await settle()
  await click('检查蓝图角色决策')
  expect(relationBox()?.disabled).toBe(true)
  expect(relationBox()?.checked).toBe(false)
})
