import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import type { ModelProfile } from '../../../shared/ipc-channels'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import AgentInputBox from '../agent/AgentInputBox'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const profile = (id: string, name: string, purposes: ModelProfile['purposes']): ModelProfile => ({
  id, name, provider: 'custom', protocol: 'openai', modelName: id, apiKey: 'k', baseUrl: 'https://example.test/v1', temperature: 0.7, maxTokens: 4096, purposes,
})

const originalLLM = useLLMStore.getState()
const originalLocale = useLocaleStore.getState()
let root: Root
let container: HTMLDivElement

beforeEach(async () => {
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLLMStore.setState({
    loaded: true,
    defaultModelId: 'writer',
    models: [profile('writer', '写稿模型', ['generation']), profile('finder', '检索专用', ['embedding']), profile('ranker', '重排专用', ['rerank'])],
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<AgentInputBox />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useLLMStore.setState(originalLLM, true)
  useLocaleStore.setState(originalLocale, true)
})

it('助手的模型菜单只列含生成用途的档案', async () => {
  const trigger = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('写稿模型'))!
  await act(async () => trigger.click())
  const text = container.textContent ?? ''
  expect(text).toContain('写稿模型')
  expect(text).not.toContain('重排专用')
  expect(text).not.toContain('检索专用')
})
