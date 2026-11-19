import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, MoreHorizontal, Pencil, X } from 'lucide-react'
import type { ChapterBlueprint } from '../../../services/workflows/directory-workflow'
import { chapterRoleOptions, chapterRoleSelectValue } from '../../../shared/chapter-role'
import { sqliteTime } from '../../../shared/sqlite-time'
import type { ChapterRow } from '../../../stores/navigation/stage-progress'
import { useLocaleStore } from '../../../stores/locale-store'
import type { EditableChapterBlueprintField } from '../../editor/chapter-card-draft-ledger'
import { Button } from '../../ui/Button'
import { Menu } from '../../ui/Menu'
import MarkdownContent from '../../ui/MarkdownContent'
import { isComposing } from '../shortcut-keys'
import { CHAPTER_PHASE_TEXT, CHAPTER_RUNNING_TEXT } from '../stage-text'

interface BlueprintCardProps {
  blueprint: ChapterBlueprint
  row: ChapterRow | undefined
  saving: boolean
  onField: <K extends EditableChapterBlueprintField>(key: K, value: ChapterBlueprint[K]) => void
  onSave: () => void
  onDelete: () => void
}

/** 单章蓝图：标题、定位、出场人物、主角小目标、冲突与转折、悬念钩子、作者微操指导、章节要点。章号是稳定标识，只读。 */
export default function BlueprintCard({ blueprint, row, saving, onField, onSave, onDelete }: BlueprintCardProps) {
  const text = useLocaleStore(s => s.text)
  // 正在输入的人名只属于当前这一章；换章时清空，不重建整张卡片（几百章换章要快）。
  const [draft, setDraft] = useState({ chapter: blueprint.chapterNumber, name: '' })
  const person = draft.chapter === blueprint.chapterNumber ? draft.name : ''
  const setPerson = (name: string) => setDraft({ chapter: blueprint.chapterNumber, name })
  const ids = { purpose: useId(), conflict: useId(), hook: useId(), guide: useId(), notes: useId(), person: useId() }
  const number = blueprint.chapterNumber
  // 卡片不随换章重建，换章时滚回顶上。
  const cardRef = useRef<HTMLElement>(null)
  useEffect(() => { cardRef.current?.scrollTo({ top: 0 }) }, [number])

  const addPeople = () => {
    const names = [...new Set(person.split(/[,，、\s]+/u).map(name => name.trim()))].filter(name => name && !blueprint.characters.includes(name))
    setPerson('')
    if (names.length > 0) onField('characters', [...blueprint.characters, ...names])
  }

  const onPersonKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing({ isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) return
    if (event.key === 'Enter' || event.key === ',' || event.key === '，' || event.key === '、') {
      event.preventDefault()
      addPeople()
    } else if (event.key === 'Backspace' && !person && blueprint.characters.length > 0) {
      onField('characters', blueprint.characters.slice(0, -1))
    }
  }

  const status = row?.running ? CHAPTER_RUNNING_TEXT : CHAPTER_PHASE_TEXT[row?.phase ?? 'todo']

  return (
    <section ref={cardRef} className="stage-bp-card" aria-label={text(`第 ${number} 章蓝图`, `Chapter ${number} blueprint`)}>
      <div className="stage-bp-card-inner">
        <div className="stage-bp-card-bar">
          <span className="stage-bp-card-status">{text('正文', 'Manuscript')} · {text(...status)}</span>
          <span className="stage-bp-card-gap" />
          <Button variant="secondary" size="sm" disabled={saving} aria-busy={saving || undefined} onClick={onSave}>
            {saving ? text('保存中…', 'Saving…') : text('保存此章', 'Save chapter')}
          </Button>
          <Menu
            label={text(`第 ${number} 章更多操作`, `More for chapter ${number}`)}
            icon={<MoreHorizontal size={16} aria-hidden />}
            align="end"
            groups={[{ id: 'danger', tone: 'danger', label: text('危险', 'Danger'), items: [
              { id: 'delete', label: text('删除此章…', 'Delete chapter…'), onSelect: onDelete },
            ] }]}
          />
        </div>

        <div className="stage-bp-title-row">
          <span className="stage-bp-title-no" title={text('章节号是现有内容的稳定标识，不能修改', 'The chapter number is a stable identifier and cannot be changed.')}>{number}</span>
          <input
            className="stage-bp-title"
            aria-label={text('章节标题', 'Chapter title')}
            value={blueprint.title}
            placeholder={text('给这一章起个名字', 'Name this chapter')}
            onChange={event => onField('title', event.target.value)}
          />
          <label className="stage-bp-role">
            <span className="stage-bp-sr">{text('章节定位', 'Chapter role')}</span>
            <select value={chapterRoleSelectValue(blueprint.role)} onChange={event => onField('role', event.target.value)}>
              {chapterRoleOptions(blueprint.role).map(({ value, labels }) => (
                <option key={value} value={value}>{labels ? text(labels.zhCN, labels.enUS) : value}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="stage-bp-field">
          <label htmlFor={ids.person}>{text('出场人物', 'Characters')}</label>
          <div className="stage-bp-people">
            {/* 旧数据里可能有重名：按位置区分，移除只去掉点的那一个。 */}
            {blueprint.characters.map((name, index) => (
              <span key={`${index}:${name}`} className="stage-bp-person">
                {name}
                <Button
                  variant="icon"
                  size="sm"
                  aria-label={text(`移除 ${name}`, `Remove ${name}`)}
                  onClick={() => onField('characters', blueprint.characters.filter((_, at) => at !== index))}
                >
                  <X size={12} aria-hidden />
                </Button>
              </span>
            ))}
            <input
              id={ids.person}
              className="stage-bp-person-input"
              value={person}
              placeholder={text('添加人物，回车确认', 'Add a name, press Enter')}
              onChange={event => setPerson(event.target.value)}
              onKeyDown={onPersonKey}
              onBlur={addPeople}
            />
          </div>
        </div>

        <div className="stage-bp-field">
          <label htmlFor={ids.purpose}>{text('主角小目标', 'Protagonist goal')} <em>{text('本章最想解决的事', 'The main thing to resolve in this chapter')}</em></label>
          <textarea id={ids.purpose} className="stage-bp-ctl" rows={1} value={blueprint.purpose}
            placeholder={text('这一章主角最想办成什么', 'What the protagonist most wants here')} onChange={event => onField('purpose', event.target.value)} />
        </div>

        <div className="stage-bp-field">
          <label htmlFor={ids.conflict}>{text('冲突与转折', 'Conflict and turn')}</label>
          <textarea id={ids.conflict} className="stage-bp-ctl" rows={1} value={blueprint.keyEvents}
            placeholder={text('谁挡了路，局面在哪里转了', 'Who stands in the way, and where it turns')} onChange={event => onField('keyEvents', event.target.value)} />
        </div>

        <div className="stage-bp-field">
          <label htmlFor={ids.hook}>{text('悬念钩子', 'Suspense hook')}</label>
          <textarea id={ids.hook} className="stage-bp-ctl" rows={1} value={blueprint.suspenseHook}
            placeholder={text('结尾留下什么，让人想看下一章', 'What makes the reader turn to the next chapter')} onChange={event => onField('suspenseHook', event.target.value)} />
        </div>

        <div className="stage-bp-field">
          <label htmlFor={ids.guide}>{text('作者微操指导', 'Author guidance')} <em>{text('写作此章时一并交给 AI，优先于蓝图', 'Sent with this chapter when writing; it takes priority over the blueprint')}</em></label>
          <textarea
            id={ids.guide}
            className="stage-bp-ctl"
            rows={1}
            value={blueprint.userGuidance}
            placeholder={text('不填则完全按蓝图写。', 'Leave blank to follow the blueprint exactly.')}
            onChange={event => onField('userGuidance', event.target.value)}
          />
        </div>

        <Notes key={blueprint.chapterNumber} blueprint={blueprint} id={ids.notes} onChange={value => onField('notes', value)} />
      </div>
    </section>
  )
}

/** 编辑态按章号重新挂载：换走再换回仍是排版。 */
function Notes({ blueprint, id, onChange }: { blueprint: ChapterBlueprint; id: string; onChange: (value: string) => void }) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const [editingNotes, setEditingNotes] = useState(false)
  const hasNotes = blueprint.notes.trim() !== ''
  const editing = editingNotes || !hasNotes
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (editingNotes) input.current?.focus() }, [editingNotes])
  const toggle = () => setEditingNotes(!editingNotes)

  return (
    <div className="stage-bp-field stage-bp-notes">
      <div className="stage-bp-notes-head">
        <label htmlFor={editing ? id : undefined}>
          {text('章节要点', 'Chapter notes')}{' '}
          <em>{blueprint.notesUpdatedAt
            ? text(`定稿后自动生成 · ${sqliteTime(blueprint.notesUpdatedAt).toLocaleDateString(locale)}`, `Generated after finalization · ${sqliteTime(blueprint.notesUpdatedAt).toLocaleDateString(locale)}`)
            : text('定稿后自动生成，也可以先手写给 AI 参考', 'Generated after finalization; you can also write them first for reference')}</em>
        </label>
        {hasNotes && (
          <Button variant="text" size="sm" aria-label={editingNotes ? text('完成编辑章节要点', 'Finish editing chapter notes') : text('编辑章节要点', 'Edit chapter notes')} onClick={toggle}>
            {editingNotes ? <Check size={13} aria-hidden /> : <Pencil size={13} aria-hidden />}
            {editingNotes ? text('完成', 'Done') : text('编辑', 'Edit')}
          </Button>
        )}
      </div>
      {editing
        ? <textarea ref={input} id={id} className="stage-bp-ctl" rows={1} value={blueprint.notes}
            placeholder={text('还没有要点，支持 Markdown', 'No notes yet. Markdown works here')} onChange={event => {
              // 从空白开始写也留在输入框里，不在打出第一个字时换成排版。
              if (!editingNotes) setEditingNotes(true)
              onChange(event.target.value)
            }} />
        : <div className="stage-bp-notes-read"><MarkdownContent content={blueprint.notes} /></div>}
    </div>
  )
}
