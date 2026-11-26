import type { NovelConfig } from '../../shared/ipc-channels'
import { createConfigGenerationWorkflow } from '../../services/workflows/architecture-workflow'
import { routeModelId } from '../../services/model-routing'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore, workflowResourceConflictMessage } from '../../stores/workflow-store'
import { toast } from '../ui/Toast'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { pluralEn } from '../../shared/plural-en'
import { configText } from '../../shared/novel-config-ai-sources'

type Text = (zh: string, en: string) => string

export function configFieldsToExpand(config: Partial<NovelConfig> | undefined, text: Text): string[] {
  const labels: [unknown, string][] = [
    [config?.coreOutline, text('核心大纲', 'Core outline')],
    [config?.worldSetting, text('世界观设定', 'World setting')],
    [config?.goldenFinger, text('金手指体系', 'Special advantage')],
    [config?.protagonistProfile, text('主角人设', 'Protagonist profile')],
    [config?.globalGuidance, text('全局写作要求', 'Global writing guidance')],
    [config?.writingStyle, text('文风', 'Writing style')],
    [config?.referenceWorks, text('参考作品', 'Reference works')],
    [config?.subGenre, text('细分类型', 'Subgenre')],
  ]
  return labels.filter(([value]) => configText(value).trim()).map(([, label]) => label)
}

export function startConfigGeneration({ idea, projectSession, onGenerated }: {
  idea: string
  projectSession: ProjectSessionContext
  onGenerated: (config: Partial<NovelConfig>) => void
}): boolean {
  const text = useLocaleStore.getState().text
  const { addLog, startWorkflow } = useWorkflowStore.getState()
  if (!routeModelId('generate-global-config')) {
    addLog('error', text('请先在设置中配置 AI 模型', 'Configure an AI model in Settings first.'))
    return false
  }
  const config = useProjectStore.getState().currentProject?.novelConfig
  const totalChapters = config?.totalChapters || 100
  const wordsPerChapter = config?.wordsPerChapter || 3000
  const workflow = createConfigGenerationWorkflow({
    projectPath: projectSession.projectPath,
    projectSession,
    idea,
    totalChapters,
    wordsPerChapter,
    onGenerated,
  })
  const conflict = useWorkflowStore.getState().getResourceConflict(workflow)
  if (conflict) {
    toast.warning(workflowResourceConflictMessage(useLocaleStore.getState().locale, conflict.title))
    return false
  }
  toast.info(text('正在根据脑洞生成小说配置...', 'Generating novel configuration from your idea...'))
  addLog('info', text(`正在根据创作脑洞生成小说配置（规模：${totalChapters} 章 / ${wordsPerChapter} 字/章）...`, `Generating novel configuration (${totalChapters} ${pluralEn(totalChapters, 'chapter')} / ${wordsPerChapter} ${pluralEn(wordsPerChapter, 'word')} per chapter)...`))
  void startWorkflow(workflow)
  return true
}
