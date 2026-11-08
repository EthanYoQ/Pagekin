import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { PendingFinalizedRelationCandidate } from '../../../../shared/finalized-continuity'
import type { ProjectSessionContext } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import CharacterSuggestions from '../CharacterSuggestions'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session: ProjectSessionContext = { projectId: 'lighthouse', projectPath: 'C:/novels/lighthouse', leaseId: 'lease-1' }
const candidate: PendingFinalizedRelationCandidate = {
  candidateKey: 'fcs-relation:1', source: { draftId: 7, finalizationId: 'f-7', chapterNumber: 8, contentHash: 'h' },
  sourceId: 'lin', sourceName: '林岚', targetId: 'shen', targetName: '沈砚', value: '恩断义绝',
  evidence: { start: 3, end: 22, text: '林岚当众折断师门信物，与沈砚恩断义绝。' }, authorRelations: ['师徒'],
}

let root: Root
let host: HTMLDivElement
let pending: PendingFinalizedRelationCandidate[]
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>
const originalLocale = useLocaleStore.getState()
const originalProject = useProjectStore.getState()

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const button = (name: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === name)
const click = async (name: string) => { await act(async () => { button(name)!.click() }); await settle() }
const decisions = () => invoke.mock.calls.filter(([channel]) => channel === 'finalized-character:decide-relation-candidate').map(call => call[1] as { decision: string })

beforeEach(async () => {
  pending = [candidate]
  useLocaleStore.setState({ locale: 'zh-CN' })
  setActiveProjectSessionContext(session)
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId } as never })
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'finalized-character:list-relation-candidates') return pending
    if (channel === 'finalized-character:decide-relation-candidate') { pending = []; return { decision: (args[0] as { decision: string }).decision } }
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
})

it('列表里写明是哪两个人、第几章，计入待处理数', () => {
  expect(host.textContent).toContain('1 项待处理的角色建议')
  expect(host.querySelector('[data-kind="relation"]')?.textContent).toContain('林岚 → 沈砚 · 第 8 章')
})

it('打开后同时放作者设定、正文里的新关系和那句原文', async () => {
  await click('检查')
  const card = host.querySelector('[data-kind="relation"]')!
  expect(card.textContent).toContain('师徒')
  expect(card.textContent).toContain('恩断义绝')
  expect(card.querySelector('blockquote')?.textContent).toBe('林岚当众折断师门信物，与沈砚恩断义绝。')
})

it('采用走 accept，列表随后清空', async () => {
  await click('检查')
  await click('采用')
  expect(decisions()).toMatchObject([{ decision: 'accept', expectedAuthorRelations: ['师徒'] }])
  expect(host.querySelector('[data-kind="relation"]')).toBeNull()
})

it('保留原设定走 decline', async () => {
  await click('检查')
  await click('保留原设定')
  expect(decisions()).toMatchObject([{ decision: 'decline' }])
})

it('以后再说不发任何决定，建议还在列表', async () => {
  await click('检查')
  await click('以后再说')
  expect(decisions()).toEqual([])
  expect(host.querySelector('[data-kind="relation"]')?.textContent).toContain('林岚 → 沈砚')
  expect(button('采用')).toBeUndefined()
})
