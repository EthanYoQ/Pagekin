/* eslint-disable react-refresh/only-export-components */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { CharacterProposalBatch } from '../../../shared/character-proposal'
import { createCharacterProposalChoices, type CharacterProposalChoices } from '../../../services/character-proposal-choices'
import { useLocaleStore } from '../../../stores/locale-store'
import { CharacterProposalSelectionPanel } from '../CharacterProposalSelectionPanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const architectureBatch: CharacterProposalBatch = {
  proposalBatchId: 'cpb:architecture', revision: 2, status: 'pending-approval',
  source: { kind: 'generation', inputKind: 'architecture', handle: { projectId: 'p', epoch: 'e', rootActionId: 'r', runId: 'run' }, artifacts: [{ artifactId: 'a', revision: 1, textHash: 'h' }] },
  items: [{ selectionKey: 'shen', sourceId: 'run:shen', fields: { name: '沈砚', role: 'supporting', background: '旧港的船医。' },
    relationships: [{ targetName: '林岚', relation: '旧识' }], resolution: { status: 'unresolved', candidateIds: [] } }],
}

let root: Root
let host: HTMLDivElement
let latest: CharacterProposalChoices
const identities = [{ characterId: 'heroine', name: '林岚', role: 'protagonist' }]
const originalLocale = useLocaleStore.getState()

function Host() {
  const [choices, setChoices] = useState(() => createCharacterProposalChoices(architectureBatch, identities))
  return <CharacterProposalSelectionPanel batch={architectureBatch}
    choices={choices} onChange={next => { latest = next; setChoices(next) }} />
}

const relationBox = () => [...host.querySelectorAll('label')].find(label => label.textContent?.includes('沈砚 → 林岚：旧识'))!.querySelector('input')!

beforeEach(async () => {
  latest = createCharacterProposalChoices(architectureBatch, identities)
  useLocaleStore.setState({ locale: 'zh-CN' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<Host />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useLocaleStore.setState(originalLocale, true)
})

it('运行侧页的架构提议同样能采用指向已有角色的关系，带上目标角色', async () => {
  expect(relationBox().disabled).toBe(false)
  expect(relationBox().checked).toBe(true)
  expect(latest.relationships).toEqual([{ sourceSelectionKey: 'shen', targetCharacterId: 'heroine', relation: '旧识' }])
  await act(async () => { relationBox().click() })
  expect(latest.relationships).toEqual([])
})

it('源角色改成暂不采用时，指向已有角色的关系一并去掉', async () => {
  const select = host.querySelector('select')!
  await act(async () => {
    select.value = 'keep-unresolved'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(latest.relationships).toEqual([])
  expect(relationBox().disabled).toBe(true)
})

it('架构提议有 40 位候选时，每位都有采用方式，指向下一位的关系都能采用', async () => {
  const items = Array.from({ length: 40 }, (_, index) => ({ selectionKey: `slot-${index}`, sourceId: `run:slot-${index}`,
    fields: { name: `人物${index + 1}`, role: index === 0 ? 'protagonist' as const : 'supporting' as const, background: `第 ${index + 1} 位的来历。` },
    relationships: [{ targetSelectionKey: `slot-${(index + 1) % 40}`, relation: '牵连' }], resolution: { status: 'unresolved' as const, candidateIds: [] } }))
  const batch: CharacterProposalBatch = { ...architectureBatch, proposalBatchId: 'cpb:forty', items }
  await act(async () => root.render(<CharacterProposalSelectionPanel batch={batch}
    choices={createCharacterProposalChoices(batch, [])} onChange={() => {}} />))
  expect(host.querySelectorAll('select')).toHaveLength(40)
  expect(host.querySelector('[aria-label="采用方式：人物40 · slot-39"]')).not.toBeNull()
  const relations = [...host.querySelectorAll('label')].filter(label => label.textContent?.includes('：牵连'))
  expect(relations).toHaveLength(40)
  expect(relations.every(label => label.querySelector('input')!.disabled === false)).toBe(true)
  expect(relations.some(label => label.textContent === '人物40 → 人物1：牵连')).toBe(true)
})
