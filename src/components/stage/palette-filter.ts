import type { StagePalette as PaletteMode } from '../../stores/navigation/stage-store'

export type PaletteGroup = 'stage' | 'chapter' | 'reference' | 'action'

export interface PaletteItem {
  id: string
  group: PaletteGroup
  label: string
  meta?: string
  chapter?: number
  keywords?: string
  run: () => void
}

export function paletteItem(group: PaletteGroup, item: Omit<PaletteItem, 'group'>): PaletteItem {
  return { ...item, group }
}

export const GROUP_ORDER: readonly PaletteGroup[] = ['stage', 'chapter', 'reference', 'action']
export const GROUP_LABELS: Record<PaletteGroup, [string, string]> = {
  stage: ['阶段', 'Stages'],
  chapter: ['章节', 'Chapters'],
  reference: ['作品资料', 'Reference'],
  action: ['操作', 'Actions'],
}

const squash = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, '')

export function chapterQuery(query: string): number | null {
  const match = /^(?:第|chapter|ch\.?)?(\d+)(?:章)?$/.exec(squash(query))
  return match ? Number(match[1]) : null
}

export function filterPalette(items: readonly PaletteItem[], query: string, mode: PaletteMode): PaletteItem[] {
  const pool = mode === 'chapters' ? items.filter(item => item.group === 'chapter') : items
  const needle = squash(query)
  const number = chapterQuery(query)
  const rank = (item: PaletteItem) => item.chapter !== undefined && item.chapter === number ? 0 : squash(item.label).startsWith(needle) ? 1 : 2
  return pool
    .filter(item => !needle || (number !== null && item.chapter === number) || squash(`${item.label}${item.keywords ?? ''}`).includes(needle))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => GROUP_ORDER.indexOf(a.item.group) - GROUP_ORDER.indexOf(b.item.group) || rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item)
}
