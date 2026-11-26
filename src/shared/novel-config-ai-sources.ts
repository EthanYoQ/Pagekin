export const AI_SOURCE_FIELDS = ['protagonistProfile', 'worldSetting', 'goldenFinger', 'writingStyle', 'globalGuidance', 'referenceWorks'] as const
export type AiSourceField = typeof AI_SOURCE_FIELDS[number]

export type AiSourceKind = 'filled' | 'expanded'
export type AiSources = Partial<Record<AiSourceField, { kind: AiSourceKind; hash: string }>>
type AiSourceText = { readonly [K in AiSourceField]?: unknown }

function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export const configText = (value: unknown): string => (typeof value === 'string' ? value : '')

const textOf = (config: AiSourceText, field: AiSourceField): string => configText(config[field])

export function aiSourceOf(config: AiSourceText, sources: AiSources | undefined, field: AiSourceField): AiSourceKind | null {
  const entry = sources?.[field]
  const value = textOf(config, field)
  return entry && value.trim() && entry.hash === fingerprint(value) ? entry.kind : null
}

export function recordAiSources(before: AiSourceText, sources: AiSources | undefined, written: AiSourceText): AiSources {
  const after = { ...before, ...written }
  const next: AiSources = {}
  for (const field of AI_SOURCE_FIELDS) {
    const value = textOf(after, field)
    const previous = aiSourceOf(before, sources, field)
    if (Object.hasOwn(written, field) && value.trim() && value !== textOf(before, field)) {
      const authorTextBefore = textOf(before, field).trim() !== '' && previous !== 'filled'
      next[field] = { kind: authorTextBefore ? 'expanded' : 'filled', hash: fingerprint(value) }
    } else if (previous) {
      next[field] = { kind: previous, hash: fingerprint(value) }
    }
  }
  return next
}

export function parseAiSources(raw: unknown): AiSources {
  let value = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { return {} }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const sources: AiSources = {}
  for (const field of AI_SOURCE_FIELDS) {
    const entry = (value as Record<string, unknown>)[field] as { kind?: unknown; hash?: unknown } | undefined
    if (entry && (entry.kind === 'filled' || entry.kind === 'expanded') && typeof entry.hash === 'string') {
      sources[field] = { kind: entry.kind, hash: entry.hash }
    }
  }
  return sources
}
