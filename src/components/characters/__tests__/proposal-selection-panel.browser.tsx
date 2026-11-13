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
