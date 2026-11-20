import type { Locale } from '../../i18n/types'
import type { MainGenerationRunHandle, MainGenerationRunView } from '../../services/generation/generation-runtime'
import type { GenerationBudgetDiagnostic } from '../../services/generation/task-budget-planner'
import { canCommitRecoveredReview } from '../../services/workflows/commands/review-chapter.command'
import { withoutDraftReconciliationArtifacts } from '../../shared/draft-reconciliation'
import type { EditorInlineRecovery } from '../../shared/editor-inline-generation'
import type { GenerationBatchHistory, GenerationRecoveryContext, GenerationRecoveryList } from '../../shared/generation-owner-contract'
import { plotOutlineSourceInvalidText } from '../../shared/plot-outline-contract'
import { pluralEn } from '../../shared/plural-en'
import { editorCanContinue, reviewCanResume } from '../../shared/recovery-actions'
import type { RecoveryCandidate } from '../../shared/recovery-candidate'
import { buildReviewCycleRecheckReport, recheckCommitPolicy, type ReviewCycleRecheckContext } from '../../shared/review-cycle'
import { parseReviewGenerationResult } from '../../shared/review-generation-report'
import type { ReviewRevisionRecovery } from '../../shared/review-revision-generation'
import { workflowResourceKey, type WorkflowRun } from '../../stores/workflow-store'
import type { NoticeTone } from '../ui/Notice'

/**
 * 运行中断后可以接着做的事。运行侧页从这里取标题、提示、可复制的文字与动作是否可用，
 * 自己只负责排版；数据由 use-run-recovery 读取，动作也由它执行。
 */
export type RecoveryEntry = CandidateEntry | PlanningEntry | EditorEntry | ReviewEntry | BatchEntry | DraftEntry

export interface RecoveryText {
  id: string
  text: string
}

interface Usage {
  budget?: readonly GenerationBudgetDiagnostic[]
  /** 「已用 N 次请求」。 */
  usage?: string
}

/** 写作中断时留下的正文候选（旧的恢复候选表）。 */
export interface CandidateEntry {
  kind: 'candidate'
  key: string
  title: string
  staleNote?: string
  text: string
  canContinue: boolean
  candidate: RecoveryCandidate
}

/** 情节大纲或章节蓝图自动生成中断后保留的恢复稿。 */
export interface PlanningEntry {
  kind: 'planning'
  key: string
  title: string
  /** 「缺第 16 章 · 11月7日 14:32 生成」：作者靠它分清同一范围的几份。 */
  meta: string
  note: string
  actionLabel: string
  canDismiss: boolean
  /** 同一范围更早的几份，新的在前。 */
  earlier: PlanningEntry[]
  labels: { earlier: string }
  recovery: GenerationRecoveryContext
}

/** 正文选区或整章批注的 AI 建议中断。 */
export interface EditorEntry extends Usage {
  kind: 'editor'
  key: string
  title: string
  selectedText: string
  instructionNote?: string
  conflictNote?: string
  suggestions: (RecoveryText & { incompleteNote?: string })[]
  tails: RecoveryText[]
  documentText: string
  canContinue: boolean
  hideKey: string
  labels: { copySuggestion: string; copyTail: string; copyDocument: string; continue: string }
  recovery: EditorInlineRecovery
}

/** 审修候选的一段输出：卡片显示 display，复制拿 text（原文）。审稿是结构化报告，display 是可读摘要；修稿是正文，两者相同。 */
export interface ReviewText extends RecoveryText {
  display: string
}

/** 审稿或修稿中断。 */
export interface ReviewEntry extends Usage {
  kind: 'review'
  key: string
  chapterNumber: number
  title: string
  notes: string[]
  artifacts: ReviewText[]
  tails: ReviewText[]
  actionLabel: string
  canAct: boolean
  /** 结果已经保存：卡片只留给作者打开或复制，不再算可恢复。 */
  saved: boolean
  hideKey: string
  labels: { copy: string; copyTail: string }
  view: MainGenerationRunView
}

/** 批量创作中断，可从下一章继续。 */
export interface BatchEntry {
  kind: 'batch'
  key: string
  title: string
  actionLabel: string
  batchId: string
  range: { startChapter: number; endChapter: number }
  handle: MainGenerationRunHandle
}

/** 单章写作中断、没保存：勾选保留的片段续写，或沿已存细纲继续。 */
export interface DraftEntry extends Usage {
  kind: 'draft'
  key: string
  chapterNumber?: number
  title: string
  artifacts: (RecoveryText & { selectable: boolean })[]
  tails: RecoveryText[]
  note: string
  actionLabel: string
  hideKey: string
  /** 草稿保存后正文又改过：只能复制。 */
  changed: boolean
  /** 没有已存的续写方案时，至少要勾选一段才能继续。 */
  needsPick: boolean
  labels: { copy: string; tailLead: string }
  view: MainGenerationRunView
}

/** 主进程算好的可恢复运行，加上旧恢复候选表。 */
export interface RecoverySources extends Omit<GenerationRecoveryList, 'partial'> {
  candidates: readonly RecoveryCandidate[]
}

export const EMPTY_RECOVERY_SOURCES: RecoverySources = { candidates: [], planning: [], editors: [], reviews: [], batches: [], drafts: [] }

function lang(locale: Locale) {
  return (zh: string, en: string) => locale === 'en-US' ? en : zh
}

function usageOf(view: Pick<MainGenerationRunView, 'budgetDiagnostics' | 'ledger'>, locale: Locale): Usage {
  const t = lang(locale)
  return {
    budget: view.budgetDiagnostics,
    usage: view.ledger ? t(`已用 ${view.ledger.physicalRequests} 次请求`, `${view.ledger.physicalRequests} ${pluralEn(view.ledger.physicalRequests, 'request')} used`) : undefined,
  }
}

/** 没写出任何字的片段（例如刚发出请求就取消）没有可复制、可续接的内容，不列出。 */
export const hasText = (item: { text: string }) => item.text.trim().length > 0

/** 1.4.0 本机「不再显示」的标记：运行 id 加当时列出的片段与尾段。 */
const hideKeyOf = (runId: string, items: readonly RecoveryText[]) => `${runId}#${items.map(item => `${item.id}:${item.text.length}`).join(',')}`

const texts = (items: readonly { attemptId: string; text: string }[] | undefined): RecoveryText[] =>
  (items ?? []).filter(hasText).map(item => ({ id: item.attemptId, text: item.text }))

export function candidateEntry(candidate: RecoveryCandidate, locale: Locale): CandidateEntry {
  const t = lang(locale)
  return {
    kind: 'candidate',
    key: candidate.candidateId,
    title: t(
      `${candidate.replacesCandidateId ? '替代候选' : '原始候选'} · 第${candidate.chapterNumber}章 ${candidate.chapterTitle}`,
      `${candidate.replacesCandidateId ? 'Replacement candidate' : 'Original candidate'} · Chapter ${candidate.chapterNumber} ${candidate.chapterTitle}`,
    ),
    staleNote: candidate.sourceCurrent ? undefined : t('源章节已变化；可复制或放弃，但不能直接继续。', 'The source chapter changed. You can copy or discard this candidate, but cannot continue it directly.'),
    text: candidate.visibleText,
    canContinue: candidate.sourceCurrent,
    candidate,
  }
}

const chapterSpan = (range: { from: number; to: number }) => range.from === range.to ? `${range.from}` : `${range.from}–${range.to}`

export function planningTitle(recovery: Pick<GenerationRecoveryContext, 'plotOutlineRecovery' | 'plotOutline' | 'planningDraft'>, locale: Locale): string {
  const t = lang(locale)
  const outline = Boolean(recovery.plotOutlineRecovery)
  const range = recovery.planningDraft?.requestedRange ?? (outline ? recovery.plotOutline?.range : undefined)
  if (!range) return outline ? t('大纲恢复稿', 'Outline recovery draft') : t('蓝图恢复稿', 'Blueprint recovery draft')
  const chapters = chapterSpan(range)
  return outline ? t(`大纲恢复稿 · 第 ${chapters} 章`, `Outline recovery draft · ch. ${chapters}`)
    : t(`蓝图恢复稿 · 第 ${chapters} 章`, `Blueprint recovery draft · ch. ${chapters}`)
}

type OutlineRecoverySource = Pick<GenerationRecoveryContext, 'plotOutline' | 'plotOutlineRecovery' | 'planningContinuation'>

/** 大纲恢复稿在（已保存 × 写状态 × 续写状态）表里的哪一格，以及这一格给作者的说明和主操作。 */
export interface OutlineRecoveryGuide {
  kind: 'unavailable' | 'regenerate' | 'continued' | 'saved' | 'waiting' | 'editable'
  tone: NoticeTone
  title: string | null
  note: string | null
  continuable: boolean
  primary: 'save' | 'continue' | null
  showRemaining: boolean
  restart: { from: number; to: number } | null
}

export function outlineRecoveryGuide(recovery: OutlineRecoverySource, snapshot: 'pending' | 'saved' | undefined, locale: Locale): OutlineRecoveryGuide {
  const t = lang(locale)
  const candidate = recovery.plotOutlineRecovery, outline = recovery.plotOutline, continuation = recovery.planningContinuation
  const continuable = Boolean(continuation?.remainingRange) && ['ready', 'continued'].includes(continuation?.state ?? '')
  const guide = (kind: OutlineRecoveryGuide['kind'], tone: NoticeTone, title: string | null, note: string | null,
    restart: OutlineRecoveryGuide['restart'] = null): OutlineRecoveryGuide => ({
    kind, tone, title, note, restart, continuable: kind === 'regenerate' ? false : continuable,
    primary: kind === 'regenerate' ? null : continuable ? 'continue' : kind === 'editable' ? 'save' : null,
    showRemaining: kind !== 'regenerate' && kind !== 'unavailable',
  })
  const unavailable = () => guide('unavailable', 'warn', t('恢复内容暂时无法读取', 'Recovery content is unavailable'), t('请重新打开恢复稿。', 'Reopen the recovery draft.'))
  if (!candidate) return unavailable()
  const blocked = candidate.writeState?.kind === 'blocked' ? candidate.writeState.reason : null
  const resendingSave = snapshot === 'pending' && Boolean(candidate.saved)
  const saved = snapshot === 'saved' || snapshot !== 'pending' && Boolean(candidate.saved || blocked === 'author-saved')

  if (continuation?.state === 'continued') {
    const back = t('点「继续生成缺少的章节」回到那一次生成。', 'Click “Generate remaining chapters” to go back to that run.')
    return guide('continued', 'info', saved ? t('本次恢复已保存，也已接着生成过', 'This recovery is saved and was already continued')
      : t('这批大纲已经接着生成过', 'This outline batch was already continued'),
    saved ? continuable ? back : null : continuable ? t(`不能再保存。${back}`, `It can no longer be saved. ${back}`) : t('不能再保存。', 'It can no longer be saved.'))
  }
  if ((blocked === 'source-changed' || blocked === 'source-invalid') && !resendingSave) {
    const remaining = candidate.saved?.remainingRange
    if (saved && remaining) {
      return guide('regenerate', 'warn', t('本次恢复已保存，但不能接着生成', 'This recovery is saved, but generation cannot continue'),
        t(`保存后正式大纲、模型设置、作品设定、提示词模板或写作 Skill 有改动。请从第 ${remaining.from} 章重新生成情节大纲。`,
          `The outline, model settings, book settings, a prompt template, or a writing skill changed after saving. Generate the plot outline again from chapter ${remaining.from}.`),
        remaining)
    }
    if (!saved) {
      return guide('regenerate', 'warn', t('不能保存，也不能继续生成', 'This draft cannot be saved or continued'),
        outlineSourceInvalidNote(recovery, locale) ?? outlineSourceChangedNote(recovery, locale), blocked === 'source-changed' ? outline?.range ?? null : null)
    }
  }
  if (saved) {
    return guide('saved', 'ok', t('本次恢复已保存，后续修改仅供复制。', 'This recovery is saved. Further edits can only be copied.'),
      continuable ? t('点「继续生成缺少的章节」接着生成。', 'Click “Generate remaining chapters” to keep going.') : null)
  }
  if (blocked === 'in-flight') {
    return guide('waiting', 'info', t('大纲还在生成', 'The outline is still generating'),
      t('生成结束后才能保存或继续。恢复稿可以先编辑、复制。', 'Save or continue after it finishes. You can edit or copy this draft meanwhile.'))
  }
  return outline ? guide('editable', 'info', null, null) : unavailable()
}

export function outlineRecoveryViewOnly(guide: Pick<OutlineRecoveryGuide, 'kind'> | null): boolean {
  return guide?.kind === 'regenerate' || guide?.kind === 'continued'
}

/** 时间按作者电脑的时区。 */
export function planningMeta(recovery: Pick<GenerationRecoveryContext, 'planningContinuation' | 'planningDraft' | 'plotOutlineRecovery' | 'plotOutline'>, locale: Locale): string {
  const t = lang(locale)
  const regenerate = recovery.plotOutlineRecovery && outlineRecoveryGuide(recovery, undefined, locale).kind === 'regenerate'
  const remaining = regenerate ? undefined : recovery.planningContinuation?.remainingRange
  const createdAt = recovery.planningDraft?.createdAtMs
  return [
    remaining && t(`缺第 ${chapterSpan(remaining)} 章`, `Missing ch. ${chapterSpan(remaining)}`),
    createdAt !== undefined && t(`${planningTime(createdAt, locale)} 生成`, `Generated ${planningTime(createdAt, locale)}`),
  ].filter(Boolean).join(' · ')
}

function planningTime(ms: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
}

/** 恢复稿编辑器顶部的待完成范围；只剩一章时与标题一样写「第 6 章」。 */
export function planningRemainingText(range: { from: number; to: number }, targetUnits: number, unit: string, text: (zh: string, en: string) => string): string {
  return range.from === range.to
    ? text(`待完成第 ${range.from} 章，每章目标 ${targetUnits} ${unit}。`, `Chapter ${range.from} remains. Target ${targetUnits} ${unit} per chapter.`)
    : text(`待完成第 ${range.from} 至 ${range.to} 章，每章目标 ${targetUnits} ${unit}。`, `Chapters ${range.from} to ${range.to} remain. Target ${targetUnits} ${unit} per chapter.`)
}

/** 升级前以现行规则判无效的大纲开跑、不能继续的大纲恢复稿：说明是重复章号、乱序还是章号与范围对不上；不是来源无效时为 null，由调用方用通用说明。 */
export function outlineSourceInvalidNote(recovery: Pick<GenerationRecoveryContext, 'plotOutline' | 'plotOutlineRecovery'>, locale: Locale): string | null {
  const writeState = recovery.plotOutlineRecovery?.writeState
  if (writeState?.kind !== 'blocked' || writeState.reason !== 'source-invalid') return null
  return plotOutlineSourceInvalidText(recovery.plotOutline?.sourceExpected.synopsis ?? '', locale)
}

/** 大纲恢复稿因来源（模型设置、作品设定、提示词模板或写作 Skill）已变而被封锁写回。 */
function outlineSourceChangedBlocked(recovery: Pick<GenerationRecoveryContext, 'plotOutlineRecovery'>): boolean {
  const writeState = recovery.plotOutlineRecovery?.writeState
  return writeState?.kind === 'blocked' && writeState.reason === 'source-changed'
}

/**
 * 来源已变的大纲恢复稿：只能查看或复制；正式大纲还没有这一批时（含最后一章生成完、正式保存被来源检查拒绝）
 * 要从本批起始章重新生成。其余情况为 null。
 */
export function outlineSourceChangedNote(recovery: Pick<GenerationRecoveryContext, 'plotOutline' | 'plotOutlineRecovery'>, locale: Locale): string | null {
  if (!outlineSourceChangedBlocked(recovery)) return null
  const t = lang(locale), outline = recovery.plotOutline
  if (recovery.plotOutlineRecovery?.inFormalOutline) {
    return t('这批大纲已经生成完毕，但模型设置、作品设定、提示词模板或写作 Skill 变了，恢复稿只能查看或复制。',
      'This outline batch finished, but the model settings, book settings, a prompt template, or a writing skill changed, so the recovery draft can only be viewed or copied.')
  }
  const from = outline?.range.from
  return from
    ? t(`模型设置、作品设定、提示词模板或写作 Skill 变了，恢复稿只能查看或复制。请从第 ${from} 章重新生成情节大纲。`,
      `The model settings, book settings, a prompt template, or a writing skill changed, so the recovery draft can only be viewed or copied. Generate the plot outline again from chapter ${from}.`)
    : t('模型设置、作品设定、提示词模板或写作 Skill 变了，恢复稿只能查看或复制。请重新生成情节大纲。',
      'The model settings, book settings, a prompt template, or a writing skill changed, so the recovery draft can only be viewed or copied. Generate the plot outline again.')
}

function planningEntry(recovery: GenerationRecoveryContext, locale: Locale, earlier: PlanningEntry[] = []): PlanningEntry {
  const t = lang(locale)
  const guide = recovery.plotOutlineRecovery ? outlineRecoveryGuide(recovery, undefined, locale) : null
  return {
    kind: 'planning',
    key: recovery.handle.runId,
    title: planningTitle(recovery, locale),
    meta: planningMeta(recovery, locale),
    note: guide?.note ?? t('自动生成已保留候选。可编辑并本地保存，或明确继续缺少的章节。', 'The candidate is preserved. Edit and save it locally, or explicitly generate the remaining chapters.'),
    actionLabel: outlineRecoveryViewOnly(guide) ? t('查看恢复稿', 'View recovery draft') : t('编辑恢复稿', 'Edit recovery draft'),
    canDismiss: recovery.planningContinuation?.state !== 'in-flight',
    earlier,
    labels: {
      earlier: t(`更早的 ${earlier.length} 份`, `${earlier.length} earlier ${pluralEn(earlier.length, 'draft')}`),
    },
    recovery,
  }
}

function groupPlanning(recoveries: readonly GenerationRecoveryContext[], locale: Locale): PlanningEntry[] {
  const groups = new Map<string, GenerationRecoveryContext[]>()
  for (const recovery of recoveries) {
    const range = recovery.planningDraft?.requestedRange
    const key = range ? `${recovery.plotOutlineRecovery ? 'outline' : 'blueprint'}:${range.from}-${range.to}` : `run:${recovery.handle.runId}`
    groups.set(key, [...groups.get(key) ?? [], recovery])
  }
  const createdAt = (recovery: GenerationRecoveryContext) => recovery.planningDraft?.createdAtMs ?? 0
  return [...groups.values()]
    .map(group => [...group].sort((a, b) => createdAt(b) - createdAt(a)))
    .sort((a, b) => createdAt(b[0]) - createdAt(a[0]))
    .map(([newest, ...earlier]) => planningEntry(newest, locale, earlier.map(recovery => planningEntry(recovery, locale))))
}

function editorEntry(recovery: EditorInlineRecovery, locale: Locale): EditorEntry {
  const t = lang(locale)
  const { view } = recovery
  const suggestions = (view.candidates ?? view.artifacts).filter(hasText).map(artifact => ({
    id: artifact.artifactId,
    text: artifact.text,
    incompleteNote: artifact.status === 'completed' ? undefined : t('生成未完整完成，保留的文字仅供参考。', 'Generation is incomplete; the saved text is for reference.'),
  }))
  const tails = texts(view.unsavedTails)
  return {
    kind: 'editor',
    key: view.handle.runId,
    title: recovery.context.action === 'batch-instruct' ? t('批注修改建议', 'Annotation revision') : t('编辑器选区建议', 'Editor selection suggestion'),
    selectedText: recovery.context.selectedText,
    instructionNote: recovery.context.action === 'instruct'
      ? t(`作者意见：${recovery.context.instruction}`, `Author note: ${recovery.context.instruction}`)
      : recovery.context.action === 'batch-instruct'
        ? t(`作者批注 ${recovery.context.annotations.length} 条`, `${recovery.context.annotations.length} author ${pluralEn(recovery.context.annotations.length, 'annotation')}`)
        : undefined,
    ...usageOf(view, locale),
    conflictNote: recovery.sourceStatus === 'conflict' ? t('来源已变化；原建议仍可复制。', 'Sources changed; the original suggestion can still be copied.') : undefined,
    suggestions,
    tails,
    documentText: recovery.context.documentText,
    canContinue: editorCanContinue(recovery),
    hideKey: hideKeyOf(view.handle.runId, [...suggestions, ...tails]),
    labels: {
      copySuggestion: t('复制建议', 'Copy suggestion'),
      copyTail: t('复制未保存文字', 'Copy unsaved text'),
      copyDocument: t('复制原文稿', 'Copy original manuscript'),
      continue: t('继续原选区任务', 'Continue original selection task'),
    },
    recovery,
  }
}

const SEVERITY_ORDER = { error: 0, warning: 1, pass: 2 } as const

/**
 * 审稿输出是结构化报告：按保存时同一份审稿契约解析，写成结论与条数一行、再列最多两条意见（问题在前）。
 * 解析不了（半截输出、不合契约）时只说明它是结构化结果，原文留给复制。
 */
function reviewDigest(text: string, locale: Locale): string {
  const t = lang(locale)
  let report: ReturnType<typeof parseReviewGenerationResult>
  try {
    report = parseReviewGenerationResult(text)
  } catch {
    return t('这是审稿的结构化结果，未能整理成摘要；复制可得到原文。', 'This is a structured review result that could not be summarized. Copy it to get the original text.')
  }
  // 通过项不算意见，条数和单章视图「按 N 项意见修稿」同一口径。
  const passed = report.items.filter(item => item.severity === 'pass').length
  const notes = report.items.length - passed
  const counted = t(`${notes} 条意见`, `${notes} ${pluralEn(notes, 'note')}`)
  const countLabel = passed === 0
    ? t(`（${counted}）`, ` (${counted})`)
    : t(`（${counted}，${passed} 项通过）`, ` (${counted}, ${passed} passed)`)
  const label = { error: t('问题', 'Issue'), warning: t('建议', 'Suggestion'), pass: t('通过', 'Pass') }
  const points = [...report.items].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]).slice(0, 2)
    .map(item => t(`${label[item.severity]} · ${item.category}：${item.description}`, `${label[item.severity]} · ${item.category}: ${item.description}`))
  return [`${report.summary}${countLabel}`, ...points].join('\n')
}

type RecheckItems = readonly Record<string, unknown>[]

/**
 * 复核摘要要和保存结果一致。已保存的直接读保存下来的报告：升级前按第 1 版保存的可能是已解决；
 * 保存的是运行最后一份候选，保存后运行不再追加请求。未保存的按保存路径的口径（recheckCommitPolicy）现算，
 * 提交时存下的就是这一份。解析不了时为 null。
 */
function recheckItems(item: RecoveryText, recovery: ReviewRevisionRecovery, recheck: ReviewCycleRecheckContext, locale: Locale): RecheckItems | null {
  if (recovery.saved && item.id === recovery.latestArtifact?.artifactId) return (JSON.parse(recovery.saved.content) as { items: RecheckItems }).items
  const report = buildReviewCycleRecheckReport(item.text, recovery.context.source.content, recheckCommitPolicy(recheck), locale, 2)
  return report.validModelOutput ? report.items : null
}

/**
 * 复核结果写成结论与条数一行，再列最多两条，未解决在前、已解决在后。
 * 结论按全部意见写，不照抄模型的 summary（它可能自称全部解决）。解析不了时同审稿一样只给说明。
 */
function recheckDigest(items: RecheckItems | null, locale: Locale): string {
  const t = lang(locale)
  if (!items) return t('这是复核的结构化结果，未能整理成摘要；复制可得到原文。', 'This is a structured recheck result that could not be summarized. Copy it to get the original text.')
  const count = items.length
  const conclusion = count > 0 && items.every(item => item.severity === 'pass')
    ? t('复核确认全部意见已解决', 'The recheck confirmed that every note is resolved')
    : t('复核未能确认全部意见已解决', 'The recheck could not confirm that every note is resolved')
  const order = { warning: 0, unknown: 1, pass: 2 } as const
  const label = { warning: t('未解决', 'Unresolved'), unknown: t('待核实', 'Needs verification'), pass: t('已解决', 'Resolved') }
  const points = items.map(item => ({ severity: item.severity as keyof typeof order, category: String(item.category), description: String(item.description) }))
    .sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 2)
    .map(item => t(`${label[item.severity]} · ${item.category}：${item.description}`, `${label[item.severity]} · ${item.category}: ${item.description}`))
  return [t(`${conclusion}（${count} 条意见）`, `${conclusion} (${count} ${pluralEn(count, 'item')})`), ...points].join('\n')
}

function reviewEntry({ view, recovery }: RecoverySources['reviews'][number], locale: Locale): ReviewEntry {
  const t = lang(locale)
  const review = recovery.context.operation === 'review-chapter'
  const recheck = recovery.context.recheck
  const digest = (item: RecoveryText) => recheck ? recheckDigest(recheckItems(item, recovery, recheck, locale), locale) : reviewDigest(item.text, locale)
  const shown = (item: RecoveryText): ReviewText => ({ ...item, display: review ? digest(item) : item.text })
  const requestsReview = review && !recovery.saved && !canCommitRecoveredReview(recovery)
  const current = recovery.sourceStatus === 'current'
  const live = view.status !== 'cancelled'
  const notes = [
    recovery.sourceStatus === 'conflict' && !recovery.saved
      && t('来源已变化；候选仍可复制，不能直接保存。', 'Sources changed; copy the candidate to preserve it. Direct saving is unavailable.'),
    current && !recovery.saved && !recovery.canResume && !review
      && t('候选未通过保存校验；可复制保留，请从原稿重新发起任务。', 'The candidate failed save validation. Copy it if needed, then start a new action from the source draft.'),
    current && live && !recovery.saved && !recovery.canResume && review
      && t('当前任务的审稿请求次数已用尽。原稿保留，可从原稿发起新的审稿任务。', 'This task has used all review attempts. The source draft is preserved. Start a new review task from the source draft.'),
    requestsReview && reviewCanResume(view, recovery)
      && t('尚无完整审稿报告。重新审稿会重新调用模型；原稿保留。', 'No complete review report is available. Reviewing again sends a new model request; the source draft is preserved.'),
  ].filter((note): note is string => Boolean(note))
  const artifacts = (view.candidates ?? view.artifacts).filter(hasText).map(artifact => shown({ id: artifact.artifactId, text: artifact.text }))
  const tails = texts(view.unsavedTails).map(shown)
  return {
    kind: 'review',
    key: view.handle.runId,
    chapterNumber: recovery.context.source.chapterNumber,
    title: t(`第${recovery.context.source.chapterNumber}章${review ? '审稿' : '修稿'}候选`,
      `Chapter ${recovery.context.source.chapterNumber} ${review ? 'review' : 'revision'} candidate`),
    ...usageOf(view, locale),
    notes,
    artifacts,
    tails,
    actionLabel: recovery.saved ? t('打开已保存结果', 'Open saved result')
      : requestsReview ? t('重新审稿', 'Review again') : t('恢复此审修任务', 'Recover this review or revision'),
    canAct: Boolean(recovery.saved) || reviewCanResume(view, recovery),
    saved: Boolean(recovery.saved),
    hideKey: hideKeyOf(view.handle.runId, [...artifacts, ...tails]),
    labels: { copy: t('复制', 'Copy'), copyTail: t('复制未保存文字', 'Copy unsaved text') },
    view,
  }
}

function batchEntry(batch: GenerationBatchHistory, locale: Locale): BatchEntry {
  const t = lang(locale)
  return {
    kind: 'batch',
    key: batch.batchId,
    title: t(`批量正文：已保存 ${batch.completedChapters.length} 章，下一章 ${batch.nextChapterNumber}`,
      `Batch drafts: ${batch.completedChapters.length} saved; next chapter ${batch.nextChapterNumber}`),
    actionLabel: t('继续此批次', 'Continue this batch'),
    batchId: batch.batchId,
    range: batch.range,
    handle: batch.rootHandle,
  }
}

function draftEntry({ view, recovery }: RecoverySources['drafts'][number], locale: Locale): DraftEntry {
  const t = lang(locale)
  const unique = [...new Map([...view.artifacts, ...(view.candidates ?? [])].map(item => [item.artifactId, item])).values()]
  // 保存过的运行只在还有没落盘的尾段时才列出；保存后正文又改过的，续写会被主进程拒绝，只能复制。
  const changed = recovery.draftSave.kind === 'changed'
  const outlineOnly = !recovery.composition && recovery.attemptedPurposes.every(purpose => purpose === 'chapter-draft-short-outline')
    && Boolean(recovery.draftShortOutline?.completedOutput || recovery.draftShortOutline?.retry?.kind === 'available')
  const artifacts = withoutDraftReconciliationArtifacts(unique, recovery).filter(hasText).map(artifact => ({
    id: artifact.artifactId, text: artifact.text, selectable: !changed && artifact.compositionEligible === true,
  }))
  const tails = texts(view.unsavedTails)
  return {
    kind: 'draft',
    key: view.handle.runId,
    hideKey: hideKeyOf(view.handle.runId, [...artifacts, ...tails]),
    chapterNumber: recovery.chapterNumber,
    title: changed ? t(`第${recovery.chapterNumber}章生成记录`, `Chapter ${recovery.chapterNumber} generation history`)
      : t(`第${recovery.chapterNumber}章候选`, `Chapter ${recovery.chapterNumber} candidate`),
    ...usageOf(view, locale),
    artifacts,
    tails,
    note: changed ? t(`草稿已保存，之后又改过。在「正文」打开第 ${recovery.chapterNumber} 章看当前稿；原生成文字仍可复制。`,
      `The draft was saved and later edited. Open Chapter ${recovery.chapterNumber} in Manuscript to see the current text. The original generated text can still be copied.`)
      : t('勾选顺序决定续接顺序；未完成或来源冲突的片段仍可复制。', 'Selection order determines continuation order. Incomplete or conflicted text can still be copied.'),
    actionLabel: changed ? t('已保存，正文已修改', 'Saved, then edited')
      : outlineOnly ? recovery.draftShortOutline?.retry?.kind === 'available'
        ? t('重做一次细纲并继续写稿', 'Retry outline once and continue drafting')
        : t('沿原细纲继续写稿', 'Continue drafting with the saved outline')
        : t('确认继续已选正文', 'Confirm selected draft continuation'),
    changed,
    needsPick: !recovery.composition && !outlineOnly,
    labels: { copy: t('复制', 'Copy'), tailLead: t('尚未落盘的正文，可先复制保留：', 'Text not yet saved; copy it to preserve it:') },
    view,
  }
}

/**
 * 这次打开作品后还在进行的工作：它正显示在运行卡片里，不是中断留下的。
 * 单章与审修要这次打开里有单章运行正占着这一章：会话内失败时持久状态不会改，仍记为 running，不能当作还在写。
 * 批量运行也占着各章，但它写的正文带批次号、不列为单章条目（use-run-recovery），也不跑审修，所以不算。
 * 选区生成不是工作流运行，看 epoch：上次打开时没写完的换过会话，仍算可恢复。这次打开里写完的运行状态仍是 running，有完整建议就不算在写。
 * 批量看进行中（含暂停）的批量运行：资源锁让同一批章同时只有一个批量运行在写，范围相同就是它在推进这一批。
 */
export function isInFlight(entry: RecoveryEntry, leaseId: string | undefined, liveRuns: readonly Pick<WorkflowRun, 'type' | 'resourceKeys'>[]): boolean {
  if (entry.kind === 'batch') return liveRuns.some(run => run.type === 'batch_generate' && sameChapters(run.resourceKeys, entry.range))
  if (entry.kind === 'editor') {
    const { view } = entry.recovery
    return view.status === 'running' && view.handle.epoch === leaseId && !(view.candidates ?? view.artifacts).some(item => item.status === 'completed')
  }
  if ((entry.kind !== 'draft' && entry.kind !== 'review') || entry.chapterNumber === undefined) return false
  const chapter = workflowResourceKey('chapter', entry.chapterNumber)
  return entry.view.status === 'running' && entry.view.handle.epoch === leaseId
    && liveRuns.some(run => run.type !== 'batch_generate' && run.resourceKeys?.includes(chapter))
}

function sameChapters(keys: readonly string[] | undefined, range: BatchEntry['range']): boolean {
  const chapters = (keys ?? []).flatMap(key => /^chapter:(\d+)$/.exec(key)?.[1] ?? []).map(Number)
  return chapters.length === range.endChapter - range.startChapter + 1
    && chapters.every((chapter, index) => chapter === range.startChapter + index)
}

/** 单章候选的续写按钮是否可点：勾了片段，或有已存方案可沿用。 */
export function canResumeDraft(entry: DraftEntry, picked: readonly string[]): boolean {
  return !entry.changed && (picked.length > 0 || !entry.needsPick)
}

/** 旧恢复候选表不是生成运行，没有可放弃的运行。 */
export function abandonHandle(entry: RecoveryEntry): MainGenerationRunHandle | undefined {
  switch (entry.kind) {
    case 'planning': return entry.canDismiss ? entry.recovery.handle : undefined
    case 'editor': return entry.recovery.view.handle
    case 'review': case 'draft': return entry.view.handle
    case 'batch': return entry.handle
    case 'candidate': return undefined
  }
}

/** 列出顺序与旧 AI 输出一致：恢复稿、选区建议、审修、批量、单章，最后是旧的恢复候选表。 */
export function buildRecoveryEntries(sources: RecoverySources, locale: Locale): RecoveryEntry[] {
  return [
    ...groupPlanning(sources.planning, locale),
    ...sources.editors.map(recovery => editorEntry(recovery, locale)),
    ...sources.reviews.map(item => reviewEntry(item, locale)),
    ...sources.batches.map(batch => batchEntry(batch, locale)),
    ...sources.drafts.map(item => draftEntry(item, locale)),
    ...sources.candidates.map(candidate => candidateEntry(candidate, locale)),
  ]
}
