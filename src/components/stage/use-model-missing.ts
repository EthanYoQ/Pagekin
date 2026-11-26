import { useLLMStore } from '../../stores/llm-store'
import { routeStageModel, type ModelStage } from '../../shared/model-stage-routing'

export function useModelMissing(stage: ModelStage): boolean {
  return useLLMStore(s => s.loaded && !routeStageModel(stage, s).modelId)
}
