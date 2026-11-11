import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import { requireIpcSuccess } from '../services/ipc-result'
import { alertError } from '../components/ui/AlertDialog'
import { displayedErrorMessage } from '../i18n/app-errors'
import { useLocaleStore } from './locale-store'
import type {
  LocalContextWindowRequest,
  ModelDiscoveryResult,
  ModelDiscoveryRequest,
  ModelProfile,
} from '../shared/ipc-channels'
import { removeModelFromStages, type ModelStage, type StageModelIds } from '../shared/model-stage-routing'
import { useProjectStore } from './project-store'

interface LLMState {
  /** 已配置的模型列表 */
  models: ModelProfile[]
  /** 当前默认生成模型 ID */
  defaultModelId: string | null
  /** 当前默认向量模型 ID */
  defaultEmbeddingModelId: string | null
  defaultRerankModelId: string | null
  stageModelIds: StageModelIds
  /** 是否已加载模型配置 */
  loaded: boolean

  // ===== Actions =====
  /** 初始化（加载模型列表 + 默认模型 ID） */
  init: () => Promise<void>
  /** 加载模型列表 */
  loadModels: () => Promise<void>
  /** 保存模型 */
  saveModel: (model: ModelProfile) => Promise<boolean>
  /** 删除模型 */
  deleteModel: (modelId: string) => Promise<boolean>
  /** 设置默认生成模型（持久化到 ~/.vela/config.json） */
  setDefaultModel: (modelId: string) => Promise<boolean>
  /** 设置默认向量模型（持久化到 ~/.vela/config.json） */
  setDefaultEmbeddingModel: (modelId: string) => Promise<boolean>
  setDefaultRerankModel: (modelId: string) => Promise<boolean>
  setStageModel: (stage: ModelStage, modelId: string | null) => Promise<boolean>
  /** 测试模型连接 */
  testConnection: (model: ModelProfile) => Promise<{ success: boolean; error?: string }>
  /** 以当前表单中的端点和凭据主动发现 provider 模型。 */
  discoverModels: (request: ModelDiscoveryRequest) => Promise<ModelDiscoveryResult>
  discoverLocalContextWindow: (request: LocalContextWindowRequest) => Promise<number | null>
}

let initializationFlight: Promise<void> | null = null

export const useLLMStore = create<LLMState>()((set, get) => ({
  models: [],
  defaultModelId: null,
  defaultEmbeddingModelId: null,
  defaultRerankModelId: null,
  stageModelIds: {},
  loaded: false,

  init: () => {
    if (get().loaded) return Promise.resolve()
    if (initializationFlight) return initializationFlight

    const flight = (async () => {
      if (!ipc.isElectron) {
        set({ loaded: true })
        return
      }
      const [models, defaultModelId, defaultEmbeddingModelId, defaultRerankModelId, stageModelIds] = await Promise.all([
        ipc.invoke('llm:list-models'),
        ipc.invoke('llm:get-default-model'),
        ipc.invoke('llm:get-default-embedding-model'),
        ipc.invoke('llm:get-default-rerank-model'),
        ipc.invoke('llm:get-stage-models'),
      ])
      set({
        models,
        defaultModelId,
        defaultEmbeddingModelId,
        defaultRerankModelId,
        stageModelIds,
        loaded: true,
      })
    })().finally(() => {
      if (initializationFlight === flight) initializationFlight = null
    })
    initializationFlight = flight
    return flight
  },

  loadModels: async () => {
    if (!ipc.isElectron) return
    const models = await ipc.invoke('llm:list-models')
    set({ models })
  },

  saveModel: async (model) => {
    const result = await ipc.invoke('llm:save-model', model)
    if (result.success) {
      await get().loadModels()
    } else {
      const { text } = useLocaleStore.getState()
      alertError(text('保存模型失败', 'Could not save the model.'), {
        title: text('模型设置保存失败', 'Model settings could not be saved'),
      })
    }
    return result.success
  },

  deleteModel: async (modelId) => {
    const result = await ipc.invoke('llm:delete-model', modelId)
    if (!result.success) {
      const { locale, text } = useLocaleStore.getState()
      alertError(displayedErrorMessage(locale, result.error, text('删除模型失败', 'Could not delete the model.')), {
        title: text('模型删除失败', 'Could not delete the model'),
      })
      return false
    }
    await get().loadModels()
    set(state => ({
      defaultModelId: result.defaultModelId ?? null,
      defaultEmbeddingModelId: result.defaultEmbeddingModelId ?? null,
      defaultRerankModelId: result.defaultRerankModelId ?? null,
      stageModelIds: removeModelFromStages(state.stageModelIds, modelId).next,
    }))
    return true
  },

  setDefaultModel: async (modelId) => {
    try {
      requireIpcSuccess(await ipc.invoke('llm:set-default-model', modelId), '保存默认模型')
      set({ defaultModelId: modelId })
      return true
    } catch (error) {
      const { locale, text } = useLocaleStore.getState()
      alertError(displayedErrorMessage(locale, error), { title: text('模型设置保存失败', 'Model settings could not be saved') })
      return false
    }
  },

  setDefaultEmbeddingModel: async (modelId) => {
    try {
      requireIpcSuccess(
        await ipc.invoke('llm:set-default-embedding-model', modelId),
        '保存默认向量模型',
      )
      set({ defaultEmbeddingModelId: modelId })
      return true
    } catch (error) {
      const { locale, text } = useLocaleStore.getState()
      alertError(displayedErrorMessage(locale, error), { title: text('模型设置保存失败', 'Model settings could not be saved') })
      return false
    }
  },

  setDefaultRerankModel: async (modelId) => {
    try {
      requireIpcSuccess(await ipc.invoke('llm:set-default-rerank-model', modelId), '保存默认重排模型')
      set({ defaultRerankModelId: modelId })
      return true
    } catch (error) {
      const { locale, text } = useLocaleStore.getState()
      alertError(displayedErrorMessage(locale, error), { title: text('模型设置保存失败', 'Model settings could not be saved') })
      return false
    }
  },

  setStageModel: async (stage, modelId) => {
    try {
      const result = await ipc.invoke('llm:set-stage-model', { stage, modelId })
      if (!result.success) throw new Error(result.error)
      set({ stageModelIds: result.stageModelIds })
      return true
    } catch (error) {
      const { locale, text } = useLocaleStore.getState()
      alertError(displayedErrorMessage(locale, error), { title: text('分工设置没有保存', 'The stage setting was not saved') })
      return false
    }
  },

  testConnection: async (model) => {
    return ipc.invoke(
      'llm:test-connection',
      model,
      useProjectStore.getState().currentProject?.novelConfig.creativeStrategy ?? 'auto',
    )
  },

  discoverModels: async (request) => ipc.invoke('llm:discover-models', request),
  discoverLocalContextWindow: async (request) => ipc.invoke('llm:discover-local-context-window', request),
}))
