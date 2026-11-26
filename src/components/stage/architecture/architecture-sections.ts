import type { ArchStepKey } from '../../../services/architecture-step-selection'
import type { ArchitectureOverview } from '../../editor/use-architecture-overview'
import { plotOutlineLastChapter } from '../../../shared/plot-outline-contract'

type Text = (zh: string, en: string) => string

export const SECTION_ORDER: readonly ArchStepKey[] = ['premise', 'characters', 'worldbuilding', 'synopsis']

export const SECTION_NUMERALS: Record<ArchStepKey, string> = { premise: 'i', characters: 'ii', worldbuilding: 'iii', synopsis: 'iv' }

export type SectionBadge =
  | { kind: 'empty' }
  | { kind: 'ready' }
  | { kind: 'partial'; coveredTo: number; total: number }
  | { kind: 'incomplete' }
  | { kind: 'candidate' }
  | { kind: 'attention'; label: string }

export function sectionBadge(key: ArchStepKey, overview: ArchitectureOverview): SectionBadge {
  if (overview.confirmed[key]) return { kind: 'ready' }
  if (key === 'characters') {
    const presentation = overview.roster.presentation
    return presentation && presentation.kind !== 'ready' && presentation.kind !== 'empty' ? { kind: 'attention', label: presentation.label } : { kind: 'empty' }
  }
  if (key === 'synopsis') {
    const { progress, candidate } = overview.synopsis
    switch (progress.kind) {
      case 'partial': return { kind: 'partial', coveredTo: progress.coveredTo, total: progress.total }
      case 'interrupted':
      case 'unresumable': return { kind: 'incomplete' }
      case 'empty':
      case 'complete':
        if (candidate) return { kind: 'candidate' }
        return synopsisStarted(overview) ? { kind: 'incomplete' } : { kind: 'empty' }
      default: return progress satisfies never
    }
  }
  if (key === 'worldbuilding' && overview.worldBuilding.candidate) return { kind: 'candidate' }
  return overview.archStatus[key] ? { kind: 'incomplete' } : { kind: 'empty' }
}

function synopsisStarted(overview: ArchitectureOverview): boolean {
  return Boolean(overview.archStatus.synopsis) && plotOutlineLastChapter(overview.contents.synopsis ?? '') !== 0
}

export function badgeText(badge: SectionBadge, text: Text): string {
  switch (badge.kind) {
    case 'empty': return text('待生成', 'Not started')
    case 'ready': return text('已确认', 'Confirmed')
    case 'partial': return text(`部分完成 · ${badge.coveredTo} / ${badge.total} 章`, `Partial · ${badge.coveredTo} / ${badge.total} ch.`)
    case 'incomplete': return text('不完整', 'Incomplete')
    case 'candidate': return text('有未完成候选', 'Unfinished candidate')
    case 'attention': return badge.label
  }
}

export type BadgeTone = 'ok' | 'warn' | 'muted'

export function badgeTone(badge: SectionBadge): BadgeTone {
  if (badge.kind === 'ready') return 'ok'
  return badge.kind === 'empty' ? 'muted' : 'warn'
}

export type ArchitectureMainAction = 'generate' | 'continue' | 'next'

export function mainAction(filled: number, total: number): ArchitectureMainAction {
  if (filled >= total) return 'next'
  return filled === 0 ? 'generate' : 'continue'
}

export function excerpt(markdown: string, ellipsis: string, limit = 90): string {
  const body = markdown.replace(/^#{1,6}\s+.*$/gm, '').trim()
  const plain = (body || markdown.replace(/^#{1,6}\s+/gm, ''))
    .replace(/[*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > limit ? `${plain.slice(0, limit)}${ellipsis}` : plain
}
