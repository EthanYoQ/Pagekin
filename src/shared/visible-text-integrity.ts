import { localize } from '../i18n/core'
import type { Locale } from '../i18n/types'
import { AuthorError, note } from './failure'

export const ZH_CN_TRUNCATION_MARKER = '\n…[内容已按上下文预算截断]…\n'
export const EN_US_TRUNCATION_MARKER = '\n…[content truncated to fit the context budget]…\n'
const MAX_META_OPENING_VISIBLE_UNITS = 200
const MIN_OBVIOUS_DUPLICATE_PARAGRAPH_VISIBLE_UNITS = 120

export function visibleProseUnitCount(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0
}

const INCOMPLETE = {
  blank: note('AI 输出包含空白或无可见正文，可能仍不完整，结果未被保存。', 'AI output contains blank or no visible prose and may still be incomplete, so it was not saved.'),
  fence: note('AI 输出包含代码围栏，可能仍不完整，结果未被保存。', 'AI output contains a code fence and may still be incomplete, so it was not saved.'),
  think: note('AI 输出包含 think 标签残片，可能仍不完整，结果未被保存。', 'AI output contains a leftover think tag and may still be incomplete, so it was not saved.'),
  truncation: note('AI 输出包含截断标记，可能仍不完整，结果未被保存。', 'AI output contains a truncation marker and may still be incomplete, so it was not saved.'),
  duplicate: note('AI 输出包含明显重复段落，可能仍不完整，结果未被保存。', 'AI output contains an obviously duplicated paragraph and may still be incomplete, so it was not saved.'),
  meta: note('AI 输出包含首段元话术，可能仍不完整，结果未被保存。', 'AI output contains opening meta commentary and may still be incomplete, so it was not saved.'),
}

function mechanicalCompletionError(uiLocale: Locale, kind: keyof typeof INCOMPLETE): AuthorError {
  const reason = INCOMPLETE[kind]
  return new AuthorError({ note: reason }, localize(uiLocale, reason.copy!.zh, reason.copy!.en))
}

export function assertMechanicallyCompleteVisibleText(content: string, uiLocale: Locale, source = ''): void {
  const trimmed = content.trim()
  if (visibleProseUnitCount(trimmed) === 0) {
    throw mechanicalCompletionError(uiLocale, 'blank')
  }
  if (/(?:^|\n)\s*```/u.test(trimmed)) {
    throw mechanicalCompletionError(uiLocale, 'fence')
  }
  if (/<\/?\s*think(?:\s|>|$)/iu.test(trimmed)) {
    throw mechanicalCompletionError(uiLocale, 'think')
  }

  const paragraphs = trimmed
    .split(/\n\s*\n+/u)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
  const opening = trimmed.split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? ''
  if (
    visibleProseUnitCount(opening) <= MAX_META_OPENING_VISIBLE_UNITS
    && (
      /^(?:以下|下面)(?:是|为)(?:(?:根据|按照)(?:您|用户)(?:的)?(?:要求|指示))?(?:(?:修订|修改|重写|生成|完成|提供)(?:后)?的?)?(?:完整的?)?(?:正文|章节(?:正文)?|内容)\s*(?:[：:]|[。.!！]?$)/u.test(opening)
      || /^(?:(?:certainly|as\s+requested)[,!:]?\s+)?(?:here|below)\s+is\s+(?:(?:the|your)\s+)?(?:(?:revised|rewritten|generated|complete|full|updated|requested)\s+)*(?:text|chapter|content|revision|version|draft|prose)\s*(?:[:：]|[.!]?$)/iu.test(opening)
      || /^(?:(?:根据|按照)(?:您|用户).{0,40}(?:要求|指示)|这是(?:我为您|根据您的要求)).{0,30}(?:修订|修改|重写|生成|提供).{0,10}(?:正文|章节|内容)[。！：:]?$/u.test(opening)
      || /^(?:(?:as\s+requested|certainly)[,!:]?\s+)?i(?:'ve|\s+have|\s+will)\s+(?:revised|rewritten|generated|provide|write|revise)\s+(?:(?:the|your|this|complete|full|revised)\s+)*(?:text|chapter|content|revision|version|draft|prose)[.!:：]?$/iu.test(opening)
    )
  ) {
    throw mechanicalCompletionError(uiLocale, 'meta')
  }

  if (
    trimmed.includes(ZH_CN_TRUNCATION_MARKER.trim())
    || trimmed.includes(EN_US_TRUNCATION_MARKER.trim())
    || paragraphs.some(paragraph => /^(?:…\s*)?(?:\[(?:内容已按上下文预算截断|内容截断|输出被截断|content truncated to fit the context budget|truncated)\]|[（(]?(?:未完待续|未完)[）)]?)(?:\s*…)?$/iu.test(paragraph))
  ) {
    throw mechanicalCompletionError(uiLocale, 'truncation')
  }

  const groups = [(text: string) => text.split(/\n\s*\n+/u), (text: string) => text.split(/\r?\n/u)]
  for (const split of groups) {
    const sourceCounts = new Map<string, number>()
    for (const paragraph of split(source)) {
      const normalized = paragraph.replace(/\s+/gu, ' ').trim()
      sourceCounts.set(normalized, (sourceCounts.get(normalized) ?? 0) + 1)
    }
    const seenParagraphs = new Map<string, number>()
    const candidates = split(trimmed)
    for (const paragraph of candidates) {
      const normalized = paragraph.replace(/\s+/gu, ' ').trim()
      if (visibleProseUnitCount(normalized) < MIN_OBVIOUS_DUPLICATE_PARAGRAPH_VISIBLE_UNITS) continue
      const count = (seenParagraphs.get(normalized) ?? 0) + 1
      if (count > Math.max(1, sourceCounts.get(normalized) ?? 0)) {
        throw mechanicalCompletionError(uiLocale, 'duplicate')
      }
      seenParagraphs.set(normalized, count)
    }
  }
}
