import { Cpu, MoreHorizontal } from 'lucide-react'
import type { ModelProfile } from '../../../shared/ipc-channels'
import { BUILTIN_PRESETS } from '../../../shared/provider-presets'
import { useLocaleStore } from '../../../stores/locale-store'
import { Button } from '../../ui/Button'
import { Menu } from '../../ui/Menu'

function providerName(model: ModelProfile): string {
  const preset = BUILTIN_PRESETS.find(candidate => candidate.provider === model.provider)
  return preset?.displayName ?? model.provider
}

export default function ModelProfileList({ models, defaultId, label, onEdit, onSetDefault, onDelete }: {
  models: ModelProfile[]
  defaultId: string | null
  label: string
  onEdit: (model: ModelProfile) => void
  onSetDefault: (modelId: string) => void
  onDelete: (model: ModelProfile) => void
}) {
  const text = useLocaleStore(s => s.text)
  return (
    <ul className="stage-set-models" aria-label={label}>
      {models.map(model => {
        const isDefault = model.id === defaultId
        const name = model.name || model.modelName
        return (
          <li key={model.id} className="stage-set-model" data-default={isDefault || undefined}>
            <span className="stage-set-model-mark" aria-hidden="true"><Cpu size={16} /></span>
            <div className="stage-set-model-text">
              <div className="stage-set-model-name">
                <span>{name}</span>
                {isDefault && <span className="stage-badge">{text('默认', 'Default')}</span>}
              </div>
              <p className="stage-set-model-meta">{providerName(model)} · {model.modelName}</p>
            </div>
            <Button variant="text" size="sm" onClick={() => onEdit(model)} aria-label={text(`编辑「${name}」`, `Edit “${name}”`)}>{text('编辑', 'Edit')}</Button>
            <Menu
              label={text(`「${name}」更多操作`, `More for “${name}”`)}
              icon={<MoreHorizontal size={16} aria-hidden="true" />}
              align="end"
              groups={[
                ...(isDefault ? [] : [{ id: 'default', items: [{ id: 'default', label: text('设为默认', 'Make default'), onSelect: () => onSetDefault(model.id) }] }]),
                { id: 'danger', tone: 'danger' as const, items: [{ id: 'delete', label: text('删除模型…', 'Delete model…'), onSelect: () => onDelete(model) }] },
              ]}
            />
          </li>
        )
      })}
    </ul>
  )
}
