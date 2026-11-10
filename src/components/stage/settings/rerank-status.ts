import type { ModelProfile } from '../../../shared/ipc-channels'
import type { RerankConfig } from '../../../shared/rerank-config'

export function rerankStatus(config: RerankConfig, models: readonly ModelProfile[]): readonly [string, string] {
  switch (config.kind) {
    case 'none':
      return ['提升取材精度', 'Picks more relevant passages']
    case 'reuse-embedding':
      return ['已启用：跟随检索模型的服务', 'On: follows your retrieval service']
    case 'explicit': {
      const profile = models.find(model => model.id === config.profileId)
      const name = profile?.name || config.endpoint.modelName
      return [`已启用：${name}`, `On: ${name}`]
    }
  }
}
