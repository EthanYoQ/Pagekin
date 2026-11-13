/* eslint-disable react-refresh/only-export-components */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import type { CharacterProposalBatch } from '../../../../shared/character-proposal'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { AdoptGeneratedCharactersCommand } from '../../../../services/workflows/commands/architecture.command'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import { RunCard } from '../RunCard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '灯塔', projectPath: 'C:/novels/lighthouse', leaseId: '本次打开' }
const batch: CharacterProposalBatch = {
  proposalBatchId: '蓝图提议', revision: 1, status: 'pending-approval', source: { kind: 'directory', operationId: '蓝图' },
  items: [
    { selectionKey: 'lin', sourceId: '1', fields: { name: '林舟' }, resolution: { status: 'unresolved', candidateIds: [] }, relationships: [
      { targetName: '沈砺', relation: '师徒' }, { targetName: '韩青', relation: '旧识' }, { targetSelectionKey: 'shen', relation: '同门' }] },
    { selectionKey: 'shen', sourceId: '2', fields: { name: '沈砺' }, resolution: { status: 'unresolved', candidateIds: [] }, relationships: [] },
  ],
}
const roster = [{ characterId: 'saved-shen', retired: false, fields: { name: '沈砺' } }, { characterId: 'saved-han', retired: false, fields: { name: '韩青' } }]

const restores = [useProjectStore, useWorkflowStore, useLocaleStore].map(store => {
  const state = (store as StoreApi<unknown>).getState()
  return () => (store as StoreApi<unknown>).setState(state, true)
})
let root: Root, host: HTMLDivElement, invoke: ReturnType<typeof vi.fn>, pending: Promise<unknown>

function Card() {
  const run = useWorkflowStore(state => state.activeRuns[0])
  return run ? <RunCard run={run} /> : null
}
const box = (label: string) => [...host.querySelectorAll('label')].find(node => node.textContent?.includes(label))!.querySelector('input')!
const confirmButton = () => [...host.querySelectorAll('button')].find(node => node.textContent?.includes('按当前选择确认'))!
const approved = () => invoke.mock.calls.find(([channel]) => channel === 'character-proposal:approve')?.[1] as { relationships: unknown[] } | undefined

beforeEach(async () => {
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, novelConfig: {} } as never })
  useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {}, currentRun: null })
  setActiveProjectSessionContext(session)
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'character-identity:read') return { characters: roster }
    if (channel === 'character-proposal:approve') return { batch: { ...batch, status: 'approved', revision: 2 }, created: [] }
    if (channel === 'skills:list-user') return []
    if (channel === 'fs:check-exists') return false
    throw new Error(`测试未配置桌面调用：${channel}`)
  })
  Object.assign(window, { aiNovelAPI: { invoke, on: () => () => {}, once: vi.fn(), send: vi.fn() } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  pending = useWorkflowStore.getState().startWorkflow({ type: 'architecture_generation', title: '角色', projectPath: session.projectPath, projectSession: session, steps: [
    { name: '生成角色', description: '', executor: async (_step, context) => { context.data.characterProposalBatch = structuredClone(batch); return '' } },
    { name: '采用角色', description: '', requiresConfirmation: true, executor: (step, context, callbacks) => new AdoptGeneratedCharactersCommand().execute({ step, context, callbacks }) },
  ] })
  await act(async () => root.render(<Card />))
  await vi.waitFor(() => expect(box('林舟 → 韩青：旧识')).toBeTruthy())
  await vi.waitFor(() => expect(confirmButton().disabled).toBe(false))
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  setActiveProjectSessionContext(null); restores.forEach(restore => restore()); vi.restoreAllMocks()
})

it('工作流确认里勾上的关系就是提交的关系：批内与名单同名的不勾也不提交，名单里唯一同名的默认勾选', async () => {
  expect(box('林舟 → 沈砺：师徒').checked).toBe(false)
  expect(box('林舟 → 沈砺：师徒').disabled).toBe(true)
  expect(box('林舟 → 韩青：旧识').checked).toBe(true)
  expect(box('林舟 → 沈砺：同门').checked).toBe(true)
  await act(async () => confirmButton().click())
  await act(async () => { await pending })
  expect(approved()?.relationships).toHaveLength(2)
  expect(approved()?.relationships).toEqual(expect.arrayContaining([
    { sourceSelectionKey: 'lin', targetCharacterId: 'saved-han', relation: '旧识' },
    { sourceSelectionKey: 'lin', targetSelectionKey: 'shen', relation: '同门' },
  ]))
})

it('确认区卸载重挂后作者取消的勾选保持不变，提交也不带它', async () => {
  await act(async () => box('林舟 → 沈砺：同门').click())
  await act(async () => root.render(null))
  await act(async () => root.render(<Card />))
  await vi.waitFor(() => expect(confirmButton().disabled).toBe(false))
  expect(box('林舟 → 沈砺：同门').checked).toBe(false)
  await act(async () => confirmButton().click())
  await act(async () => { await pending })
  expect(approved()?.relationships).toEqual([{ sourceSelectionKey: 'lin', targetCharacterId: 'saved-han', relation: '旧识' }])
})
