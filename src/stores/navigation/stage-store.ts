import { create } from 'zustand'
import type { HunkPick } from '../../components/editor/merge-segments'
import type { MainGenerationRunHandle } from '../../services/generation/generation-runtime'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { ChapterFacts } from './stage-progress'

export type RunSheetTab = 'active' | 'history' | 'diagnostics'

export type StageSheet = { kind: 'run'; tab: RunSheetTab; runId?: string } | { kind: 'review'; filePath: string }

export type StagePalette = 'commands' | 'chapters'

export interface StageWork {
  session: ProjectSessionContext
  architecture: Readonly<Record<string, boolean>>
  blueprints: readonly { chapterNumber: number; title: string }[]
}

interface StageState {
  sheet: StageSheet | null
  focus: boolean
  palette: StagePalette | null
  work: StageWork | null
  closingTabId: string | null
  writeRequest: { session: ProjectSessionContext; chapterNumber: number } | null
  chapterRequest: { session: ProjectSessionContext; filePath: string } | null
  selectionRequest: { session: ProjectSessionContext; filePath: string; handle: MainGenerationRunHandle; nonce: number } | null
  coveredProseFile: string | null
  chapterFacts: { session: ProjectSessionContext; byDraft: Readonly<Record<number, ChapterFacts>> } | null
  spineFacts: ProjectSessionContext | null
  mergeChoices: Readonly<Record<string, MergeChoices>>
}

export interface MergeChoices {
  picks: Readonly<Record<number, HunkPick>>
  segTexts: Readonly<Record<number, string>>
}

export const useStageStore = create<StageState>()(() => ({
  sheet: null,
  focus: false,
  palette: null,
  work: null,
  closingTabId: null,
  writeRequest: null,
  chapterRequest: null,
  selectionRequest: null,
  coveredProseFile: null,
  chapterFacts: null,
  spineFacts: null,
  mergeChoices: {},
}))
