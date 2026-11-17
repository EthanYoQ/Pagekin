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

it('读建议失败后从英文切到日文，报错跟着换成日文', async () => {
  await act(async () => root!.render(<ImportSuggestions run={run} />))
  const alert = () => host!.querySelector('[role="alert"]')?.textContent
  await expect.poll(alert).toBe(translate('en-US', 'error.projectNotOpen'))
  await act(async () => useLocaleStore.setState({ interfaceLocale: 'ja-JP', locale: 'en-US' }))
  await expect.poll(alert).toBe(translate('ja-JP', 'error.projectNotOpen'))
})
