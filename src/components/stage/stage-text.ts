import type { EditorTab } from '../../stores/editor-store'
import type { ResourcePage, WorkStage } from '../../stores/navigation/navigation-intents'
import type { ChapterPhase } from '../../stores/navigation/stage-progress'

type Text = (zh: string, en: string) => string

export const STAGE_NAMES: Record<WorkStage, [string, string]> = {
  setup: ['设定', 'Setup'],
  architecture: ['架构', 'Architecture'],
  blueprint: ['蓝图', 'Blueprint'],
  manuscript: ['正文', 'Manuscript'],
}

export const CHAPTER_PHASE_TEXT: Record<ChapterPhase, [string, string]> = {
  todo: ['待写', 'To write'],
  draft: ['待审稿', 'To review'],
  reviewed: ['待修稿', 'To revise'],
  merge: ['待合并', 'To merge'],
  revised: ['待定稿', 'To finalize'],
  final: ['定稿', 'Final'],
}

export const CHAPTER_RUNNING_TEXT: [string, string] = ['生成中', 'Writing']

export const RESOURCE_NAMES: Record<ResourcePage, [string, string]> = {
  plot: ['剧情与伏笔', 'Plot & threads'],
  knowledge: ['知识库', 'Knowledge base'],
  history: ['版本历史', 'Version history'],
}

const PAGE_TAB_NAMES: Partial<Record<EditorTab['type'], [string, string]>> = {
  config: STAGE_NAMES.setup,
  'world-building': STAGE_NAMES.architecture,
  character: ['角色名单', 'Cast'],
  'chapter-card': STAGE_NAMES.blueprint,
  'narrative-thread': RESOURCE_NAMES.plot,
  knowledge: RESOURCE_NAMES.knowledge,
  'version-history': RESOURCE_NAMES.history,
}

export function stageTabName(tab: Pick<EditorTab, 'type' | 'name' | 'planningRecovery'>, text: Text): string {
  const name = tab.planningRecovery ? undefined : PAGE_TAB_NAMES[tab.type]
  return name ? text(...name) : tab.name
}
