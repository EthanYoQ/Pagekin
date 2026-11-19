/**
 * 设定细则里哪些项的当前内容出自 AI。
 *
 * 每项记 AI 写入时那段文字的指纹；读的时候指纹和当前内容对得上才算 AI 的。
 * 作者、Agent 提案或任何别的写入改了这一项，指纹就对不上，标记自然消失，不用每条写入路径各自去清。
 */
export const AI_SOURCE_FIELDS = ['protagonistProfile', 'worldSetting', 'goldenFinger', 'writingStyle', 'globalGuidance', 'referenceWorks'] as const
export type AiSourceField = typeof AI_SOURCE_FIELDS[number]

/** filled：整项由 AI 写；expanded：AI 在作者原文后面补写。 */
export type AiSourceKind = 'filled' | 'expanded'
export type AiSources = Partial<Record<AiSourceField, { kind: AiSourceKind; hash: string }>>
type AiSourceText = { readonly [K in AiSourceField]?: unknown }

/** FNV-1a 32 位。只用来判断「还是不是 AI 写的那段」，不防篡改。 */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 读出的设定值类型不对时按空文本算：坏数据不让设定页、流程脊或 AI 补全崩。 */
export const configText = (value: unknown): string => (typeof value === 'string' ? value : '')

const textOf = (config: AiSourceText, field: AiSourceField): string => configText(config[field])

/** 这一项此刻是不是 AI 的内容；作者改过、空着或记录对不上都是 null。 */
export function aiSourceOf(config: AiSourceText, sources: AiSources | undefined, field: AiSourceField): AiSourceKind | null {
  const entry = sources?.[field]
  const value = textOf(config, field)
  return entry && value.trim() && entry.hash === fingerprint(value) ? entry.kind : null
}

/** filled：原来空着或原来就是 AI 写的；expanded：原来有作者内容；没变的项保留仍然有效的旧标记。 */
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

/** 从库里读出的标记：认不出的项丢掉，整段坏了当作没有标记（都按作者内容显示）。 */
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
