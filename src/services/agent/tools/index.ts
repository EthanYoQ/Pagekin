import { toolRegistry } from '../tool-registry'
import { readFileTool } from './read-file.tool'
import { searchKnowledgeTool } from './search-knowledge.tool'
import { readArchitectureTool } from './read-architecture.tool'
import { readBlueprintTool } from './read-blueprint.tool'
import { readCharactersTool } from './read-characters.tool'
import { readProjectStateTool } from './read-project-state.tool'
import { readDraftsTool } from './read-drafts.tool'
import { listChaptersTool } from './list-chapters.tool'
import { writeFileTool } from './write-file.tool'
import { openEditorTool } from './open-editor.tool'
import { startWorkflowTool } from './start-workflow.tool'
import { proposeNovelConfigTool } from './propose-novel-config.tool'
import { proposeChapterBlueprintTool } from './propose-chapter-blueprint.tool'
import { inspectWritingSkillTool } from './inspect-writing-skill.tool'
import { installWritingSkillTool } from './install-writing-skill.tool'
import { bindWritingSkillTool } from './bind-writing-skill.tool'

export const builtinTools = [
  readFileTool,
  searchKnowledgeTool,
  readArchitectureTool,
  readBlueprintTool,
  readCharactersTool,
  readProjectStateTool,
  readDraftsTool,
  listChaptersTool,
  inspectWritingSkillTool,
  writeFileTool,
  openEditorTool,
  startWorkflowTool,
  proposeNovelConfigTool,
  proposeChapterBlueprintTool,
  installWritingSkillTool,
  bindWritingSkillTool,
]

export function registerBuiltinTools(): void {
  toolRegistry.registerAll(builtinTools)
  console.log(`[Agent] 已注册 ${builtinTools.length} 个内置 Tool`)
}
