import {
  readJsonFile,
  tryReadJsonFile,
  writeJsonFile,
  MODELS_CONFIG_PATH,
  GLOBAL_CONFIG_PATH,
  DEFAULT_GLOBAL_CONFIG,
} from '../utils/config-utils'
import type { GlobalConfig, LLMRequest, LLMResponse, LocalContextWindowRequest, ModelDiscoveryRequest, ModelProfile } from '../../src/shared/ipc-channels'
import { IPC_HANDLER_FAILED, registeredErrorCode, wireNote } from '../../src/i18n/app-errors'
import type { MessageKey } from '../../src/i18n/messages/en-US'
import { authorOwned, failureCode, type FailureCode, type WireFailure, type WireNote } from '../../src/shared/failure'
import { isReasoningMapping, reasoningAdapterFitsProtocol } from '../../src/shared/reasoning-types'
import { isLocalModelEndpoint } from '../../src/shared/provider-presets'
import { connectionFailureCode } from '../../src/shared/connection-failure'
import { sameModelIdentity, withLearnedContextWindow } from '../../src/shared/model-profile-draft'
import { assignStageModel, availableGenerationModelId, isModelStage, parseStageModelIds, removeModelFromStages } from '../../src/shared/model-stage-routing'
import type { RerankFailure } from '../../src/shared/knowledge-ranking'
import { RerankError, requestOrder } from '../rerank'
import { LLMFactory } from '../llm/llm-factory'
import { resolveGenerationParameters } from '../llm/generation-parameter-policy'
import { ModelExecutionLeaseRegistry } from '../services/model-execution-lease'
import { ModelDiscoveryService } from '../services/model-discovery-service'
import { failedAtProxy } from '../network-proxy'
import { handle } from '../ipc/handle'

const CONNECTION_TEST_MAX_TOKENS = 1024
const LOCAL_CONNECTION_TEST_TIMEOUT_MS = 120_000
const CLOUD_CONNECTION_TEST_TIMEOUT_MS = 30_000

/** 本机模型冷启动要先把权重载入显存，常常超过 30 秒；云端卡住多是网络或代理问题，早点报出来。 */
function connectionTestTimeoutMs(model: ModelProfile): number {
  return isLocalModelEndpoint(model) ? LOCAL_CONNECTION_TEST_TIMEOUT_MS : CLOUD_CONNECTION_TEST_TIMEOUT_MS
}

const RERANK_TEST_NOTES = {
  timeout: 'error.rerankTestTimeout',
  'request-failed': 'error.rerankTestRequestFailed',
  'http-error': 'error.rerankTestHttpError',
  'invalid-response': 'error.rerankTestInvalidResponse',
} as const satisfies Record<RerankFailure, MessageKey>

const CONNECTION_TEST_FAILED = 'LLM_CONNECTION_TEST_FAILED'
const testFailure = (note: WireNote) => ({ success: false as const, failure: { code: CONNECTION_TEST_FAILED, note } satisfies WireFailure })
const registered = (error: unknown): FailureCode | undefined => failureCode(registeredErrorCode(error))

/** 设置写盘失败：已登记的码照传，其余原文只进日志。 */
function settingsFailure(error: unknown) {
  const code = registered(error)
  if (!code) console.error('[AI Novel Writer] 模型设置没有写进去:', error)
  return { success: false as const, failure: { code: code ?? IPC_HANDLER_FAILED } satisfies WireFailure }
}

async function testRerankConnection({ baseUrl, apiKey, modelName }: ModelProfile) {
  try {
    await requestOrder('hello', ['hello', 'world'], { baseUrl, apiKey, modelName }, 2)
    return { success: true as const }
  } catch (error) {
    if (!(error instanceof RerankError)) throw error
    return failedAtProxy(error.cause)
      ? { success: false as const, failure: { code: 'PROXY_UNREACHABLE' } satisfies WireFailure }
      : testFailure(wireNote(RERANK_TEST_NOTES[error.reason]))
  }
}

function loadModelConfigs(): ModelProfile[] {
  return readJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH, [])
}

function loadModelConfigsForUpdate(): ModelProfile[] {
  const result = tryReadJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH)
  if (result.status === 'error') {
    throw new Error('LLM_MODEL_CONFIG_CORRUPT', { cause: result.error })
  }
  return result.status === 'ok' ? result.value : []
}

function loadGlobalConfigForUpdate(): GlobalConfig {
  const result = tryReadJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH)
  if (result.status === 'error') {
    throw new Error('LLM_GLOBAL_CONFIG_CORRUPT', { cause: result.error })
  }
  return result.status === 'ok' ? result.value : { ...DEFAULT_GLOBAL_CONFIG }
}

function saveModelConfigs(models: ModelProfile[]) {
  writeJsonFile(MODELS_CONFIG_PATH, models)
}

function getModelConfig(modelId: string): ModelProfile | null {
  const models = loadModelConfigs()
  return models.find((m) => m.id === modelId) ?? null
}

function withStoredLearnedWindow(incoming: ModelProfile, stored: ModelProfile | undefined): ModelProfile {
  const learned = stored?.learnedContextWindow
  return { ...incoming, learnedContextWindow: learned && sameModelIdentity(learned, incoming) ? learned : undefined }
}

function rememberContextWindow(snapshot: ModelProfile, windowTokens: number): void {
  try {
    const models = loadModelConfigsForUpdate()
    const idx = models.findIndex((m) => m.id === snapshot.id)
    if (idx < 0 || !sameModelIdentity(models[idx], snapshot)) return
    const next = withLearnedContextWindow(models[idx], windowTokens)
    if (next === models[idx]) return
    models[idx] = next
    saveModelConfigs(models)
  } catch (error) {
    console.error('[AI Novel Writer] Could not remember the learned context window.', error)
  }
}

/**
 * 连接测试的结果由模型表单显示（#474）：要带上 HTTP 状态、供应商返回或建议地址的单独登记说明，
 * 其余登记过的码照传，网络失败按 cause.code 换成连接码。
 * 供应商返回、结束原因与建议地址出自作者自己配置的端点，master 上就逐字给作者看，所以作参数带过 IPC。
 */
function connectionTestFailure(failure: unknown) {
  const detail = failure as { code?: unknown; status?: unknown; suggestedBaseUrl?: unknown } | null
  if (detail?.code === 'EMBEDDING_REQUEST_FAILED') return testFailure(wireNote('error.connectionTestEmbeddingHttp', { status: Number(detail.status) }))
  if (detail?.code === 'EMBEDDING_OLLAMA_NATIVE_URL' && typeof detail.suggestedBaseUrl === 'string') {
    return testFailure(wireNote('error.connectionTestOllamaNativeUrl', { baseUrl: authorOwned(detail.suggestedBaseUrl) }))
  }
  const code = registered(failure) ?? (failedAtProxy(failure) ? 'PROXY_UNREACHABLE' : registered(connectionFailureCode(failure)))
  return { success: false as const, failure: { code: code ?? CONNECTION_TEST_FAILED } satisfies WireFailure }
}

function providerConnectionFailure(response: Extract<LLMResponse, { success: false }>) {
  if (response.error === 'LLM_REQUEST_FAILED' && response.httpFailure) {
    const { status, body } = response.httpFailure
    return testFailure(body.trim()
      ? wireNote('error.modelRequestHttpReturned', { status, body: authorOwned(body.trim()) })
      : wireNote('error.modelRequestHttp', { status }))
  }
  if (response.error === 'LLM_RESPONSE_INCOMPLETE') {
    return testFailure(wireNote('error.modelResponseIncomplete', { finishReason: authorOwned(response.finishReason) }))
  }
  return connectionTestFailure(response.error)
}

export function registerLLMController() {
  const modelExecutionLeases = new ModelExecutionLeaseRegistry({ loadModel: getModelConfig })
  const modelDiscovery = new ModelDiscoveryService()

  handle('llm:list-models', async () => loadModelConfigs())

  handle('llm:discover-local-context-window', async (_event, request: LocalContextWindowRequest) => {
    try {
      return await modelDiscovery.discoverLocalContextWindow(request)
    } catch {
      return null
    }
  })

  handle('llm:discover-models', async (_event, request: ModelDiscoveryRequest) => {
    try {
      return await modelDiscovery.discoverModels(request)
    } catch {
      return { success: false, reason: 'invalid_response' as const }
    }
  })

  handle('llm:save-model', async (_event, model: ModelProfile) => {
    try {
      if (model.reasoningMapping !== undefined && (!isReasoningMapping(model.reasoningMapping)
        || !reasoningAdapterFitsProtocol(model.protocol, model.reasoningMapping.adapter))) {
        throw new Error('INVALID_REASONING_MAPPING')
      }
      const models = loadModelConfigsForUpdate()
      const idx = models.findIndex((m) => m.id === model.id)
      if (idx >= 0) models[idx] = withStoredLearnedWindow(model, models[idx])
      else models.push(withStoredLearnedWindow(model, undefined))
      saveModelConfigs(models)
      return { success: true }
    } catch (error) {
      return settingsFailure(error)
    }
  })

  handle('llm:delete-model', async (_event, modelId: string) => {
    let originalConfig: GlobalConfig | undefined
    let configChanged = false
    try {
      const modelsRead = tryReadJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH)
      if (modelsRead.status === 'error') throw new Error('LLM_MODEL_CONFIG_CORRUPT', { cause: modelsRead.error })
      const originalModels = modelsRead.status === 'ok' ? modelsRead.value : []
      const configRead = tryReadJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH)
      if (configRead.status === 'error') throw new Error('LLM_GLOBAL_CONFIG_CORRUPT', { cause: configRead.error })
      originalConfig = configRead.status === 'ok'
        ? configRead.value
        : { ...DEFAULT_GLOBAL_CONFIG }

      const nextConfig = { ...originalConfig }
      if (nextConfig.defaultModelId === modelId) {
        nextConfig.defaultModelId = null
        configChanged = true
      }
      if (nextConfig.defaultEmbeddingModelId === modelId) {
        nextConfig.defaultEmbeddingModelId = null
        configChanged = true
      }
      if (nextConfig.defaultRerankModelId === modelId) {
        nextConfig.defaultRerankModelId = null
        configChanged = true
      }
      const stages = removeModelFromStages(parseStageModelIds(nextConfig.stageModelIds), modelId)
      if (stages.changed) {
        nextConfig.stageModelIds = stages.next
        configChanged = true
      }

      // 先清除引用，再删除被引用对象。若第二个文件写入失败，回滚配置；
      // 即使回滚也失败，配置中只会缺少默认值，不会悬空指向已删除模型。
      if (configChanged) writeJsonFile(GLOBAL_CONFIG_PATH, nextConfig)
      try {
        saveModelConfigs(originalModels.filter(model => model.id !== modelId))
      } catch (error) {
        if (configChanged) {
          try {
            writeJsonFile(GLOBAL_CONFIG_PATH, originalConfig)
          } catch (rollbackError) {
            console.error('[AI Novel Writer] Model deletion failed and the default model settings were not restored.', { error, rollbackError })
            throw new Error('LLM_DEFAULT_MODEL_ROLLBACK_FAILED', { cause: rollbackError })
          }
        }
        throw error
      }
      return {
        success: true,
        defaultModelId: nextConfig.defaultModelId,
        defaultEmbeddingModelId: nextConfig.defaultEmbeddingModelId ?? null,
        defaultRerankModelId: nextConfig.defaultRerankModelId ?? null,
        stageModelIds: parseStageModelIds(nextConfig.stageModelIds),
      }
    } catch (error) {
      return settingsFailure(error)
    }
  })

  handle('llm:get-stage-models', async () => {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    return parseStageModelIds(config.stageModelIds)
  })

  handle('llm:set-stage-model', async (_event, request: unknown) => {
    try {
      const { stage, modelId } = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>
      if (!isModelStage(stage) || (modelId !== null && typeof modelId !== 'string')) throw new Error('LLM_STAGE_MODEL_REQUEST_INVALID')
      const assignedId = modelId === null ? null : availableGenerationModelId(loadModelConfigsForUpdate(), modelId)
      if (modelId !== null && !assignedId) throw new Error('LLM_STAGE_MODEL_UNAVAILABLE')
      const config = loadGlobalConfigForUpdate()
      config.stageModelIds = assignStageModel(parseStageModelIds(config.stageModelIds), stage, assignedId)
      writeJsonFile(GLOBAL_CONFIG_PATH, config)
      return { success: true as const, stageModelIds: config.stageModelIds }
    } catch (error) {
      return settingsFailure(error)
    }
  })

  handle('llm:set-default-model', async (_event, modelId: string | null) => {
    try {
      const config = loadGlobalConfigForUpdate()
      config.defaultModelId = modelId
      writeJsonFile(GLOBAL_CONFIG_PATH, config)
      return { success: true }
    } catch (error) {
      return settingsFailure(error)
    }
  })

  handle('llm:get-default-model', async () => {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    return config.defaultModelId
  })

  handle('llm:set-default-embedding-model', async (_event, modelId: string | null) => {
    try {
      const config = loadGlobalConfigForUpdate()
      config.defaultEmbeddingModelId = modelId
      writeJsonFile(GLOBAL_CONFIG_PATH, config)
      return { success: true }
    } catch (error) {
      return settingsFailure(error)
    }
  })

  handle('llm:get-default-embedding-model', async () => {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    return config.defaultEmbeddingModelId ?? null
  })

  handle('llm:set-default-rerank-model', async (_event, modelId: string | null) => {
    try {
      const config = loadGlobalConfigForUpdate()
      config.defaultRerankModelId = modelId
      writeJsonFile(GLOBAL_CONFIG_PATH, config)
      return { success: true }
    } catch (error) {
      return settingsFailure(error)
    }
  })

  handle('llm:get-default-rerank-model', async () => {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    return config.defaultRerankModelId ?? null
  })

  handle('llm:test-connection', async (
    _event,
    model: ModelProfile,
    creativeStrategy: LLMRequest['creativeStrategy'] = 'auto',
  ) => {
    // 网络卡住时 undici 默认要等 300 秒才报 fetch failed；连接测试自己的截止时间会真正取消请求。
    const timeoutMs = connectionTestTimeoutMs(model)
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    const timedOut = () => testFailure(wireNote('error.connectionTestTimeout', { seconds: timeoutMs / 1000 }))
    try {
      if (model.purposes?.includes('rerank')) return await testRerankConnection(model)

      const messages = [{ role: 'user', content: 'Say "hello" and nothing else.' }]
      const provider = LLMFactory.getProvider(model)

      if (model.purposes?.includes('embedding')) {
        if (model.protocol === 'anthropic') return testFailure(wireNote('error.connectionTestEmbeddingUnsupported'))
        const { generateEmbeddings } = await import('../embedding')
        await generateEmbeddings(['hello'], model.protocol, model, undefined, undefined, deadline.signal)
      } else {
        const res = await provider.generate(
          model,
          messages,
          {
            ...resolveGenerationParameters(model, {
              // 推理模型可能先消耗 reasoning tokens；预算过小会把可用连接误判为截断失败。
              maxTokens: CONNECTION_TEST_MAX_TOKENS,
              reasoningStage: 'general',
              creativeStrategy,
            }),
            signal: deadline.signal,
          },
        )
        if (deadline.signal.aborted) return timedOut()
        if (!res.success) return providerConnectionFailure(res)
      }
      return { success: true as const }
    } catch (error) {
      return deadline.signal.aborted ? timedOut() : connectionTestFailure(error)
    } finally {
      clearTimeout(timer)
    }
  })

  return { modelExecutionLeases, loadModel: getModelConfig, rememberContextWindow }
}
