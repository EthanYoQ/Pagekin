export interface EmbeddingOptions {
  chunkSize: number
  chunkOverlap: number
  batchSize: number
}

export type EmbeddingModel = { provider: string; baseUrl: string; apiKey: string; modelName?: string; embeddingOptions?: EmbeddingOptions }

export const DEFAULT_EMBEDDING_OPTIONS: EmbeddingOptions = {
  chunkSize: 500,
  chunkOverlap: 50,
  batchSize: 50,
}

export const LOW_VRAM_EMBEDDING_OPTIONS: EmbeddingOptions = {
  chunkSize: 300,
  chunkOverlap: 30,
  batchSize: 4,
}

function readInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

export function normalizeEmbeddingOptions(options?: Partial<EmbeddingOptions> | null): EmbeddingOptions {
  const chunkSize = Math.min(4000, Math.max(100, readInteger(options?.chunkSize, DEFAULT_EMBEDDING_OPTIONS.chunkSize)))
  const chunkOverlap = Math.min(chunkSize - 1, Math.max(0, readInteger(options?.chunkOverlap, DEFAULT_EMBEDDING_OPTIONS.chunkOverlap)))
  const batchSize = Math.min(50, Math.max(1, readInteger(options?.batchSize, DEFAULT_EMBEDDING_OPTIONS.batchSize)))

  return { chunkSize, chunkOverlap, batchSize }
}
