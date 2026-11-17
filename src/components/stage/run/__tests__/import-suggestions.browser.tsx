import { afterEach, beforeEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import { translate } from '../../../../i18n/core'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import type { WorkflowRun } from '../../../../stores/workflow-store'
import { ImportSuggestions } from '../ImportSuggestions'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '灯塔', projectPath: 'C:/novels/lighthouse', leaseId: '本次打开' }
const run = { id: '导入运行', projectPath: session.projectPath, projectSession: session } as unknown as WorkflowRun

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useProjectStore, useLocaleStore].map(store => snapshot(store as StoreApi<unknown>))

let root: Root | undefined
let host: HTMLDivElement | undefined

beforeEach(() => {
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { on: () => () => {}, invoke: async () => { throw new Error('PROJECT_NOT_OPEN') } } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '灯塔', novelConfig: {} } as unknown as ProjectData })
  setActiveProjectSessionContext(session)
  useLocaleStore.setState({ interfaceLocale: 'en-US', locale: 'en-US' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
})

it('采用进行中切换语言，采用前读到的旧结果晚到也不会让已采用的建议回来', async () => {
  const core = { genre: '奇幻' }
  const held: Array<() => void> = []
  const hold = <T,>(value: () => T) => new Promise<T>(resolve => held.push(() => resolve(value())))
  const release = async (count: number) => {
    await expect.poll(() => held.length).toBeGreaterThanOrEqual(count)
    await act(async () => held.splice(0, count).forEach(resume => resume()))
  }
  const suggestion = { field: 'genre', current: '', inferred: '科幻' }
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { on: () => () => {}, invoke: async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:import-run-effect-receipt-get') {
      return args[1] === 'global' ? { state: 'committed', effectReceipt: { mode: 'fill-empty', suggestions: [suggestion] } } : null
    }
    if (channel === 'db:project-core-get') {
      const snapshot = { ...core }
      return hold(() => snapshot)
    }
    if (channel === 'db:project-core-update') return hold(() => { core.genre = String((args[0] as { genre: string }).genre); return { success: true } })
    throw new Error(`unexpected ${channel}`)
  } } })
  useLocaleStore.setState({ interfaceLocale: 'zh-CN', locale: 'zh-CN' })
  await act(async () => root!.render(<ImportSuggestions run={run} />))
  await release(1)
  const adoptButton = () => host!.querySelector<HTMLButtonElement>('.run-suggestion button')
  await expect.poll(adoptButton).not.toBeNull()

  await act(async () => adoptButton()!.click())
  await act(async () => useLocaleStore.setState({ interfaceLocale: 'en-US', locale: 'en-US' }))
  await expect.poll(() => held.length).toBe(2)
  const [staleLoad] = held.splice(1, 1)
  await release(1)
  await release(1)
  await release(1)
  await expect.poll(() => host!.querySelector('.run-suggestion')).toBeNull()

  await act(async () => staleLoad())
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(core.genre).toBe('科幻')
  expect(host!.querySelector('.run-suggestion')).toBeNull()
})

it('读建议失败后从英文切到日文，报错跟着换成日文', async () => {
  await act(async () => root!.render(<ImportSuggestions run={run} />))
  const alert = () => host!.querySelector('[role="alert"]')?.textContent
  await expect.poll(alert).toBe(translate('en-US', 'error.projectNotOpen'))
  await act(async () => useLocaleStore.setState({ interfaceLocale: 'ja-JP', locale: 'en-US' }))
  await expect.poll(alert).toBe(translate('ja-JP', 'error.projectNotOpen'))
})
