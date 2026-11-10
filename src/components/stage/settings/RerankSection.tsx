import { useState } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import type { ModelProfile } from '../../../shared/ipc-channels'
import { RERANK_CANDIDATE_COUNT } from '../../../shared/knowledge-ranking'
import { pluralEn } from '../../../shared/plural-en'
import { BUILTIN_PRESETS } from '../../../shared/provider-presets'
import { resolveRerankConfig } from '../../../shared/rerank-config'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { ModelForm } from '../../settings/ModelForm'
import { useUnsavedSettings } from '../../settings/unsaved-settings'
import { useModelSection } from '../../settings/use-model-section'
import { Button } from '../../ui/Button'
import { DangerConfirm } from '../../ui/DangerConfirm'
import ModelProfileList from './ModelProfileList'
import { rerankStatus } from './rerank-status'

const RERANK_PURPOSES: ModelProfile['purposes'] = ['rerank']

/** 检索模型页的可选分区：默认收成一行，不配也不影响写作和查找。 */
export default function RerankSection() {
  const text = useLocaleStore(s => s.text)
  const section = useModelSection(RERANK_PURPOSES)
  useUnsavedSettings(section.editingDirty)
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState<ModelProfile | null>(null)
  const models = useLLMStore(s => s.models)
  const defaultEmbeddingModelId = useLLMStore(s => s.defaultEmbeddingModelId)
  const status = rerankStatus(resolveRerankConfig({
    defaultRerankModelId: section.defaultId,
    models,
    embedding: models.find(model => model.id === defaultEmbeddingModelId) ?? null,
  }), models)
  const editing = section.editingModel !== null
  const expanded = open || editing
  const deletingName = deleting ? deleting.name || deleting.modelName : ''

  return (
    <section className="stage-set-rerank" data-rerank-section aria-label={text('重排模型', 'Reranking model')}>
      <button type="button" className="stage-set-rerank-head" aria-expanded={expanded} disabled={editing} onClick={() => setOpen(value => !value)}>
        <span className="stage-set-rerank-title">{text('重排模型（可选）', 'Reranking model (optional)')}</span>
        <span className="stage-set-rerank-status">{text(...status)}</span>
        <ChevronDown size={14} aria-hidden="true" className="stage-set-rerank-chevron" />
      </button>
      {expanded && (
        <div className="stage-set-rerank-body">
          {section.editingModel
            ? (
              <div className="stage-set-legacy">
                <ModelForm
                  key={section.editingModel.id}
                  model={section.editingModel}
                  onChange={section.setEditingModel}
                  onSave={() => void section.save()}
                  onCancel={section.cancelEdit}
                  saving={section.saving}
                  purposeOptions={RERANK_PURPOSES}
                  presets={BUILTIN_PRESETS}
                />
              </div>
            )
            : (
              <>
                <p className="stage-set-rerank-note">{text(
                  `取材和查找时，最多 ${RERANK_CANDIDATE_COUNT} 段稿件会发到你配的重排服务。`,
                  `When gathering material or searching, up to ${RERANK_CANDIDATE_COUNT} ${pluralEn(RERANK_CANDIDATE_COUNT, 'passage')} of your manuscript are sent to the service you set here.`,
                )}</p>
                {section.models.length > 0 && (
                  <ModelProfileList
                    models={section.models}
                    defaultId={section.defaultId}
                    label={text('重排模型', 'Reranking models')}
                    onEdit={section.edit}
                    onSetDefault={modelId => void section.setDefault(modelId)}
                    onDelete={setDeleting}
                  />
                )}
                <div><Button variant="secondary" size="sm" onClick={section.add}><Plus size={14} aria-hidden="true" />{text('添加重排模型', 'Add reranking model')}</Button></div>
              </>
            )}
        </div>
      )}
      <DangerConfirm
        open={deleting !== null}
        onOpenChange={next => { if (!next) setDeleting(null) }}
        title={text(`删除「${deletingName}」？`, `Delete “${deletingName}”?`)}
        consequence={deleting?.id === section.defaultId
          ? text('删除后不再重排，查找和写作照常。', 'Reranking stops; search and writing carry on as usual.')
          : text('这个模型的名称、接口地址和密钥会从本机删除。', 'Its name, endpoint and key are removed from this computer.')}
        recoverability={text('删除后无法恢复，需要时重新添加。', 'This cannot be undone. Add it again if you need it.')}
        cancelLabel={text('取消', 'Cancel')}
        confirmLabel={text('删除模型', 'Delete model')}
        onConfirm={() => { if (deleting) void section.remove(deleting.id) }}
      />
    </section>
  )
}
