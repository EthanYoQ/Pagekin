import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import { requireIpcSuccess } from '../services/ipc-result'
import { alertError } from '../components/ui/AlertDialog'
import { authorError, caughtFailure, failureText, IPC_HANDLER_FAILED, resultFailure } from '../i18n/app-errors'
import { note, type AuthorNote, type Failure } from '../shared/failure'
import { currentInterfaceLocale, useLocaleStore } from './locale-store'
import type {
  LocalContextWindowRequest,
  ModelDiscoveryResult,
  ModelDiscoveryRequest,
  ModelProfile,
} from '../shared/ipc-channels'
import { removeModelFromStages, type ModelStage, type StageModelIds } from '../shared/model-stage-routing'
import { useProjectStore } from './project-store'

interface LLMState {
  models: ModelProfile[]
  defaultModelId: string | null
  defaultEmbeddingModelId: string | null
  defaultRerankModelId: string | null
  stageModelIds: StageModelIds
  loaded: boolean

  init: () => Promise<void>
  loadModels: () => Promise<void>
  saveModel: (model: ModelProfile) => Promise<boolean>
  deleteModel: (modelId: string) => Promise<boolean>
  setDefaultModel: (modelId: string) => Promise<boolean>
  setDefaultEmbeddingModel: (modelId: string) => Promise<boolean>
  setDefaultRerankModel: (modelId: string) => Promise<boolean>
  setStageModel: (stage: ModelStage, modelId: string | null) => Promise<boolean>
  testConnection: (model: ModelProfile) => Promise<{ success: boolean; failure?: Failure }>
  discoverModels: (request: ModelDiscoveryRequest) => Promise<ModelDiscoveryResult>
  discoverLocalContextWindow: (request: LocalContextWindowRequest) => Promise<number | null>
}

let initializationFlight: Promise<void> | null = null

/** IPC_HANDLER_FAILED 只是笼统的写失败，让给调用点自己的兜底句或通用说明。 */
function settingsFailureText(failure: Failure | undefined, fallback?: AuthorNote): string {
  return failureText(currentInterfaceLocale(), failure?.code === IPC_HANDLER_FAILED ? undefined : failure, { fallback })
}

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
      alertError(settingsFailureText(resultFailure(result), note('保存模型失败', 'Could not save the model.')), {
        title: text('模型设置保存失败', 'Model settings could not be saved'),
      })
    }
    return result.success
  },

  deleteModel: async (modelId) => {
    const result = await ipc.invoke('llm:delete-model', modelId)
    if (!result.success) {
      const { text } = useLocaleStore.getState()
      alertError(settingsFailureText(resultFailure(result), note('删除模型失败', 'Could not delete the model.')), {
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
      requireIpcSuccess(await ipc.invoke('llm:set-default-model', modelId), ['保存默认模型', 'save the default model', '既定モデルの保存'])
      set({ defaultModelId: modelId })
      return true
    } catch (error) {
      const { text } = useLocaleStore.getState()
      alertError(settingsFailureText(caughtFailure(error)), { title: text('模型设置保存失败', 'Model settings could not be saved') })
      return false
    }
  },

  setDefaultEmbeddingModel: async (modelId) => {
    try {
      requireIpcSuccess(
        await ipc.invoke('llm:set-default-embedding-model', modelId),
        ['保存默认向量模型', 'save the default embedding model', '既定の埋め込みモデルの保存'],
      )
      set({ defaultEmbeddingModelId: modelId })
      return true
    } catch (error) {
      const { text } = useLocaleStore.getState()
      alertError(settingsFailureText(caughtFailure(error)), { title: text('模型设置保存失败', 'Model settings could not be saved') })
      return false
    }
  },

  setDefaultRerankModel: async (modelId) => {
    try {
      requireIpcSuccess(await ipc.invoke('llm:set-default-rerank-model', modelId), ['保存默认重排模型', 'save the default rerank model', '既定のリランクモデルの保存'])
      set({ defaultRerankModelId: modelId })
      return true
    } catch (error) {
      const { text } = useLocaleStore.getState()
      alertError(settingsFailureText(caughtFailure(error)), { title: text('模型设置保存失败', 'Model settings could not be saved') })
      return false
    }
  },

  setStageModel: async (stage, modelId) => {
    try {
      const result = await ipc.invoke('llm:set-stage-model', { stage, modelId })
      if (!result.success) throw authorError(currentInterfaceLocale(), result.failure)
      set({ stageModelIds: result.stageModelIds })
      return true
    } catch (error) {
      const { text } = useLocaleStore.getState()
      alertError(settingsFailureText(caughtFailure(error)), { title: text('分工设置没有保存', 'The stage setting was not saved') })
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
