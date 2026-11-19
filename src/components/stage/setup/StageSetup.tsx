import { useId, useState } from 'react'
import { ArrowRight, LoaderCircle, Sparkles } from 'lucide-react'
import type { NovelConfig } from '../../../shared/ipc-channels'
import { countDraftUnits } from '../../../shared/draft-units'
import {
  DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  MAX_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  MIN_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  resolveNarrativeThreadDormantThreshold,
} from '../../../shared/narrative-thread'
import { resolveWritingLanguage, type WritingLanguage } from '../../../shared/writing-language'
import { aiSourceOf } from '../../../shared/novel-config-ai-sources'
import { sameProjectPathKey } from '../../../shared/project-session-context'
import type { GeneratableField } from '../../../services/workflows/commands/generate-field.command'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { currentInterfaceLocale, useLocaleStore } from '../../../stores/locale-store'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { missingSetup, type SetupField } from '../../../stores/navigation/stage-progress'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { configFieldsToExpand, startConfigGeneration } from '../../dialogs/config-generation'
import { AUDIENCE_EN, GENRE_EN } from '../../editor/novel-config-labels'
import { NOVEL_GENRES, novelConfigSessionKey, useNovelConfigForm } from '../../editor/use-novel-config-form'
import { captureProjectSession } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { InkDialog } from '../InkDialog'
import ModelMissingNotice from '../ModelMissingNotice'
import { commandLabel } from '../shortcut-keys'
import { useModelMissing } from '../use-model-missing'
import { ONE_MISSING_HINT, POV_OPTIONS, REQUIRED_NAMES, SHEET_FIELDS, STRUCTURE_OPTIONS, type SheetField } from './setup-fields'
import { pluralEn } from '../../../shared/plural-en'

type Form = ReturnType<typeof useNovelConfigForm>
type SheetMark = 'empty' | 'ai-filled' | 'ai-expanded' | null

/** 读出的设定值类型不对时按空文本显示，这一行照常可改，不让整页崩。 */
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

function sheetMark(config: NovelConfig, field: SheetField['id']): SheetMark {
  if (!textOf(config[field]).trim()) return 'empty'
  const source = aiSourceOf(config, field)
  return source ? `ai-${source}` : null
}

/** 作者此刻在哪：活动标签、书房还是作品、设置页开没开。 */
function authorPlace(): string {
  const { sidebarView, settingsOpen } = useLayoutStore.getState()
  return JSON.stringify([useEditorStore.getState().activeTabId, sidebarView, settingsOpen])
}

export default function StageSetup({ projectKey }: { projectKey: string }) {
  const currentProject = useProjectStore(s => s.currentProject)
  return <SetupSession key={novelConfigSessionKey(currentProject, projectKey)} projectKey={projectKey} />
}

/** 数字框允许暂时为空，失焦时回退到默认值。 */
function NumberInput({ id, value, fallback, min, max, label, onChange }: {
  id?: string
  value: number | ''
  fallback: number
  min: number
  max?: number
  label: string
  onChange: (value: number | '') => void
}) {
  return (
    <input
      id={id}
      className="stage-setup-num-input"
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      aria-label={label}
      value={value}
      onChange={event => onChange(event.target.value === '' ? '' : Number.parseInt(event.target.value, 10))}
      onBlur={() => { if (!(Number(value) >= min)) onChange(fallback) }}
    />
  )
}

/** 不可用按钮的原因藏在旁边，读屏用户聚焦按钮时能听到；看得见的原因在页面别处（缺模型提示条、必填标记）。 */
function DisabledReason({ id, reason }: { id: string; reason: string | null }) {
  return reason ? <span id={id} className="stage-visually-hidden">{reason}</span> : null
}

function AiButton({ field, label, form, disabledReason }: { field: GeneratableField; label: string; form: Form; disabledReason: string | null }) {
  const text = useLocaleStore(s => s.text)
  const reasonId = useId()
  const busy = form.generatingField === field
  const reason = disabledReason ?? (form.generatingField !== null && !busy ? text('正在生成另一项，完成后再试', 'Another field is generating. Try again when it finishes') : null)
  return (
    <>
      <Button
        variant="text"
        size="sm"
        className="stage-setup-ai"
        disabled={reason !== null || busy}
        aria-describedby={reason ? reasonId : undefined}
        aria-label={text(`AI 生成「${label}」`, `Generate “${label}” with AI`)}
        onClick={() => void form.generateField(field)}
      >
        {busy ? <LoaderCircle size={13} className="stage-update-spin" aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}
        {busy ? text('生成中…', 'Generating…') : text('AI 生成', 'Generate')}
      </Button>
      <DisabledReason id={reasonId} reason={reason} />
    </>
  )
}

/** 单项 AI 生成失败时写在那一项下面，直到下次生成。 */
function GenerateError({ field, label, form }: { field: GeneratableField; label: string; form: Form }) {
  const text = useLocaleStore(s => s.text)
  if (form.generateError?.field !== field) return null
  const reason = displayedErrorMessage(currentInterfaceLocale(), form.generateError.message)
  return (
    <p className="stage-setup-error" role="alert">
      {text(`「${label}」没有生成：${reason}。原来的内容没有改动。`, `“${label}” was not generated: ${reason}. Nothing was changed.`)}
    </p>
  )
}

/** 还空着的必填项写「必填」；alert 时（作者离开了空着的这一项，或只差这一项）转成危险色。 */
function RequiredLabel({ htmlFor, id, name, missing, alert }: { htmlFor?: string; id?: string; name: string; missing: boolean; alert: boolean }) {
  const text = useLocaleStore(s => s.text)
  return (
    <label className="stage-setup-label" htmlFor={htmlFor} id={id} data-missing={(missing && alert) || undefined}>
      {name}
      {missing && <span className="stage-setup-required-mark">{text(' · 必填', ' · required')}</span>}
    </label>
  )
}

function SheetMarkLabel({ mark }: { mark: SheetMark }) {
  const text = useLocaleStore(s => s.text)
  if (!mark) return null
  if (mark === 'empty') return <span className="stage-setup-mark" data-mark={mark}>{text('未填', 'Empty')}</span>
  return (
    <span className="stage-setup-mark" data-mark={mark} data-ai>
      <Sparkles size={12} aria-hidden="true" />
      {mark === 'ai-filled' ? text('AI 填写', 'AI-written') : text('AI 扩写', 'AI-expanded')}
    </span>
  )
}

function SheetRow({ field, config, form, aiReason }: { field: SheetField; config: NovelConfig; form: Form; aiReason: string | null }) {
  const text = useLocaleStore(s => s.text)
  const controlId = useId()
  const descId = useId()
  const name = text(...field.name)
  const mark = sheetMark(config, field.id)
  return (
    <div className="stage-setup-row" data-empty={mark === 'empty' || undefined}>
      <div className="stage-setup-row-side">
        <label className="stage-setup-row-name" htmlFor={controlId}>{name}</label>
        <SheetMarkLabel mark={mark} />
      </div>
      <div className="stage-setup-row-main">
        <textarea id={controlId} className="stage-setup-row-input" rows={1} value={textOf(config[field.id])}
          placeholder={text(...field.placeholder)} aria-describedby={descId} onChange={event => form.update(field.id, event.target.value)} />
        <p id={descId} className="stage-setup-row-desc">{text(...field.desc)}</p>
        {field.aiField && <GenerateError field={field.aiField} label={name} form={form} />}
      </div>
      <div className="stage-setup-row-act">
        {field.aiField && <AiButton field={field.aiField} label={name} form={form} disabledReason={aiReason} />}
      </div>
    </div>
  )
}

/** 下拉的值不在选项里（旧数据或坏数据）时，把原值作为一项留着，不悄悄显示成第一项。 */
function OptionSelect<V extends string>({ id, value, options, onChange }: {
  id: string
  value: unknown
  options: readonly (readonly [V, readonly [string, string]])[]
  onChange: (value: V) => void
}) {
  const text = useLocaleStore(s => s.text)
  const current = textOf(value) || options[0][0]
  return (
    <select id={id} className="stage-select" value={current} onChange={event => onChange(event.target.value as V)}>
      {!options.some(([option]) => option === current) && <option value={current}>{current}</option>}
      {options.map(([option, label]) => <option key={option} value={option}>{text(...label)}</option>)}
    </select>
  )
}

function SetupSession({ projectKey }: { projectKey: string }) {
  const text = useLocaleStore(s => s.text)
  const form = useNovelConfigForm(projectKey)
  const modelMissing = useModelMissing('planning')
  const filling = useWorkflowStore(s => s.activeRuns.some(run => run.type === 'config_generation' && sameProjectPathKey(run.projectPath, projectKey)))
  const [expandFields, setExpandFields] = useState<string[] | null>(null)
  const [left, setLeft] = useState<ReadonlySet<SetupField>>(() => new Set())
  const baseId = useId()
  const hintId = useId()
  const lengthId = useId()
  const fillReasonId = useId()

  const { config } = form
  if (!config) {
    return (
      <div className="stage-setup stage-setup--empty">
        <p className="stage-setup-lede">{form.projectMatches
          ? text('正在读取设定…', 'Loading setup…')
          : text('这个标签属于另一部作品，切回那部作品后再继续。', 'This tab belongs to another book. Switch back to it to continue.')}</p>
      </div>
    )
  }

  const missing = missingSetup(config)
  const isMissing = (field: SetupField) => missing.includes(field)
  const alert = (field: SetupField) => missing.length === 1 || left.has(field)
  const leave = (field: SetupField) => {
    if (isMissing(field) && !left.has(field)) setLeft(previous => new Set(previous).add(field))
  }
  const hint = missing.length === 0
    ? text('设定已齐，可以往下走', 'Setup is complete. Ready for the next step.')
    : missing.length === 1
      ? text(...ONE_MISSING_HINT[missing[0]])
      : text(`还差 ${missing.length} 项：${missing.map(field => REQUIRED_NAMES[field][0]).join('、')}`,
        `${missing.length} left: ${missing.map(field => REQUIRED_NAMES[field][1]).join(', ')}`)
  const outline = textOf(config.coreOutline)
  const aiReason = modelMissing ? text('先在设置里添加 AI 模型', 'Add an AI model in Settings first') : null
  const fillReason = aiReason ?? (outline.trim() ? null : text('先写核心大纲，AI 按它补全其余设定', 'Write the core outline first; AI fills in the rest from it'))
  const marks = SHEET_FIELDS.map(field => sheetMark(config, field.id))
  const markCount = (mark: SheetMark) => marks.filter(item => item === mark).length
  const sheetCount = [
    text(`${SHEET_FIELDS.length} 项`, `${SHEET_FIELDS.length} ${pluralEn(SHEET_FIELDS.length, 'item')}`),
    markCount('empty') && text(`${markCount('empty')} 项未填`, `${markCount('empty')} empty`),
    markCount('ai-filled') && text(`${markCount('ai-filled')} 项 AI 填写`, `${markCount('ai-filled')} AI-written`),
    markCount('ai-expanded') && text(`${markCount('ai-expanded')} 项 AI 扩写`, `${markCount('ai-expanded')} AI-expanded`),
  ].filter(Boolean).join(' · ')
  const threshold = resolveNarrativeThreadDormantThreshold(config.narrativeThreadDormantChapterThreshold)

  const startFill = () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    if (startConfigGeneration({ idea: outline, projectSession: session, onGenerated: form.applyGeneratedTo(session) })) setExpandFields(null)
  }
  const requestFill = () => {
    const fields = configFieldsToExpand(config, text)
    if (fields.length > 0) setExpandFields(fields)
    else startFill()
  }
  const goNext = async () => {
    if (form.dirty) {
      const before = authorPlace()
      try {
        if (!await form.save(true)) return
      } catch {
        return
      }
      // 保存期间作者可能回了书房、开了设置页或换到别的标签；这时不再把作者拉去架构。
      if (authorPlace() !== before) return
    }
    navigate({ kind: 'stage', stage: 'architecture' })
  }

  const genre = textOf(config.genre)
  const audience = textOf(config.targetAudience)
  return (
    <div className="stage-setup">
      <div className="stage-setup-scroll">
        <div className="stage-setup-inner">
          <header className="stage-setup-head">
            <div className="stage-setup-kicker">
              <span className="stage-setup-numeral" aria-hidden="true">i</span>
              <span className="stage-eyebrow">{text('第一步 · 设定', 'Step one · Setup')}</span>
            </div>
            <h1 className="stage-setup-title">{text('先定下这本书的设定。', 'Set up this book.')}</h1>
            <p className="stage-setup-lede">{text(
              '类型、篇幅、目标读者和核心大纲必填。其余可以空着，写好核心大纲后交给 AI 补全，之后随时能改。',
              'Genre, length, target readers and the core outline are required. Leave the rest blank and let AI fill it in from the outline; you can change anything later.',
            )}</p>
          </header>

          {modelMissing && <ModelMissingNotice />}

          <section className="stage-setup-basics" aria-label={text('基本设定', 'Basics')}>
            <div className="stage-setup-field">
              <RequiredLabel htmlFor={`${baseId}-genre`} name={text('类型', 'Genre')} missing={isMissing('genre')} alert={alert('genre')} />
              <select id={`${baseId}-genre`} className="stage-select" data-placeholder={!genre || undefined} value={genre}
                onChange={event => form.update('genre', event.target.value)} onBlur={() => leave('genre')}>
                <option value="" disabled>{text('请选择', 'Choose')}</option>
                {genre && !NOVEL_GENRES.includes(genre) && <option value={genre}>{genre}</option>}
                {NOVEL_GENRES.map(value => <option key={value} value={value}>{text(value, GENRE_EN[value] ?? value)}</option>)}
              </select>
            </div>
            <div className="stage-setup-field" role="group" aria-labelledby={lengthId}
              onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) leave('length') }}>
              <RequiredLabel id={lengthId} name={text('篇幅', 'Length')} missing={isMissing('length')} alert={alert('length')} />
              <div className="stage-setup-length">
                <NumberInput value={config.totalChapters as number | ''} fallback={100} min={1} label={text('总章数', 'Total chapters')}
                  onChange={value => form.update('totalChapters', value as number)} />
                <span>{text('章 · 每章约', 'ch. ·')}</span>
                <NumberInput value={config.wordsPerChapter as number | ''} fallback={3000} min={100} label={text('每章字数', 'Words per chapter')}
                  onChange={value => form.update('wordsPerChapter', value as number)} />
                <span>{text('字', 'words')}</span>
              </div>
            </div>
            <div className="stage-setup-field">
              <RequiredLabel htmlFor={`${baseId}-audience`} name={text('目标读者', 'Target readers')} missing={isMissing('targetAudience')} alert={alert('targetAudience')} />
              <select id={`${baseId}-audience`} className="stage-select" data-placeholder={!audience || undefined} value={audience}
                onChange={event => form.update('targetAudience', event.target.value)} onBlur={() => leave('targetAudience')}>
                <option value="" disabled>{text('请选择', 'Choose')}</option>
                {audience && !Object.hasOwn(AUDIENCE_EN, audience) && <option value={audience}>{audience}</option>}
                {Object.entries(AUDIENCE_EN).map(([value, labelEn]) => <option key={value} value={value}>{text(value, labelEn)}</option>)}
              </select>
            </div>
            <div className="stage-setup-field">
              <label className="stage-setup-label" htmlFor={`${baseId}-pov`}>{text('叙事视角', 'Point of view')}</label>
              <OptionSelect id={`${baseId}-pov`} value={config.narrativePOV} options={POV_OPTIONS} onChange={value => form.update('narrativePOV', value)} />
            </div>
            <div className="stage-setup-field">
              <label className="stage-setup-label" htmlFor={`${baseId}-structure`}>{text('故事结构', 'Story structure')}</label>
              <OptionSelect id={`${baseId}-structure`} value={config.plotStructure} options={STRUCTURE_OPTIONS} onChange={value => form.update('plotStructure', value)} />
            </div>
            <div className="stage-setup-field">
              <label className="stage-setup-label" htmlFor={`${baseId}-sub`}>{text('细分类型', 'Subgenre')}</label>
              <input id={`${baseId}-sub`} className="pi-input" value={textOf(config.subGenre)}
                placeholder={text('如：修仙/重生/末世', 'e.g. cultivation / rebirth')} onChange={event => form.update('subGenre', event.target.value)} />
            </div>
            <div className="stage-setup-field">
              <label className="stage-setup-label" htmlFor={`${baseId}-language`}>{text('写作语言', 'Writing language')}</label>
              <select id={`${baseId}-language`} className="stage-select" value={resolveWritingLanguage(config.writingLanguage)}
                onChange={event => form.update('writingLanguage', event.target.value as WritingLanguage)}>
                <option value="zh-CN">{text('简体中文', 'Simplified Chinese')}</option>
                <option value="en-US">English</option>
              </select>
            </div>
            <div className="stage-setup-field">
              <label className="stage-setup-label" htmlFor={`${baseId}-thread`}>{text('伏笔沉寂提醒', 'Dormant thread reminder')}</label>
              <div className="stage-setup-length">
                <NumberInput id={`${baseId}-thread`} value={config.narrativeThreadDormantChapterThreshold as unknown === '' ? '' : threshold}
                  fallback={DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD} min={MIN_NARRATIVE_THREAD_DORMANT_THRESHOLD} max={MAX_NARRATIVE_THREAD_DORMANT_THRESHOLD}
                  label={text('伏笔沉寂提醒（章）', 'Dormant thread reminder (chapters)')}
                  onChange={value => form.update('narrativeThreadDormantChapterThreshold', (value === '' ? '' : resolveNarrativeThreadDormantThreshold(value)) as number)} />
                <span>{text('章没推进就提醒', 'chapters idle')}</span>
              </div>
              <p className="stage-setup-field-note">{text(
                `在剧情页标出。默认 ${DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD} 章，只影响这部作品。`,
                `Flagged on the plot page. Default ${DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD}; this book only.`,
              )}</p>
            </div>
          </section>

          <section className="stage-setup-sheet" aria-labelledby={`${baseId}-sheet`}>
            <div className="stage-setup-sheet-head">
              <h2 id={`${baseId}-sheet`} className="stage-setup-sheet-title">{text('设定细则', 'Details')}</h2>
              <span className="stage-setup-sheet-count">{sheetCount}</span>
            </div>
            {SHEET_FIELDS.map(field => <SheetRow key={field.id} field={field} config={config} form={form} aiReason={aiReason} />)}
          </section>

          <section className="stage-setup-outline" data-missing={isMissing('coreOutline') || undefined}>
            <div className="stage-setup-outline-head">
              <RequiredLabel htmlFor={baseId} name={text('核心大纲', 'Core outline')} missing={isMissing('coreOutline')} alert={alert('coreOutline')} />
              <AiButton field="coreOutline" label={text('核心大纲', 'Core outline')} form={form} disabledReason={aiReason} />
            </div>
            <textarea
              id={baseId}
              className="stage-setup-outline-input"
              value={outline}
              placeholder={text('谁，在哪里，想要什么，又被什么挡住了路。', 'Who, where, what they want, and what stands in the way.')}
              onChange={event => form.update('coreOutline', event.target.value)}
              onBlur={() => leave('coreOutline')}
            />
            <div className="stage-setup-outline-foot">
              <span>{text('用一两句话说说这个故事，AI 按它补全其余设定。', 'Tell the story in a sentence or two; AI fills in the rest from it.')}</span>
              <span className="pi-num-ui">{text(`${countDraftUnits(outline)} 字`, `${countDraftUnits(outline)} ${pluralEn(countDraftUnits(outline), 'word')}`)}</span>
            </div>
            <GenerateError field="coreOutline" label={text('核心大纲', 'Core outline')} form={form} />
          </section>
        </div>
      </div>

      <footer className="stage-setup-foot">
        <Button variant="secondary" disabled={fillReason !== null || filling} aria-describedby={fillReason ? fillReasonId : undefined} onClick={requestFill}>
          {filling ? <LoaderCircle size={15} className="stage-update-spin" aria-hidden="true" /> : <Sparkles size={15} className="stage-setup-spark" aria-hidden="true" />}
          {filling ? text('AI 正在补全…', 'AI is filling in…') : text('AI 补全其余设定', 'Fill the rest with AI')}
        </Button>
        <DisabledReason id={fillReasonId} reason={fillReason} />
        {form.saveOutcome === 'failed'
          ? <span className="stage-setup-hint" id={hintId} data-tone="danger" role="alert">{text('没能保存。设定还在这一页，没有丢，可以再保存一次。', 'Could not save. Your setup is still on this page; try saving again.')}</span>
          : <span className="stage-setup-hint" id={hintId} data-ready={missing.length === 0 || undefined} role="status">{hint}</span>}
        {form.dirty && (
          <Button variant="text" disabled={form.saving} onClick={() => void form.save()}>
            {form.saving ? text('正在保存…', 'Saving…') : text('保存', 'Save')}<kbd>{commandLabel('s')}</kbd>
          </Button>
        )}
        <Button variant="primary" disabled={missing.length > 0 || form.saving} aria-describedby={hintId} onClick={() => void goNext()}>
          {text('下一步：故事架构', 'Next: story architecture')}
          <ArrowRight size={15} aria-hidden="true" />
        </Button>
      </footer>

      <InkDialog
        open={expandFields !== null}
        onOpenChange={next => { if (!next) setExpandFields(null) }}
        title={text('扩写已有的设定？', 'Expand what you have written?')}
        description={text('下面这些已经有你写的内容。AI 会保留原文，只在后面补充：', 'These already have your writing. AI keeps it and only adds to it:')}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setExpandFields(null)}>{text('取消', 'Cancel')}</Button>
            <Button variant="primary" onClick={startFill}>{text('继续扩写', 'Expand')}</Button>
          </>
        )}
      >
        <ul className="stage-setup-expand-list">
          {expandFields?.map(field => <li key={field}>{field}</li>)}
        </ul>
      </InkDialog>
    </div>
  )
}
