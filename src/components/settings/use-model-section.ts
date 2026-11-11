import { useEffect, useState } from 'react'
import { useLLMStore } from '../../stores/llm-store'
import { useLocaleStore } from '../../stores/locale-store'
import { displayedErrorMessage } from '../../i18n/app-errors'
import { useWorkflowStore } from '../../stores/workflow-store'
import type { ModelProfile } from '../../shared/ipc-channels'
import { createModelProfileDraft } from '../../shared/model-profile-draft'
import { randomUUID } from '../../utils/id'
import { alertError } from '../ui/AlertDialog'
import { confirm } from '../ui/Confirm'

/**
 * 每次请求前主进程都拿当前模型设置比对运行开跑时冻结的那份，不一致就停下（GENERATION_SOURCE_CHANGED），
 * 所以有生成正在用这个模型时先问作者：等它结束再保存，或者仍然保存。没选模型的运行用的是默认模型。
 */
async function confirmSaveWhileGenerating(modelId: string, defaultModelId: string | null): Promise<boolean> {
  const using = useWorkflowStore.getState().activeRuns
    .filter(run => run.status !== 'cancelling' && (run.generationModelId ?? defaultModelId) === modelId)
  if (using.length === 0) return true
  const text = useLocaleStore.getState().text
  const names = using.map(run => `「${run.title}」`).join('、')
  const namesEn = using.map(run => `“${run.title}”`).join(', ')
  return confirm(text(
    `当前有生成在用这个模型（${names}），保存后这次生成会在下一章停下，已生成的内容会保留。等它结束再保存就不受影响。`,
    `A generation is using this model (${namesEn}). If you save now, it stops before its next chapter; what it has generated is kept. Saving after it finishes avoids this.`,
  ), {
    title: text('这个模型正在生成', 'This model is generating'),
    confirmText: text('仍然保存', 'Save anyway'),
    cancelText: text('等生成结束再保存', 'Save after it finishes'),
  })
}

/**
 * 一类模型（生成、向量或重排）的列表与编辑：按用途过滤、新增草稿、保存（该类第一个自动设为默认）、删除、设为默认。
 * 设置页的「AI 模型」「检索模型」及其「重排模型」分区用它。
 */
export function useModelSection(purposes: ModelProfile['purposes']) {
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const defaultEmbeddingModelId = useLLMStore(s => s.defaultEmbeddingModelId)
  const defaultRerankModelId = useLLMStore(s => s.defaultRerankModelId)
  const loadModels = useLLMStore(s => s.loadModels)
  const saveModel = useLLMStore(s => s.saveModel)
  const deleteModel = useLLMStore(s => s.deleteModel)
  const setDefaultModel = useLLMStore(s => s.setDefaultModel)
  const setDefaultEmbeddingModel = useLLMStore(s => s.setDefaultEmbeddingModel)
  const setDefaultRerankModel = useLLMStore(s => s.setDefaultRerankModel)
  const [editingModel, setEditingModel] = useState<ModelProfile | null>(null)
  const [editingOriginal, setEditingOriginal] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    const refresh = () => void loadModels()
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [loadModels])

  const filtered = models.filter((m) =>
    m.purposes?.some((p) => purposes.includes(p as ModelProfile['purposes'][number]))
  )
  const isEmbeddingSection = purposes.includes('embedding')
  const [defaultId, setDefault] = purposes.includes('rerank') ? [defaultRerankModelId, setDefaultRerankModel] as const
    : isEmbeddingSection ? [defaultEmbeddingModelId, setDefaultEmbeddingModel] as const
      : [defaultModelId, setDefaultModel] as const

  /** 向量和重排模型由工厂选择完整的 SiliconFlow 默认值。 */
  const startEditing = (model: ModelProfile) => {
    setEditingModel(model)
    setEditingOriginal(JSON.stringify(model))
  }
  const add = () => {
    startEditing(createModelProfileDraft({
      id: randomUUID(),
      purposes: [...purposes],
    }))
  }

  const save = async () => {
    if (!editingModel) return
    if (!await confirmSaveWhileGenerating(editingModel.id, defaultModelId)) return
    setSaving(true)
    try {
      if (!await saveModel(editingModel)) return
      if (filtered.length === 0 && !await setDefault(editingModel.id)) return
      setEditingModel(null)
    } catch (error) {
      const { locale, text } = useLocaleStore.getState()
      void alertError(displayedErrorMessage(locale, error), { title: text('模型设置保存失败', 'Model settings could not be saved') })
    } finally {
      setSaving(false)
    }
  }

  return {
    models: filtered,
    defaultId,
    isEmbeddingSection,
    editingModel,
    /** 编辑表单里的内容与打开时不同。 */
    editingDirty: editingModel !== null && JSON.stringify(editingModel) !== editingOriginal,
    setEditingModel,
    saving,
    add,
    edit: (model: ModelProfile) => startEditing({ ...model }),
    cancelEdit: () => setEditingModel(null),
    save,
    remove: (modelId: string) => deleteModel(modelId),
    setDefault,
  }
}
