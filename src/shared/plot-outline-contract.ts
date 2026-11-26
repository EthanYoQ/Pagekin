import type { ProjectCoreRow, ProjectCoreSynopsisExpected } from '../../electron/repositories/project-core-repository'
import type { PhysicalAttempt } from './generation-contract'
import type { VisibleCompositionReceipt } from './generation-owner-contract'
import type { MainGenerationRunHandle } from '../services/generation/generation-runtime'
import type { WritingLanguage } from './writing-language'
import type { Locale } from '../i18n/types'

export const DEFAULT_PLANNING_ACTION_CHAPTERS = 5
export const PLANNING_ACTION_CHAPTER_LIMIT = 10
export const DEFAULT_PLANNING_TARGET_UNITS = 600
export const PLANNING_TARGET_UNITS_LIMIT = 1000

export function parsePlanningTargetUnits(value: unknown): number {
  if (value === undefined) return DEFAULT_PLANNING_TARGET_UNITS
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > PLANNING_TARGET_UNITS_LIMIT)
    throw new Error('GENERATION_PLANNING_TARGET_INVALID')
  return value
}

export function assertPlanningActionRange(range: PlotOutlineRange): void {
  if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from < 1 || range.to < range.from
    || range.to - range.from + 1 > PLANNING_ACTION_CHAPTER_LIMIT) throw new Error('GENERATION_PLANNING_RANGE_INVALID')
}

export function planningTargetInstruction(kind: 'outline' | 'blueprint', targetUnits: number, language: WritingLanguage): string {
  const english = language === 'en-US'
  const field = kind === 'outline' ? english ? 'outline body' : '大纲正文' : english ? 'keyEvents narrative' : 'keyEvents 叙述'
  return english
    ? `Aim for about ${targetUnits} words per chapter in the ${field}. This is a soft target, excluding JSON, field names, identities and relationship metadata. Complete content above or below the target is accepted; do not truncate content to meet it. Keep supporting fields concise.`
    : `每章${field}目标约 ${targetUnits} 字。此值是软目标，不包括 JSON、字段名、身份及关系元数据。完整内容可以高于或低于目标，不得为凑字数截断内容。辅助字段可简写。`
}

export const PLOT_OUTLINE_PROTOCOL = 'chapter-outline-v3'
export const PLOT_OUTLINE_CONTENT = Object.freeze({ maxAttemptsPerChapter: 2 } as const)
export type PlotOutlineRange = Readonly<{ from: number; to: number }>
export type PlotOutlineAttemptKind = 'normal' | 'compact'
export interface PlotOutlineAuthorEdit {
  sourceHandle: MainGenerationRunHandle
  leaseEpoch: string
  operationId: string
  committedRange: PlotOutlineRange
}
export interface PlotOutlineAuthorEditReceipt {
  kind: 'author-edit'
  operationId: string
  sourceHandle: MainGenerationRunHandle
  requestedRange: PlotOutlineRange
  committedRange: PlotOutlineRange
  remainingRange: PlotOutlineRange | null
  synopsisHash: string
  payloadHash: string
  idempotent: boolean
}
export interface PlotOutlineRecovery {
  sourceHandle: MainGenerationRunHandle
  leaseEpoch: string
  draft: string
  rejectedReply: string | null
  completeChapters: number[]
  writeState: { kind: 'ready' } | { kind: 'blocked'; reason: 'in-flight' | 'source-changed' | 'author-saved' | 'source-invalid' }
  saved: PlotOutlineAuthorEditReceipt | null
  inFormalOutline: boolean
}
export interface PlotOutlineSource {
  version: 1
  core: Omit<ProjectCoreRow, 'created_at' | 'updated_at' | 'character_states'>
}
export type PlotOutlineCursor =
  | { kind: 'request'; chapterNumber: number; attempt: PlotOutlineAttemptKind }
  | { kind: 'accept'; chapterNumber: number; artifactIds: string[]; text: string }
  | { kind: 'complete' }
  | { kind: 'stopped'; chapterNumber: number; reason: 'in-flight' | 'unknown-completion' | 'attempts-exhausted' | 'source-invalid' }
export interface PlotOutlineProgress {
  protocol: typeof PLOT_OUTLINE_PROTOCOL
  range: PlotOutlineRange
  content: typeof PLOT_OUTLINE_CONTENT
  targetUnits: number
  cursor: PlotOutlineCursor
  sourceExpected: ProjectCoreSynopsisExpected
  confirmedPrefix: string | null
  composition: VisibleCompositionReceipt | null
}
export interface PlotOutlineAttempt {
  purpose: string
  status: PhysicalAttempt['status']
  finishReason: string | null
  artifact: { artifactId: string; text: string; revision: number; textHash: string } | null
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function plotOutlinePolicy(manifest: Readonly<Record<string, unknown>>): { range: PlotOutlineRange; content: typeof PLOT_OUTLINE_CONTENT } | null {
  if (manifest.operation !== 'generate-plot-outline') return null
  const policy = manifest.policy
  if (!record(policy) || !record(policy.planning)
    || policy.planning.kind !== 'architecture' || policy.planning.outlineProtocol !== PLOT_OUTLINE_PROTOCOL) return null
  const { intent, outlineContent } = policy.planning
  if (!record(intent) || !record(intent.synopsisRange) || !record(outlineContent)
    || Object.keys(outlineContent).length !== Object.keys(PLOT_OUTLINE_CONTENT).length
    || Object.entries(PLOT_OUTLINE_CONTENT).some(([key, value]) => outlineContent[key] !== value)) throw new Error('GENERATION_PLOT_OUTLINE_POLICY_INVALID')
  const { from, to } = intent.synopsisRange
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)
    || from < 1 || to < from || !record(policy.budget) || typeof policy.budget.maxPhysicalRequests !== 'number'
    || to - from + 1 > policy.budget.maxPhysicalRequests) throw new Error('GENERATION_PLOT_OUTLINE_POLICY_INVALID')
  return { range: { from, to }, content: PLOT_OUTLINE_CONTENT }
}

export function plotOutlineExpected(value: unknown): ProjectCoreSynopsisExpected {
  if (!record(value) || value.version !== 1 || !record(value.core)) throw new Error('GENERATION_PLOT_OUTLINE_SOURCE_INVALID')
  const core = value.core
  const fields = ['synopsis', 'premise', 'characters_arch', 'worldbuilding', 'genre', 'writing_language', 'plot_structure', 'narrative_pov', 'global_guidance'] as const
  for (const key of fields) if (typeof core[key] !== 'string') throw new Error('GENERATION_PLOT_OUTLINE_SOURCE_INVALID')
  if (!Number.isSafeInteger(core.total_chapters) || !Number.isSafeInteger(core.words_per_chapter)) throw new Error('GENERATION_PLOT_OUTLINE_SOURCE_INVALID')
  const source = core as PlotOutlineSource['core']
  return { synopsis: source.synopsis, premise: source.premise, charactersArch: source.characters_arch, worldbuilding: source.worldbuilding,
    genre: source.genre, totalChapters: source.total_chapters, wordsPerChapter: source.words_per_chapter,
    writingLanguage: source.writing_language === 'en-US' ? 'en-US' : 'zh-CN', plotStructure: source.plot_structure,
    narrativePov: source.narrative_pov, globalGuidance: source.global_guidance }
}

export function plotOutlinePurpose(chapterNumber: number, attempt: PlotOutlineAttemptKind): string {
  return `plot-outline:chapter:${chapterNumber}:${attempt}`
}

export function parsePlotOutlinePurpose(purpose: string): { chapterNumber: number; attempt: PlotOutlineAttemptKind } | null {
  const match = /^plot-outline:chapter:([1-9]\d*):(normal|compact)$/u.exec(purpose)
  if (!match || !Number.isSafeInteger(Number(match[1]))) return null
  return { chapterNumber: Number(match[1]), attempt: match[2] as PlotOutlineAttemptKind }
}

const DIGITS: Readonly<Record<string, number>> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const UNITS: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 }
const NUMBER = '[0-9零〇一二两三四五六七八九十百千]+'
function chapterNumber(token: string): number {
  if (/^\d+$/u.test(token)) return Number(token)
  let result = 0, digit = 0
  for (const char of token) {
    if (char in DIGITS) digit = DIGITS[char]!
    else { result += (digit || 1) * UNITS[char]!; digit = 0 }
  }
  return result + digit
}

function headings(text: string): { from: number; to: number; index: number; end: number; grouped: boolean }[] {
  const pattern = new RegExp(`^[\\t ]*(?:#{1,6}[\\t ]+|[-*+][\\t ]+)?(?:第(${NUMBER})(?:[–—-](${NUMBER}))?章|Chapters?[\\t ]+(\\d+)(?:[\\t ]*[–—-][\\t ]*(\\d+))?)(?=[\\t ]*(?:[:：.．—-]|$))[^\\r\\n]*`, 'gimu')
  return [...text.matchAll(pattern)].map(match => ({ from: chapterNumber(match[1] ?? match[3]),
    to: chapterNumber(match[2] ?? match[4] ?? match[1] ?? match[3]), index: match.index,
    end: match.index + match[0].length, grouped: !!(match[2] ?? match[4]) || /Chapters\s/iu.test(match[0]) }))
}

export function validPlotOutlineEntry(text: string, chapter: number): boolean {
  if (/```|~~~|大纲批次进度|后续概览|Outline batch progress|Later overview/iu.test(text)) return false
  if (!new RegExp(`^## (?:第${chapter}章|Chapter ${chapter})[:：][\\t ]*\\S[^\\r\\n]*\\r?\\n`, 'iu').test(text.trim())) return false
  const entries = headings(text)
  const heading = entries[0]
  if (entries.length !== 1 || !heading || heading.grouped || heading.from !== chapter || heading.to !== chapter
    || text.slice(0, heading.index).trim() || !text.slice(heading.end).trim()) return false
  const body = text.slice(heading.end)
  return !/^[\t ]*(?:#{1,6}[\t ]+|(?:[-*+][\t ]+)?(?:第(?![^\S\r\n]*[0-9０-９零〇一二两三四五六七八九十百千]+[^\S\r\n]*次)[^\r\n]*章|Chapters?\b))/imu.test(body)
}

export function derivePlotOutlineCursor(range: PlotOutlineRange, acceptedCount: number, attempts: readonly PlotOutlineAttempt[]): PlotOutlineCursor {
  const chapter = range.from + acceptedCount
  if (chapter > range.to) return { kind: 'complete' }
  for (const kind of ['normal', 'compact'] as const) {
    const matching = attempts.filter(attempt => attempt.purpose === plotOutlinePurpose(chapter, kind) && attempt.status !== 'cancelled-before-dispatch')
    if (!matching.length) return { kind: 'request', chapterNumber: chapter, attempt: kind }
    if (matching.length !== 1) throw new Error('GENERATION_PLOT_OUTLINE_ATTEMPT_CONFLICT')
    const attempt = matching[0]!
    if (attempt.status === 'reserved' || attempt.status === 'dispatch-marked') return { kind: 'stopped', chapterNumber: chapter, reason: 'in-flight' }
    if (attempt.finishReason !== 'stop' && attempt.finishReason !== 'length') return { kind: 'stopped', chapterNumber: chapter, reason: 'unknown-completion' }
    if (attempt.finishReason === 'stop' && attempt.artifact && validPlotOutlineEntry(attempt.artifact.text, chapter))
      return { kind: 'accept', chapterNumber: chapter, artifactIds: [attempt.artifact.artifactId], text: attempt.artifact.text }
  }
  return { kind: 'stopped', chapterNumber: chapter, reason: 'attempts-exhausted' }
}

export function joinPlotOutlineEntries(prefix: string, next: string): string {
  return [prefix.trim(), next.trim()].filter(Boolean).join('\n\n')
}

const COVERAGE_NOTE: Record<WritingLanguage, (coveredTo: string, totalChapters: string) => string> = {
  'zh-CN': (coveredTo, totalChapters) => `> 本大纲已覆盖至第 ${coveredTo} 章（全书 ${totalChapters} 章），其余章节将在后续批次继续生成。`,
  'en-US': (coveredTo, totalChapters) => `> This outline covers chapters 1-${coveredTo} of ${totalChapters}; the remaining chapters will be generated in later batches.`,
}

export function plotOutlineCoverageNote(coveredTo: number, totalChapters: number, writingLanguage: WritingLanguage): string {
  return COVERAGE_NOTE[writingLanguage](String(coveredTo), String(totalChapters))
}

const NUMBER_SLOT = '\u0000'
const COVERAGE_NOTE_LINE = new RegExp(`^(?:${Object.values(COVERAGE_NOTE)
  .map(note => note(NUMBER_SLOT, NUMBER_SLOT).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replaceAll(NUMBER_SLOT, '\\d+'))
  .join('|')})$`, 'u')

export function isPlotOutlineCoverageNote(line: string): boolean {
  return COVERAGE_NOTE_LINE.test(line)
}

export function renderPlotOutlineSynopsis(body: string, coveredTo: number, expected: Pick<ProjectCoreSynopsisExpected, 'totalChapters' | 'writingLanguage'>): string {
  const english = expected.writingLanguage === 'en-US'
  const tail = coveredTo < expected.totalChapters ? plotOutlineCoverageNote(coveredTo, expected.totalChapters, expected.writingLanguage) : ''
  return `# ${english ? 'Plot Outline' : '情节大纲'}\n\n${joinPlotOutlineEntries(body, tail)}`.trim()
}

export type PlotOutlineRangeSource = Pick<ProjectCoreSynopsisExpected, 'synopsis' | 'totalChapters' | 'writingLanguage'>

export type PlotOutlineOrderIssue = { kind: 'duplicate'; chapter: number } | { kind: 'unordered' }

function chapterOrderIssue(entries: ReturnType<typeof headings>): PlotOutlineOrderIssue | null {
  let reach = -1
  for (const entry of [...entries].sort((left, right) => left.from - right.from)) {
    if (entry.from <= reach) return { kind: 'duplicate', chapter: entry.from }
    reach = Math.max(reach, entry.to)
  }
  return entries.every((entry, index) => index === 0 || entry.from > entries[index - 1].to) ? null : { kind: 'unordered' }
}

export function plotOutlineOrderIssue(synopsis: string): PlotOutlineOrderIssue | null {
  return chapterOrderIssue(headings(synopsis))
}

export function plotOutlineSourceInvalidText(synopsis: string, locale: Locale): string {
  const t = (zh: string, en: string) => locale === 'en-US' ? en : zh
  const issue = plotOutlineOrderIssue(synopsis)
  if (!issue) return t('这次生成开跑时，大纲的章节编号与所选范围对不上或缺少章节，不能接着生成，恢复稿也不能保存。可以复制已生成的章节，改好大纲后重新生成。',
    'When this run started, the outline chapter numbers did not line up with the selected range or a chapter was missing, so it cannot continue and the recovery draft cannot be saved. Copy the generated chapters, fix the outline, then generate again.')
  if (issue.kind === 'duplicate') return t(`这次生成开跑时，大纲里第 ${issue.chapter} 章出现了不止一次，不能接着生成，恢复稿也不能保存。可以复制已生成的章节，改好大纲后重新生成。`,
    `When this run started, chapter ${issue.chapter} appeared more than once in the outline, so it cannot continue and the recovery draft cannot be saved. Copy the generated chapters, fix the outline, then generate again.`)
  return t('这次生成开跑时，大纲的章节没有按章号顺序排列，不能接着生成，恢复稿也不能保存。可以复制已生成的章节，把大纲排好后重新生成。',
    'When this run started, the outline chapters were not in chapter order, so it cannot continue and the recovery draft cannot be saved. Copy the generated chapters, put the outline in order, then generate again.')
}

export function plotOutlineConfirmedPrefix(expected: PlotOutlineRangeSource, range: PlotOutlineRange): string {
  const entries = headings(expected.synopsis)
  if (chapterOrderIssue(entries)) throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
  if (entries.some(entry => entry.from < range.from && entry.to >= range.from || entry.from <= range.to && entry.to > range.to))
    throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
  if (range.from === 1) return ''
  const before = entries.filter(entry => entry.to < range.from)
  let next = before[0]?.from === 0 ? 0 : 1
  for (const entry of before) {
    if (entry.from !== next || entry.to < entry.from) throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
    next = entry.to + 1
  }
  if (next !== range.from || !before.length) throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
  const following = entries.find(entry => entry.from >= range.from)
  if (following) return expected.synopsis.slice(before[0].index, following.index).trim()
  const title = `# ${expected.writingLanguage === 'en-US' ? 'Plot Outline' : '情节大纲'}\n\n`
  const suffix = renderPlotOutlineSynopsis('', range.from - 1, expected).slice(title.length)
  if (!expected.synopsis.startsWith(title) || !suffix || !expected.synopsis.endsWith(suffix)) throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
  const prefix = expected.synopsis.slice(title.length, -suffix.length).trim()
  if (!prefix || renderPlotOutlineSynopsis(prefix, range.from - 1, expected) !== expected.synopsis) throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
  return prefix
}

export type PlotOutlineRangeEffect =
  | { kind: 'invalid'; lastChapter: number; hasEntries: boolean; orderIssue: PlotOutlineOrderIssue | null }
  | { kind: 'new' }
  | { kind: 'continue'; after: number }
  | { kind: 'overwrite'; whole: boolean; from: number; to: number; lastChapter: number; prologue: boolean }

export function plotOutlineRangeEffect(source: PlotOutlineRangeSource, range: PlotOutlineRange): PlotOutlineRangeEffect {
  const entries = headings(source.synopsis)
  const lastChapter = lastEntryChapter(entries)
  try { plotOutlineConfirmedPrefix(source, range) } catch { return { kind: 'invalid', lastChapter, hasEntries: entries.length > 0, orderIssue: chapterOrderIssue(entries) } }
  if (!source.synopsis.trim()) return { kind: 'new' }
  if (!entries.length) return { kind: 'overwrite', whole: true, from: range.from, to: range.to, lastChapter, prologue: false }
  const prologue = entries[0].from === 0
  const replaced = entries.filter(entry => entry.from >= range.from && entry.from <= range.to)
  if (!replaced.length) return range.from > 1 || prologue ? { kind: 'continue', after: range.from - 1 } : { kind: 'new' }
  return { kind: 'overwrite', whole: false, from: replaced[0].from, to: replaced[replaced.length - 1].to, lastChapter, prologue }
}

export function plotOutlineLastChapter(synopsis: string): number | null {
  const entries = headings(synopsis)
  return entries.length ? lastEntryChapter(entries) : null
}

function lastEntryChapter(entries: ReturnType<typeof headings>): number {
  return entries.reduce((last, entry) => Math.max(last, entry.to), 0)
}

export function plotOutlineNextChapter(source: PlotOutlineRangeSource): number {
  const next = lastEntryChapter(headings(source.synopsis)) + 1
  return next > 1 && next <= source.totalChapters && plotOutlineRangeEffect(source, { from: next, to: next }).kind === 'continue' ? next : 1
}

function stripStaleCoverageNotes(text: string): string {
  let rest = text
  for (let cut = rest.lastIndexOf('\n'); cut >= 0 && isPlotOutlineCoverageNote(rest.slice(cut + 1)); cut = rest.lastIndexOf('\n')) {
    rest = rest.slice(0, cut).trimEnd()
  }
  return rest
}

export function withPlotOutlineCoverageNote(synopsis: string, to: number, expected: Pick<ProjectCoreSynopsisExpected, 'totalChapters' | 'writingLanguage'>): string {
  const title = renderPlotOutlineSynopsis('', expected.totalChapters, expected)
  return stripStaleCoverageNotes(synopsis.trimEnd()) + renderPlotOutlineSynopsis('', to, expected).slice(title.length)
}

function stripStandardTitle(text: string, title: string): string {
  const firstEntry = headings(text)[0]?.index ?? text.length
  return text.slice(0, firstEntry).replace(new RegExp(`^${title}[\\t \\r]*(?:\\n|$)(?:[\\t \\r]*\\n)*`, 'mu'), '') + text.slice(firstEntry)
}

export function renderPlotOutlineRange(body: string, range: PlotOutlineRange, expected: PlotOutlineRangeSource): string {
  plotOutlineConfirmedPrefix(expected, range)
  const entries = headings(expected.synopsis)
  if (!entries.length) return renderPlotOutlineSynopsis(body, range.to, expected)
  const start = entries.find(entry => entry.from >= range.from)
  const after = entries.find(entry => entry.from > range.to)
  const title = `# ${expected.writingLanguage === 'en-US' ? 'Plot Outline' : '情节大纲'}\n\n`
  const suffix = renderPlotOutlineSynopsis('', range.to, expected).slice(title.length)
  if (start) {
    const before = expected.synopsis.slice(0, start.index)
    if (after) return `${before}${body.trim()}\n\n${expected.synopsis.slice(after.index)}`
    return `${before}${body.trim()}${suffix ? `\n\n${suffix}` : ''}`
  }
  if (range.from === 1) {
    const authored = stripStaleCoverageNotes(stripStandardTitle(expected.synopsis.trim(), title.trim()))
    return renderPlotOutlineSynopsis(joinPlotOutlineEntries(authored, body), range.to, expected)
  }
  return renderPlotOutlineSynopsis(joinPlotOutlineEntries(plotOutlineConfirmedPrefix(expected, range), body), range.to, expected)
}

export function validPlotOutlineAuthorPrefix(synopsis: string, progress: Pick<PlotOutlineProgress, 'range' | 'sourceExpected' | 'confirmedPrefix'>, range: PlotOutlineRange): boolean {
  if (!range || range.from !== progress.range.from || !Number.isSafeInteger(range.to) || range.to < range.from || range.to > progress.range.to) return false
  const expected = progress.sourceExpected
  try { plotOutlineConfirmedPrefix(expected, range) } catch { return false }
  const all = headings(synopsis), entries = all.filter(entry => entry.from >= range.from && entry.from <= range.to)
  if (entries.length !== range.to - range.from + 1) return false
  const after = all.find(entry => entry.from > range.to)
  const title = `# ${expected.writingLanguage === 'en-US' ? 'Plot Outline' : '情节大纲'}\n\n`
  const suffix = renderPlotOutlineSynopsis('', range.to, expected).slice(title.length)
  const end = after?.index ?? (suffix && synopsis.endsWith(suffix) ? synopsis.length - suffix.length : synopsis.length)
  const authored = synopsis.slice(entries[0].index, end).trim()
  const authoredEntries = headings(authored)
  return authoredEntries.every((entry, index) => validPlotOutlineEntry(authored.slice(entry.index, authoredEntries[index + 1]?.index).trim(), range.from + index))
    && renderPlotOutlineRange(authored, range, expected) === synopsis
}

export function plotOutlineSourceInvalid(progress: Pick<PlotOutlineProgress, 'cursor'>): boolean {
  return progress.cursor.kind === 'stopped' && progress.cursor.reason === 'source-invalid'
}

function mergedEntryCutAt(synopsis: string, chapter: number) {
  return headings(synopsis).find(entry => entry.from <= chapter && entry.to > chapter)
}

export function plotOutlineRecoveryDraft(progress: PlotOutlineProgress): string {
  if (plotOutlineSourceInvalid(progress)) return progress.composition?.text ?? ''
  const completed = progress.composition?.chapters?.length ?? 0
  const chapter = progress.range.from + completed
  let body = progress.composition?.text ?? ''
  let to = Math.min(chapter, progress.range.to)
  const heading = progress.sourceExpected.writingLanguage === 'en-US' ? `## Chapter ${chapter}:` : `## 第${chapter}章：`
  if (progress.cursor.kind === 'accept') body = joinPlotOutlineEntries(body, progress.cursor.text)
  else if (progress.cursor.kind !== 'complete') {
    if (completed) to = chapter - 1
    else body = heading
  }
  const group = mergedEntryCutAt(progress.sourceExpected.synopsis, to)
  if (group) {
    if (completed && (progress.cursor.kind === 'stopped' || progress.cursor.kind === 'request')) body = joinPlotOutlineEntries(body, heading)
    to = Math.min(group.to, progress.range.to)
  }
  return renderPlotOutlineRange(body, { from: progress.range.from, to }, progress.sourceExpected)
}

function plotOutlinePrologue(synopsis: string): string {
  const [first, second] = headings(synopsis)
  if (first?.from !== 0 || first.to !== 0) return ''
  return stripStaleCoverageNotes(synopsis.slice(first.index, second?.index).trim())
}

export function plotOutlineRequestContract(progress: PlotOutlineProgress, chapter: number, attempt: PlotOutlineAttemptKind): string {
  if (progress.confirmedPrefix === null) throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
  const accepted = progress.range.from === 1 ? plotOutlinePrologue(progress.sourceExpected.synopsis) : progress.confirmedPrefix
  const prefix = joinPlotOutlineEntries(accepted, progress.composition?.text ?? '')
  const english = progress.sourceExpected.writingLanguage === 'en-US'
  return english
    ? `[Accepted outline prefix]\n${prefix}\n[/Accepted outline prefix]\n\n`
      + `Write only Chapter ${chapter}, inside the selected range ${progress.range.from}-${progress.range.to}. Use exactly one level-two Markdown heading "## Chapter ${chapter}: Title" with Arabic chapter digits, followed by a non-empty body. No chapter groups, list headings, other chapters, preface, progress line or later overview. ${planningTargetInstruction('outline', progress.targetUnits, progress.sourceExpected.writingLanguage)} Preserve all author facts, required events and ending requirements. Do not rewrite the accepted prefix.`
      + (attempt === 'compact' ? '\nRebuild this chapter once from the original frozen facts and accepted prefix. The failed candidate is not a source. Produce a complete concise replacement, not a continuation or a cut-off excerpt.' : '')
    : `【已接受大纲前缀】\n${prefix}\n【已接受大纲前缀结束】\n\n`
      + `本次只写第 ${chapter} 章，所选范围为第 ${progress.range.from}–${progress.range.to} 章。只用一个二级 Markdown 章标题“## 第${chapter}章：标题”，章号使用阿拉伯数字，标题下一行写非空正文。不得输出章组、列表标题、其他章、开场说明、进度行或后续概览。${planningTargetInstruction('outline', progress.targetUnits, progress.sourceExpected.writingLanguage)}保留作者硬事实、明确事件和尾部要求，不改写已接受前缀。`
      + (attempt === 'compact' ? '\n本次从原始冻结事实和已接受前缀重新构建此章。失败候选不是来源。输出一份完整简洁的替代大纲，不得续接失败候选或截取其片段。' : '')
}
