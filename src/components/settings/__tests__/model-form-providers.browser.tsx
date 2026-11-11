import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

import type { ModelProfile } from '../../../shared/ipc-channels'
import { BUILTIN_PRESETS } from '../../../shared/provider-presets'
import { useLocaleStore } from '../../../stores/locale-store'
import { ModelForm } from '../ModelForm'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalLocaleState = useLocaleStore.getState()
let root: Root | undefined
let container: HTMLDivElement | undefined

const ALL_PROVIDERS = ['openai', 'novelai', 'deepseek', 'gemini', 'xai', 'siliconflow', 'ollama', 'bigmodel', 'bigmodel-anthropic', 'custom']

async function renderForm(purposes: ModelProfile['purposes']) {
  useLocaleStore.setState({ locale: 'zh-CN' })
  const onChange = vi.fn()
  const model: ModelProfile = {
    id: 'form-model', name: 'Form model', provider: 'openai', protocol: 'openai', modelName: 'm',
    apiKey: '', baseUrl: 'http://127.0.0.1:9/v1', temperature: 0.7, maxTokens: 4000, purposes,
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(
    <ModelForm model={model} onChange={onChange} onSave={vi.fn()} onCancel={vi.fn()} saving={false} purposeOptions={purposes} presets={BUILTIN_PRESETS} />,
  ))
  const providerSelect = container.querySelector('select')!
  return { onChange, providerSelect, values: [...providerSelect.options].map(option => option.value) }
}

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useLocaleStore.setState(originalLocaleState, true)
})

it('生成模型表单列出全部服务商，作者能选到 xAI', async () => {
  const { onChange, providerSelect, values } = await renderForm(['generation'])
  expect(values).toEqual(ALL_PROVIDERS)

  await act(async () => { await page.elementLocator(providerSelect).selectOptions('xai') })
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'xai' }))
})

it('向量模型表单除智谱 Anthropic 协议外列出全部服务商', async () => {
  const { values } = await renderForm(['embedding'])
  expect(values).toEqual(ALL_PROVIDERS.filter(provider => provider !== 'bigmodel-anthropic'))
})
