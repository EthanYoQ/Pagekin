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

const pairBatch: CharacterProposalBatch = { ...batch, items: [
  { ...batch.items[0], relationships: [{ targetName: '守塔人', relation: '旧识' }] },
  { selectionKey: '13:1', sourceId: 'directory-13:13:1', fields: { name: '守塔人', role: 'minor' }, relationships: [], resolution: { status: 'unresolved', candidateIds: [] } }] }

let root: Root
let readBatch: CharacterProposalBatch
let roster: { characterId: string; name: string; role: string; retired?: boolean }[]
let host: HTMLDivElement
let pending: PendingFinalizedCharacterProposalSummary[]
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>
const originalLocale = useLocaleStore.getState()
const originalProject = useProjectStore.getState()
const originalCharacters = useCharacterStore.getState()

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const button = (name: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === name || item.getAttribute('aria-label') === name)
const click = async (name: string) => { await act(async () => { button(name)!.click() }); await settle() }
const relationBox = (text = '雾灯人 → 林岚：暗中守护') => [...host.querySelectorAll('label')].find(label => label.textContent?.includes(text))?.querySelector('input')
const calls = (channel: string) => invoke.mock.calls.filter(([name]) => name === channel).map(call => call[1])

beforeEach(async () => {
  pending = [summary]
  readBatch = batch
  roster = [{ characterId: 'heroine', name: '林岚', role: 'protagonist' }]
  useLocaleStore.setState({ locale: 'zh-CN' })
  setActiveProjectSessionContext(session)
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId } as never })
  useCharacterStore.setState({ characters: [{ characterId: 'heroine', name: '林岚', role: 'protagonist' }] as never, load: vi.fn(async () => {}) as never })
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'character-proposal:list-pending-finalized') return pending
    if (channel === 'character-proposal:read-pending-finalized') return readBatch
    if (channel === 'character-identity:read') return { revision: 1, aliases: [], relationships: [],
      characters: roster.map(({ characterId, name, role, retired = false }) => ({ characterId, fields: { name, role }, retired, revision: 1, provenance: {} })) }
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
  roster = [{ characterId: 'keeper', name: '守塔人', role: 'supporting' }]
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
  roster.push({ characterId: 'twin', name: '林岚', role: 'minor' })
  await click('检查蓝图角色决策')
  expect(relationBox()?.disabled).toBe(true)
  expect(relationBox()?.checked).toBe(false)
})

it('关系指向同一批里唯一的另一位新角色：默认勾上，接受时带上对方的候选键', async () => {
  readBatch = pairBatch
  await click('检查蓝图角色决策')
  expect(relationBox('雾灯人 → 守塔人：旧识')?.checked).toBe(true)
  await click('接受这些决策')
  expect(calls('character-proposal:approve')).toMatchObject([{ relationships: [{ sourceSelectionKey: '13:0', targetSelectionKey: '13:1', relation: '旧识' }] }])
})

it('把雾灯人对应到林岚本人：指向林岚的关系去掉勾且不能再勾，接受不带它', async () => {
  await click('检查蓝图角色决策')
  const select = host.querySelector<HTMLSelectElement>('select[aria-label^="采用方式：雾灯人"]')!
  await act(async () => {
    select.value = 'map:heroine'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(relationBox()?.checked).toBe(false)
  expect(relationBox()?.disabled).toBe(true)
  await click('接受这些决策')
  expect(calls('character-proposal:approve')).toMatchObject([{ selections: [{ selectionKey: '13:0', action: 'map', characterId: 'heroine' }], relationships: [] }])
})

it('导入的角色卡同样适用：关系目标在名单里唯一同名时默认勾上', async () => {
  pending = [{ proposalBatchId: 'cpb:import', revision: 2, importOperationId: 'import-1', itemCount: 1 }]
  readBatch = { ...batch, proposalBatchId: 'cpb:import', revision: 2, source: { kind: 'import', operationId: 'import-1' } }
  useCharacterStore.setState({ rosterRevision: 2 })
  await settle()
  await click('检查导入角色决策')
  expect(relationBox()?.checked).toBe(true)
})

it('只认已保存的角色：名单卡片上未保存的同名草稿不算目标，关系不默认勾', async () => {
  roster = []
  useCharacterStore.setState({ characters: [{ characterId: 'draft:00000000-0000-4000-8000-000000000009', name: '林岚', role: 'protagonist' }] as never })
  await click('检查蓝图角色决策')
  expect(relationBox()?.checked).toBe(false)
  expect(relationBox()?.disabled).toBe(true)
})

it('打开后在名单卡片上改名（未保存）：关系仍指向已保存的林岚，勾选与提交一致', async () => {
  await click('检查蓝图角色决策')
  await act(async () => { useCharacterStore.setState({ characters: [{ characterId: 'heroine', name: '林岚改', role: 'protagonist' }] as never }) })
  await settle()
  expect(relationBox()?.checked).toBe(true)
  expect(relationBox()?.disabled).toBe(false)
  await click('接受这些决策')
  expect(calls('character-proposal:approve')).toMatchObject([{ relationships: [{ sourceSelectionKey: '13:0', targetCharacterId: 'heroine', relation: '暗中守护' }] }])
})

it('本批新角色与已有角色同名：目标不唯一，关系不默认勾也不能勾', async () => {
  readBatch = { ...batch, items: [batch.items[0],
    { selectionKey: '13:1', sourceId: 'directory-13:13:1', fields: { name: '林岚', role: 'minor' }, relationships: [], resolution: { status: 'unresolved', candidateIds: [] } }] }
  await click('检查蓝图角色决策')
  expect(relationBox()?.checked).toBe(false)
  expect(relationBox()?.disabled).toBe(true)
})

it('同一条关系提了两遍：默认只带一条，接受不被主进程判重复', async () => {
  readBatch = { ...batch, items: [{ ...batch.items[0], relationships: [batch.items[0].relationships[0], batch.items[0].relationships[0]] }] }
  await click('检查蓝图角色决策')
  await click('接受这些决策')
  expect(calls('character-proposal:approve')).toMatchObject([{ relationships: [{ sourceSelectionKey: '13:0', targetCharacterId: 'heroine', relation: '暗中守护' }] }])
  expect((calls('character-proposal:approve')[0] as { relationships: unknown[] }).relationships).toHaveLength(1)
})
