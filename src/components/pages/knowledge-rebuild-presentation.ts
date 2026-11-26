import type { VectorRebuildStatus } from '../../services/knowledge-service'

export interface VectorRebuildPresentation {
  kind: 'missing-vectors' | 'check-current-model'
  title: { zhCN: string; enUS: string }
  action: { zhCN: string; enUS: string }
}

export function getVectorRebuildPresentation(
  status: VectorRebuildStatus | null,
): VectorRebuildPresentation | null {
  if (!status?.embeddingConfigured || !status.canRebuild) return null
  if (status.vectorlessCount > 0) {
    return {
      kind: 'missing-vectors',
      title: {
        zhCN: '向量索引待补全',
        enUS: 'Vector index needs completion',
      },
      action: {
        zhCN: '检查并重建向量索引',
        enUS: 'Check and rebuild vector index',
      },
    }
  }
  return {
    kind: 'check-current-model',
    title: {
      zhCN: '检查当前模型的向量索引',
      enUS: 'Check the current model vector index',
    },
    action: {
      zhCN: '检查并重建向量索引',
      enUS: 'Check and rebuild vector index',
    },
  }
}
