import type { OutlineProgress } from '../shared/plot-outline-checkpoint'

export type ArchStepKey = 'premise' | 'characters' | 'worldbuilding' | 'synopsis'

type ArchCoreKey = Exclude<ArchStepKey, 'characters'>

export function archSectionHasContent(value: string | null | undefined): boolean {
  return Boolean(value?.trim())
}

export function judgeArchCore(
  core: Partial<Record<ArchCoreKey, string | null>> | null | undefined,
  synopsisProgress: OutlineProgress['kind'],
): { hasContent: Record<ArchCoreKey, boolean>; confirmed: Record<ArchCoreKey, boolean> } {
  const confirmedProse = (value: string | null | undefined) => archSectionHasContent(value) && (value ?? '').length > 50
  return {
    hasContent: {
      premise: archSectionHasContent(core?.premise),
      worldbuilding: archSectionHasContent(core?.worldbuilding),
      synopsis: archSectionHasContent(core?.synopsis),
    },
    confirmed: {
      premise: confirmedProse(core?.premise),
      worldbuilding: confirmedProse(core?.worldbuilding),
      synopsis: archSectionHasContent(core?.synopsis) && synopsisProgress === 'complete',
    },
  }
}

const ARCH_STEP_ORDER: ArchStepKey[] = ['premise', 'characters', 'worldbuilding', 'synopsis']

export const ARCH_STEP_NAMES: Record<ArchStepKey, readonly [string, string]> = {
  premise: ['故事前提', 'Premise'],
  characters: ['角色名单', 'Cast'],
  worldbuilding: ['世界观', 'World'],
  synopsis: ['情节大纲', 'Outline'],
}

export function createDefaultArchitectureSelection(
  archStatus: Record<string, boolean>,
  initialSelectedSteps?: ArchStepKey[],
): Record<ArchStepKey, boolean> {
  const selected = new Set<ArchStepKey>()

  for (const step of ARCH_STEP_ORDER) {
    if (!archStatus[step]) selected.add(step)
  }

  if (initialSelectedSteps) {
    for (const step of initialSelectedSteps) {
      selected.add(step)
    }
  }

  return {
    premise: selected.has('premise'),
    characters: selected.has('characters'),
    worldbuilding: selected.has('worldbuilding'),
    synopsis: selected.has('synopsis'),
  }
}
