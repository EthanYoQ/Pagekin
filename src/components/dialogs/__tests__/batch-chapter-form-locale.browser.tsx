/* eslint-disable react-refresh/only-export-components */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ModelProfile, ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useBatchChapterForm } from '../use-batch-chapter-form'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = { projectId: 'lighthouse', leaseId: 'lease-1', projectPath: 'C:\\novels\\lighthouse' }
const win = window as unknown as { aiNovelAPI?: { invoke: (channel: string) => Promise<unknown>; on: () => () => void } }
const replies: Record<string, unknown> = {
  'db:draft-authority-sequence': { status: 'ok', nextChapterNumber: 1, gaps: [], finalizedChapterNumbers: [] },
  'db:consistency-exemption-list': [],
  'db:blueprint-get': { chapterNumber: 1, title: 'Arrival' },
  'db:blueprint-get-all': [],
}

vi.mock('../../../services/consistency-preflight', async importOriginal => ({
  ...await importOriginal<typeof import('../../../services/consistency-preflight')>(),
  readConsistencyPreflight: async () => ({ findings: [], exemptions: [] }),
}))

const MODEL = { id: 'flash', name: 'Flash', provider: 'deepseek', protocol: 'openai', modelName: 'deepseek-v4-flash',
  apiKey: 'k', baseUrl: 'https://api.deepseek.com', temperature: 0.7, maxTokens: 4096, purposes: ['generation'] } as ModelProfile

let form: ReturnType<typeof useBatchChapterForm> | undefined
let root: Root | undefined
let host: HTMLDivElement | undefined
const initialLocale = useLocaleStore.getState()

function Probe() {
  form = useBatchChapterForm({ isOpen: true, startChapterNumber: 1, onClose: () => undefined })
  return null
}

beforeEach(() => {
  win.aiNovelAPI = {
    invoke: async (channel) => {
      if (channel in replies) return replies[channel]
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => undefined,
  }
  useProjectStore.setState({
    currentProject: { id: SESSION.projectId, sessionLease: SESSION.leaseId, name: 'Lighthouse', path: SESSION.projectPath, novelConfig: { wordsPerChapter: 3000 } } as unknown as ProjectData,
  })
  setActiveProjectSessionContext(SESSION)
  useLLMStore.setState({ loaded: true, models: [MODEL], defaultModelId: 'flash' })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  form = undefined
  delete win.aiNovelAPI
  setActiveProjectSessionContext(null)
  useProjectStore.setState({ currentProject: null })
  useLocaleStore.setState(initialLocale, true)
})

it('日文界面下写作前置条件没满足：报出守卫给的具体原因，不换成写死的通用英文', async () => {
  useLocaleStore.setState({ interfaceLocale: 'ja-JP', locale: 'en-US' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<Probe />))

  await act(async () => form!.handleStart())

  expect(form!.error).toBe('No chapter blueprints have been generated.\n\nGenerate chapter blueprints first, then return to draft the chapter.')
})
