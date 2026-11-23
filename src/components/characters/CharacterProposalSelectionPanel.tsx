import { directoryProposalChapter, type CharacterProposalBatch } from '../../shared/character-proposal'
import { CHARACTER_ROLES, CHARACTER_ROLE_LABELS, normalizeCharacterRole, type CharacterRole } from '../../shared/character-role'
import { adoptedRelationships, type CharacterProposalChoices } from '../../services/character-proposal-choices'
import { proposalRelations, sameRelationship } from '../../services/workflows/character-proposal-preview'
import { useLocaleStore } from '../../stores/locale-store'
import { NativeSelect } from '../ui/NativeSelect'

const editableFields = [
  ['name', '姓名', 'Name', '名前'], ['gender', '性别', 'Gender', '性別'], ['age', '年龄', 'Age', '年齢'],
  ['appearance', '外貌', 'Appearance', '外見'], ['personality', '性格', 'Personality', '性格'],
  ['background', '背景', 'Background', '背景'], ['abilities', '能力', 'Abilities', '能力'],
  ['motivation', '动机', 'Motivation', '動機'], ['arc', '弧光', 'Arc', 'キャラクターアーク'], ['notes', '备注', 'Notes', 'メモ'],
] as const

const japaneseRoleLabels: Record<CharacterRole, string> = {
  protagonist: '主人公',
  antagonist: '敵対者',
  supporting: '脇役',
  minor: '端役',
}

/** Controlled author choices; the host owns confirmation, main owns the atomic effect. */
export function CharacterProposalSelectionPanel({ batch, choices, onChange, disabled = false }: {
  batch: CharacterProposalBatch
  choices: CharacterProposalChoices
  onChange(choices: CharacterProposalChoices): void
  disabled?: boolean
}) {
  const text = useLocaleStore(state => state.text)
  const roleLabel = (role: string | undefined) => {
    if (!role) return undefined
    const normalizedRole = normalizeCharacterRole(role)
    const label = CHARACTER_ROLE_LABELS[normalizedRole]
    return text(label.zhCN, label.enUS, japaneseRoleLabels[normalizedRole])
  }
  if (choices.proposalBatchId !== batch.proposalBatchId || choices.revision !== batch.revision) return <p role="alert">{text('提议已改变，请重新载入选择。', 'The proposals changed. Reload the choices.', '提案内容が変わりました。選択肢を再度読み込んでください。')}</p>
  const { identities } = choices
  const relations = proposalRelations(batch, identities, choices.selections)
  return <section className="space-y-3" aria-label={text('批量选择角色采用方式', 'Choose character adoption in one batch', 'キャラクター候補の採用方法を一括で選択')}>
    <p className="text-xs text-[var(--color-text-secondary)]">{text('同名或共享别名不会自动合并。可选择对应角色、新建或暂不采用；最后一次确认统一保存。', 'Matching names or shared aliases are not merged automatically. Choose a character, create one, or keep unresolved, then confirm the batch once.', '名前や別名が一致しても、自動では統合されません。既存の人物に紐づける、新規作成する、または採用を保留できます。最後にまとめて確定すると保存されます。')}</p>
    {batch.items.map(item => {
      const choice = choices.selections.find(value => value.selectionKey === item.selectionKey)
      const editable = batch.source.kind === 'generation' && batch.source.inputKind === 'planning-material'
      const edit = choices.edits?.find(value => value.selectionKey === item.selectionKey)
      const updateField = (field: string, value: string) => {
        const changed = { ...edit?.fields } as Record<string, string>
        if (value === (item.fields[field as keyof typeof item.fields] ?? '')) delete changed[field]
        else changed[field] = value
        const edits = (choices.edits ?? []).filter(value => value.selectionKey !== item.selectionKey)
        if (Object.keys(changed).length) edits.push({ selectionKey: item.selectionKey, fields: changed })
        onChange({ ...choices, edits })
      }
      return <div className="block space-y-1" key={item.selectionKey}>
        <span>{item.fields.name} · {roleLabel(item.fields.role) ?? text('角色候选', 'Character candidate', 'キャラクター候補')}</span>
        <span className="block text-xs text-[var(--color-text-secondary)]">{item.fields.background || (batch.source.kind === 'directory'
          ? text(`第 ${directoryProposalChapter(item.selectionKey)} 章蓝图首次出场`, `First appears in the chapter ${directoryProposalChapter(item.selectionKey)} blueprint`, `第${directoryProposalChapter(item.selectionKey)}章のブループリントで初登場`) : item.sourceId)}</span>
        <NativeSelect aria-label={text(`采用方式：${item.fields.name} · ${item.selectionKey}`, `Adoption: ${item.fields.name} · ${item.selectionKey}`, `採用方法：${item.fields.name} · ${item.selectionKey}`)} disabled={disabled || batch.status !== 'pending-approval'}
          value={choice?.action === 'map' ? `map:${choice.characterId}` : choice?.action ?? 'keep-unresolved'}
          onChange={event => {
            const value = event.target.value
            const selection = value.startsWith('map:')
              ? { selectionKey: item.selectionKey, action: 'map' as const, characterId: value.slice(4) }
              : { selectionKey: item.selectionKey, action: value === 'create' ? 'create' as const : 'keep-unresolved' as const }
            const selections = choices.selections.filter(current => current.selectionKey !== item.selectionKey).concat(selection)
            onChange({ ...choices, selections,
              edits: selection.action === 'keep-unresolved' ? choices.edits?.filter(edit => edit.selectionKey !== item.selectionKey) : choices.edits,
              relationships: adoptedRelationships(batch, { ...choices, selections }) })
          }}>
          <option value="keep-unresolved">{text('暂不采用，保留候选', 'Keep unresolved', '採用を保留')}</option>
          <option value="create">{text('新建独立角色', 'Create a separate character', '新しい人物として追加')}</option>
          {identities.map(identity => <option key={identity.characterId} value={`map:${identity.characterId}`}>{identity.name} · {roleLabel(identity.role) ?? ''} · {identity.characterId.slice(-8)}</option>)}
        </NativeSelect>
        {editable && choice?.action !== 'keep-unresolved' && <details className="text-xs" onClick={event => event.stopPropagation()}>
          <summary className="cursor-pointer">{text('编辑导入候选', 'Edit imported candidate', '取り込んだ候補を編集')}</summary>
          <div className="grid grid-cols-1 gap-2 pt-2">
            {editableFields.map(([field, zh, en, ja]) => <label key={field} className="grid gap-1">
              <span>{text(zh, en, ja)}</span>
              <input aria-label={text(`编辑候选${zh}：${item.selectionKey}`, `Edit candidate ${en}: ${item.selectionKey}`, `候補の${ja}を編集：${item.selectionKey}`)}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1"
                disabled={disabled || batch.status !== 'pending-approval'}
                value={edit?.fields[field] ?? item.fields[field] ?? ''}
                onChange={event => updateField(field, event.target.value)} />
            </label>)}
            <label className="grid gap-1"><span>{text('角色定位', 'Role', '役割')}</span>
              <NativeSelect aria-label={text(`编辑候选角色定位：${item.selectionKey}`, `Edit candidate role: ${item.selectionKey}`, `候補の役割を編集：${item.selectionKey}`)}
                disabled={disabled || batch.status !== 'pending-approval'} value={edit?.fields.role ?? item.fields.role ?? ''}
                onChange={event => updateField('role', event.target.value)}>
                {!item.fields.role && !edit?.fields.role && <option value="" disabled>{text('未指定', 'Unspecified', '未指定')}</option>}
                {CHARACTER_ROLES.map(role => <option key={role} value={role}>{roleLabel(role)}</option>)}
              </NativeSelect>
            </label>
          </div>
        </details>}
      </div>
    })}
    {relations.map(({ edge, ...relation }, index) => <label className="flex gap-2 text-xs" key={`${relation.sourceSelectionKey}:${edge?.targetSelectionKey ?? edge?.targetCharacterId}:${index}`}>
      <input type="checkbox" disabled={disabled || batch.status !== 'pending-approval' || !relation.adoptable}
        checked={!!edge && choices.relationships.some(value => sameRelationship(value, edge))}
        onChange={event => { if (edge) onChange({ ...choices, relationships: event.target.checked ? adoptedRelationships(batch, { ...choices, relationships: [...choices.relationships, edge] }) : choices.relationships.filter(value => !sameRelationship(value, edge)) }) }} />
      {batch.items.find(item => item.selectionKey === relation.sourceSelectionKey)?.fields.name} → {batch.items.find(item => item.selectionKey === edge?.targetSelectionKey)?.fields.name ?? relation.targetName}：{relation.relation}
      {!edge && text('（目标身份待确认，暂不采用关系）', ' (Target identity unresolved; relationship not adopted)', '（相手が未確定のため、関係は保留）')}
    </label>)}
  </section>
}
