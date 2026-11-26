import type { ChapterWritePrefill, SettingsSection } from '../layout-store'
import { stageNavigate } from './stage-navigation'

export type WorkStage = 'setup' | 'architecture' | 'blueprint' | 'manuscript'

export type ResourcePage = 'plot' | 'knowledge' | 'history'

export type RunPaneFacet = 'output' | 'tasks' | 'log' | 'models'

export type NavigationIntent =
  | { kind: 'stage'; stage?: WorkStage }
  | { kind: 'resource'; page: ResourcePage }
  | { kind: 'run'; facet: RunPaneFacet; runId?: string }
  | { kind: 'settings'; section: SettingsSection }
  | { kind: 'chapter'; chapterNumber: number; write?: ChapterWritePrefill }

export function navigate(intent: NavigationIntent): void {
  stageNavigate(intent)
}
