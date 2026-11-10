import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import type { ModelDiscoveryRequest, ModelDiscoveryResult, ModelProfile } from '../../../../shared/ipc-channels'
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

const EMBEDDING: ModelProfile = {
  id: 'embedding', name: '检索', provider: 'siliconflow', protocol: 'openai', modelName: 'BAAI/bge-m3',
  apiKey: 'sk-fake-embedding', baseUrl: 'https://api.siliconflow.cn/v1', temperature: 0.7, maxTokens: 0, purposes: ['embedding'],
}
const RERANK: ModelProfile = {
  id: 'rerank', name: '我的重排', provider: 'custom', protocol: 'openai', modelName: 'my-reranker',
  apiKey: 'sk-fake-rerank', baseUrl: 'https://rerank.example/v1', temperature: 0.7, maxTokens: 4096, purposes: ['rerank'],
}

let root: Root | undefined
let host: HTMLDivElement | undefined
let models: ModelProfile[]
let invoke: ReturnType<typeof vi.fn<Invoke>>
let discoverModels: ReturnType<typeof vi.fn<(request: ModelDiscoveryRequest) => Promise<ModelDiscoveryResult>>>

async function mount(defaultRerankModelId: string | null, profiles: ModelProfile[] = [EMBEDDING]) {
  models = profiles
  useLLMStore.setState({ loaded: true, models: profiles, defaultModelId: null, defaultEmbeddingModelId: 'embedding', defaultRerankModelId, discoverModels })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1200px; height: 860px; display: flex;'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageSettings library={false} />))
}

const section = () => host!.querySelector<HTMLElement>('[data-rerank-section]')!
const toggle = () => section().querySelector<HTMLButtonElement>('button[aria-expanded]')!
const button = (name: string) => [...section().querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === name)
const expand = () => act(async () => toggle().click())
const selects = () => [...section().querySelectorAll('select')]

async function setValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
const keyInput = () => section().querySelector<HTMLInputElement>('input[type="password"]')!

beforeEach(() => {
  discoverModels = vi.fn(async () => ({ success: true, models: [] }))
  invoke = vi.fn<Invoke>(async (channel, ...args) => {
    if (channel === 'config:get') return {}
    if (channel === 'llm:list-models') return models
    if (channel === 'llm:save-model') { models = [...models, args[0] as ModelProfile]; return { success: true } }
    if (channel === 'llm:set-default-rerank-model') return { success: true }
    if (channel === 'llm:delete-model') { models = models.filter(model => model.id !== args[0]); return { success: true, defaultModelId: null, defaultEmbeddingModelId: 'embedding', defaultRerankModelId: null } }
    if (channel === 'kb:get-vector-rebuild-status') return { embeddingConfigured: true, canRebuild: false, totalChunks: 0, vectorlessCount: 0, activeVectorDimension: 0 }
    return undefined
  })
  win.aiNovelAPI = { invoke, on: () => () => undefined }
  useLayoutStore.setState({ settingsOpen: true, settingsSection: 'embedding' })
  useLocaleStore.setState({ locale: 'zh-CN' })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  delete win.aiNovelAPI
  for (const restore of restores) restore()
})

describe('检索模型页的重排分区', () => {
  it('没配重排时收成一行可选说明，没有报错样式', async () => {
    await mount(null)
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(section().textContent).toContain('重排模型（可选）')
    expect(section().textContent).toContain('可选，提升取材精度')
    expect(section().querySelector('.pi-notice')).toBeNull()
    expect(section().textContent).not.toMatch(/必需|失败|错误|自动复用/)
    expect(section().querySelector('ul')).toBeNull()
  })

  it('展开后写一句隐私说明，文案不含端点和 Key', async () => {
    await mount('rerank', [EMBEDDING, RERANK])
    await expand()
    expect(section().textContent).toContain('取材和查找时，最多 40 段稿件会发到你配的重排服务。')
    expect(section().textContent).not.toMatch(/rerank\.example|sk-fake/)
    expect(section().textContent).not.toContain('自动复用')
  })

  it('新建档案后保存并设为默认，状态变成已启用', async () => {
    await mount(null)
    await expand()
    await act(async () => button('添加重排模型')!.click())
    await setValue(keyInput(), 'sk-fake-new')
    await act(async () => button('保存配置')!.click())
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('llm:set-default-rerank-model', expect.any(String)))
    const saved = invoke.mock.calls.find(([channel]) => channel === 'llm:save-model')![1] as ModelProfile
    expect(saved).toMatchObject({ purposes: ['rerank'], protocol: 'openai', provider: 'siliconflow', modelName: 'BAAI/bge-reranker-v2-m3', apiKey: 'sk-fake-new' })
    await vi.waitFor(() => expect(section().textContent).toContain(`已启用：${saved.name}`))
  })

  it('删除默认重排档案后回到未配置', async () => {
    await mount('rerank', [EMBEDDING, RERANK])
    expect(section().textContent).toContain('已启用：我的重排')
    await act(async () => useLLMStore.getState().deleteModel('rerank'))
    expect(section().textContent).toContain('可选，提升取材精度')
    expect(section().textContent).not.toContain('已启用')
    expect(section().querySelector('.pi-notice')).toBeNull()
  })

  it('表单只列有重排模型的服务商和自定义，协议不让选，也没有生成和向量的设置', async () => {
    await mount(null)
    await expand()
    await act(async () => button('添加重排模型')!.click())
    expect(selects()).toHaveLength(1)
    expect([...selects()[0]!.options].map(option => option.value)).toEqual(['siliconflow', 'bigmodel', 'custom'])
    expect(section().textContent).not.toMatch(/调用协议|上下文窗口|高级设置|向量化高级参数/)
  })

  it('换服务商时清掉 Key，自动拉列表只发往新端点并带新 Key', async () => {
    await mount(null)
    await expand()
    await act(async () => button('添加重排模型')!.click())
    await setValue(keyInput(), 'sk-fake-old')
    await setValue(selects()[0]!, 'bigmodel')
    expect(keyInput().value).toBe('')
    expect(section().querySelector<HTMLInputElement>('input[role="combobox"]')!.value).toBe('rerank')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)) })
    expect(discoverModels.mock.calls.filter(([request]) => request.apiKey === 'sk-fake-old' && request.baseUrl.includes('bigmodel'))).toEqual([])
    discoverModels.mockClear()
    await setValue(keyInput(), 'sk-fake-new')
    await vi.waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(1), { timeout: 3_000 })
    expect(discoverModels.mock.calls[0]![0]).toMatchObject({ provider: 'bigmodel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-fake-new', purposes: ['rerank'] })
  })

  it('英文界面显示英文', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    await mount(null)
    expect(section().textContent).toContain('Reranking model (optional)')
    expect(section().textContent).toContain('Optional. Picks more relevant passages.')
    await expand()
    expect(section().textContent).toContain('When gathering material or searching, up to 40 passages of your manuscript are sent to the service you set here.')
  })

  it('已启用状态英文写法', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    await mount('rerank', [EMBEDDING, RERANK])
    expect(section().textContent).toContain('On: 我的重排')
  })
})
