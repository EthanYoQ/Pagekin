import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StoreApi } from 'zustand'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ModelProfile } from '../../../../shared/ipc-channels'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import StageSettings from '../StageSettings'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>
const win = window as unknown as { aiNovelAPI?: { invoke: Invoke; on: () => () => void } }

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [snapshot(useLayoutStore), snapshot(useLLMStore), snapshot(useLocaleStore)]

const MODEL = { id: 'flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', protocol: 'openai', modelName: 'deepseek-v4-flash',
  apiKey: 'k', baseUrl: 'https://api.deepseek.com', temperature: 0.7, maxTokens: 4096, purposes: ['generation'] } as ModelProfile

let root: Root | undefined
let host: HTMLDivElement | undefined
let finishListRead: (() => void) | null

const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find(candidate => candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name)
const nameInput = () => host!.querySelector<HTMLInputElement>('input[placeholder="如：DeepSeek 主力 / GPT-4o 备用"]')

async function click(element: HTMLElement | undefined) {
  expect(element, '要点击的按钮存在').toBeTruthy()
  await act(async () => element!.click())
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  finishListRead = null
  win.aiNovelAPI = {
    invoke: async channel => {
      if (channel === 'llm:list-models') {
        await new Promise<void>(resolve => { finishListRead = resolve })
        return [MODEL]
      }
      return channel === 'config:get' ? {} : undefined
    },
    on: () => () => undefined,
  }
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLLMStore.setState({ loaded: true, models: [MODEL], defaultModelId: 'flash', defaultEmbeddingModelId: null })
  useLayoutStore.setState({ settingsOpen: true, settingsSection: 'llm' })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1200px; height: 860px; display: flex;'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageSettings library={false} />))
})

afterEach(async () => {
  finishListRead?.()
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  delete win.aiNovelAPI
  for (const restore of restores) restore()
})

describe('模型编辑', () => {
  it('点编辑不等主进程的模型列表就打开表单；列表这时才回来也不覆盖正在填的内容', async () => {
    await click(button('编辑「DeepSeek V4 Flash」'))
    expect(nameInput(), '点编辑后表单已打开').not.toBeNull()
    await type(nameInput()!, '改过的名字')

    await act(async () => finishListRead?.())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })

    expect(nameInput()?.value).toBe('改过的名字')
  })
})
