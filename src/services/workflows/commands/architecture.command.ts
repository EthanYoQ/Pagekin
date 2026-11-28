import { parsePlanningTargetUnits, planningTargetInstruction, DEFAULT_PLANNING_ACTION_CHAPTERS } from '../../../shared/plot-outline-contract'
import { adoptedRelationships, type CharacterProposalChoices } from '../../character-proposal-choices'
import { decodeCharacterIdentityManifest, decodeCharacterDetails, validateCharacterDetail, type CharacterIdentitySlot, type CharacterDetailOutput } from '../../../shared/character-proposal-parser'
import type { CharacterProposalBatch } from '../../../shared/character-proposal'
import { defaultCharacterProposalSelections, formatCharacterProposalPreview } from '../character-proposal-preview'
import type { MainGenerationRunHandle } from '../../generation/generation-runtime'
import type { ArchitecturePlanningIntent, GenerationRecoveryContext } from '../../../shared/generation-owner-contract'
import { PLOT_OUTLINE_PROTOCOL, plotOutlinePurpose, plotOutlineRequestContract, plotOutlineSourceInvalidText, joinPlotOutlineEntries, renderPlotOutlineRange, type PlotOutlineProgress } from '../../../shared/plot-outline-contract'
import { CANONICAL_PROJECT_DIRECTORY } from '../../../shared/project-format'
import { assertCheckpointDbMirrorCurrent, MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS, renderSynopsisDbText, synopsisFactsFingerprint, type SynopsisCheckpoint } from '../../../shared/plot-outline-checkpoint'
import {
  BaseWorkflowCommand,
  injectWritingSkillIntoSession,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import {
  composePromptSystemRole,
  renderPromptTaskGuidance,
  resolvePromptTemplate,
} from '../../prompt-templates'
import { ArchitecturePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { type ActionName, requireIpcSuccess } from '../../ipc-result'
import { specificWriteFailure } from '../../specific-write-failure'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import {
  requireWorkflowProjectSession,
  workflowUiLocale,
  workflowUiText,
  workflowWritingLanguage,
  workflowMainProcessError,
} from '../workflow-project-session'
import { characterArchitecturePrompts, promptLanguageText } from '../../prompt-language'
import { stripThinkingTags } from '../workflow-utils'
import { composeVisibleContinuation } from '../../../shared/visible-continuation'
import { hashAuthorText } from '../../../shared/source-ref'
import type { WorkflowContext, StepCallbacks } from '../../../stores/workflow-store'
import type { GenerationAttemptReceipt } from '../../generation/generation-harness'
import type { NovelConfig, ProjectSessionContext } from '../../../shared/ipc-channels'
import type { ProjectCoreSynopsisExpected } from '../../../../electron/repositories/project-core-repository'
import type { WritingLanguage } from '../../../shared/writing-language'
import { createStructuredBatchExecutor, type StructuredBatchContract } from '../structured-batch-executor'
import { localizeNovelConfigFacts } from '../../../shared/novel-config-localization'
import {
  GENERATED_GLOBAL_GUIDANCE_MAX_CHARS,
  GENERATED_GLOBAL_GUIDANCE_MAX_RULES,
  GENERATED_GLOBAL_GUIDANCE_MIN_RULES,
  isGeneratedGlobalGuidanceValid,
  mergeExpandedNovelConfig,
} from '../novel-config-expansion'
import { authorError, catalogNote, errorCodeOf, failureText, reasonOf, writtenNote } from '../../../i18n/app-errors'
import { AuthorError, authorOwned, failureCode, note, type AuthorNote, type Failure, type FailureCode } from '../../../shared/failure'
import type { ErrorDisplayLocale } from '../../../i18n/types'
import { pluralEn } from '../../../shared/plural-en'
import { recordAiSources, type AiSources } from '../../../shared/novel-config-ai-sources'
import { WorkflowCancelledError } from '../workflow-cancellation'

// --- 基础工具库 ---

function stepAuthorInputs(context: WorkflowContext, key: 'premise' | 'characters' | 'worldbuilding' | 'synopsis',
  snapshot: ArchitectureProjectSnapshot, synopsisRange?: PlotOutlineChapterRange | null, resuming = false): { id: string; text: string }[] {
  const value = (context.data.stepGuidance as Record<string, unknown> | undefined)?.[key]
  const intent: ArchitecturePlanningIntent | undefined = snapshot.planningIntent ?? (resuming || context.mainGenerationRootHandle ? undefined : {
    version: 'architecture-action-v1', priorSteps: key === 'synopsis' ? [] : [key],
    synopsisRange: key === 'synopsis' ? synopsisRange ?? { from: 1, to: Math.min(snapshot.novelConfig.totalChapters, DEFAULT_PLANNING_ACTION_CHAPTERS) } : null,
  })
  return [{ id: 'planning:target-units', text: String(parsePlanningTargetUnits(snapshot.targetUnits)) }, { id: 'architecture:author-config', text: JSON.stringify(snapshot.novelConfig) },
    ...(intent ? [{ id: 'architecture:planning-intent', text: JSON.stringify(intent) }] : []),
    ...(typeof value === 'string' ? [{ id: `architecture:step-guidance:${key}`, text: value }] : [])]
}

interface PartialArchData extends SynopsisCheckpoint {
  world_building_generation_handle?: MainGenerationRunHandle
  premise_result?: string
  character_dynamics_result?: string
  character_state_result?: string
  world_building_result?: string
  /** 世界观输出达到长度上限时保存的未完成候选；不写入正式 worldbuilding。 */
  world_building_partial_result?: string
  world_building_incomplete?: boolean
  /** 候选赖以生成的输入指纹；项目事实变化后禁止自动续写。 */
  world_building_facts_fingerprint?: string
  /** 候选创建时正式世界观的指纹；避免恢复时覆盖后来编辑的完整成果。 */
  world_building_db_hash?: string
  /** 候选实际使用的作者步骤指导；恢复时沿用，不读取新输入。 */
  world_building_step_guidance?: string
  /** 大纲赖以生成的源事实指纹；源事实变化后禁止续写旧检查点。 */
  synopsis_facts_fingerprint?: string
  /** 本批实际使用的作者步骤指导；恢复必须沿用，不读取新输入。 */
  synopsis_step_guidance?: string
}

const SYNOPSIS_CHECKPOINT_FIELDS = [
  'synopsis_protocol',
  'synopsis_result',
  'synopsis_incomplete',
  'synopsis_covered_to',
  'synopsis_range',
  'synopsis_facts_fingerprint',
  'synopsis_db_hash',
  'synopsis_body_hash',
  'synopsis_step_guidance',
] as const satisfies readonly (keyof PartialArchData)[]

function sameSynopsisCheckpoint(
  left: PartialArchData,
  right: PartialArchData,
): boolean {
  return SYNOPSIS_CHECKPOINT_FIELDS.every(field => (
    JSON.stringify(left[field]) === JSON.stringify(right[field])
  ))
}

function restoreSynopsisCheckpoint(
  current: PartialArchData,
  previous: PartialArchData,
): PartialArchData {
  const restored = { ...current }
  for (const field of SYNOPSIS_CHECKPOINT_FIELDS) {
    Object.assign(restored, { [field]: previous[field] })
  }
  return restored
}

/** 大纲章节范围。 */
export interface PlotOutlineChapterRange {
  from: number
  to: number
}

/**
 * 情节大纲生成被输出长度等原因中断、且已完成部分已自动保存时抛出的错误。
 * 运行侧页凭 recovery 给出「继续生成情节大纲」；码是中断的原因。
 */
export class PlotOutlineResumeAvailableError extends AuthorError {
  constructor(locale: ErrorDisplayLocale, interrupted: Failure) {
    const failure: Failure = { ...interrupted, recovery: 'resume-plot-outline' }
    super(failure, failureText(locale, failure))
    this.name = 'PlotOutlineResumeAvailableError'
  }
}

const PLOT_OUTLINE_SOURCE_CHANGED_CODES: ReadonlySet<string> = new Set(['GENERATION_SOURCE_CHANGED', 'GENERATION_SOURCE_CHANGED_MODEL'])

/**
 * 情节大纲生成途中，冻结的来源（模型设置、作品设定、提示词模板、写作 Skill）被改动，主进程拒绝了下一章或正式保存。
 * 同一运行无法恢复，运行侧页凭 recovery 给出「去架构页重新生成」入口；码仍是主进程给的原因。
 */
export class PlotOutlineSourceChangedError extends AuthorError {
  constructor(locale: ErrorDisplayLocale, code: FailureCode, summary: AuthorNote, options: { cause: unknown }) {
    const failure: Failure = { code, note: summary, recovery: 'restart-plot-outline' }
    super(failure, failureText(locale, failure), options)
    this.name = 'PlotOutlineSourceChangedError'
  }
}

/** 原因能显示出来才用末尾带「原因」标签的那句，免得标签后面空着。 */
function explained(locale: ErrorDisplayLocale, labelled: AuthorNote, plain: AuthorNote, because: Failure | undefined): Failure {
  if (!because) return { note: plain }
  const shown = failureText(locale, { note: labelled, because }) !== failureText(locale, { note: labelled })
  return { note: shown ? labelled : plain, because }
}

export class WorldBuildingResumeAvailableError extends AuthorError {
  constructor(locale: ErrorDisplayLocale, failure: Failure) {
    super(failure, failureText(locale, failure))
    this.name = 'WorldBuildingResumeAvailableError'
  }
}

/** 返回可供查看、复制或续写的世界观候选；候选不是正式世界观。 */
export function recoverableWorldBuildingCandidate(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const partial = value as PartialArchData
  if (partial.world_building_incomplete !== true) return ''
  return typeof partial.world_building_partial_result === 'string'
    ? partial.world_building_partial_result.trim()
    : ''
}


/**
 * 批次进度行的双语模板，仅辅助定位本批范围。完整覆盖本批后可附上该行；
 * 缺少进度行不代表截断，附带时范围必须准确，完成判断仍以正文覆盖为准。
 */
function plotOutlineProgressLine(
  writingLanguage: WritingLanguage,
  from: number,
  to: number,
  totalChapters: number,
): string {
  return promptLanguageText(
    writingLanguage,
    `大纲批次进度：已覆盖第${from}–${to}章，全书共${totalChapters}章`,
    `[Outline batch progress: covered chapters ${from}-${to} of ${totalChapters}]`,
  )
}

interface PlotOutlineProgressMark {
  from: number
  to: number
  totalChapters: number
}

const ZH_PROGRESS_MARK_RE = /大纲批次进度：已覆盖第(\d+)[–—-](\d+)章，全书共(\d+)章/gu
const EN_PROGRESS_MARK_RE = /\[Outline batch progress: covered chapters (\d+)[\s-]+(\d+) of (\d+)\]/gu

function findPlotOutlineProgressMark(text: string): PlotOutlineProgressMark | null {
  for (const match of text.matchAll(ZH_PROGRESS_MARK_RE)) {
    const from = Number(match[1])
    const to = Number(match[2])
    const totalChapters = Number(match[3])
    if (Number.isSafeInteger(from) && Number.isSafeInteger(to) && Number.isSafeInteger(totalChapters)) {
      return { from, to, totalChapters }
    }
  }
  for (const match of text.matchAll(EN_PROGRESS_MARK_RE)) {
    const from = Number(match[1])
    const to = Number(match[2])
    const totalChapters = Number(match[3])
    if (Number.isSafeInteger(from) && Number.isSafeInteger(to) && Number.isSafeInteger(totalChapters)) {
      return { from, to, totalChapters }
    }
  }
  return null
}

/** 从已确认正文中移除批次进度行（成功批次落盘前剔除）。 */
function stripPlotOutlineProgressLine(text: string): string {
  return text
    .replace(ZH_PROGRESS_MARK_RE, '')
    .replace(EN_PROGRESS_MARK_RE, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

interface PlotOutlineTitleRange {
  from: number
  to: number
  index: number
  headingLineEnd: number
}

/** 口径与架构页的恢复稿提示（run-recovery.ts outlineSourceChangedNote）一致。 */
function sourceChangedMidBatch(model: boolean, stoppedAt: number, from: number): AuthorNote {
  const chapters = { stoppedAt, from, lastKept: stoppedAt - 1 }
  if (stoppedAt - 1 < from) {
    return model
      ? note('生成途中模型设置被修改，这批大纲已在第 {stoppedAt} 章停止，没有再发送请求。正式大纲未被改动。请到「架构」页重新生成情节大纲，从第 {from} 章开始。',
        'The model settings were changed during generation, so this outline batch stopped at chapter {stoppedAt} without sending another request. The saved outline was not changed. Open Architecture and generate the plot outline again from chapter {from}.', chapters)
      : note('生成途中作品设定、提示词模板或写作 Skill 被修改，这批大纲已在第 {stoppedAt} 章停止，没有再发送请求。正式大纲未被改动。请到「架构」页重新生成情节大纲，从第 {from} 章开始。',
        'The book settings, a prompt template or a writing skill changed during generation, so this outline batch stopped at chapter {stoppedAt} without sending another request. The saved outline was not changed. Open Architecture and generate the plot outline again from chapter {from}.', chapters)
  }
  if (stoppedAt - 1 === from) {
    return model
      ? note('生成途中模型设置被修改，这批大纲已在第 {stoppedAt} 章停止，没有再发送请求。本批已生成的第 {from} 章保留在「大纲恢复稿」中，只能查看或复制，不能覆盖正式内容。正式大纲未被改动。请到「架构」页重新生成情节大纲，从第 {from} 章开始。',
        'The model settings were changed during generation, so this outline batch stopped at chapter {stoppedAt} without sending another request. Chapter {from}, already generated in this batch, is kept in the outline recovery draft, which can be viewed or copied but cannot replace saved content. The saved outline was not changed. Open Architecture and generate the plot outline again from chapter {from}.', chapters)
      : note('生成途中作品设定、提示词模板或写作 Skill 被修改，这批大纲已在第 {stoppedAt} 章停止，没有再发送请求。本批已生成的第 {from} 章保留在「大纲恢复稿」中，只能查看或复制，不能覆盖正式内容。正式大纲未被改动。请到「架构」页重新生成情节大纲，从第 {from} 章开始。',
        'The book settings, a prompt template or a writing skill changed during generation, so this outline batch stopped at chapter {stoppedAt} without sending another request. Chapter {from}, already generated in this batch, is kept in the outline recovery draft, which can be viewed or copied but cannot replace saved content. The saved outline was not changed. Open Architecture and generate the plot outline again from chapter {from}.', chapters)
  }
  return model
    ? note('生成途中模型设置被修改，这批大纲已在第 {stoppedAt} 章停止，没有再发送请求。本批已生成的第 {from}–{lastKept} 章保留在「大纲恢复稿」中，只能查看或复制，不能覆盖正式内容。正式大纲未被改动。请到「架构」页重新生成情节大纲，从第 {from} 章开始。',
      'The model settings were changed during generation, so this outline batch stopped at chapter {stoppedAt} without sending another request. Chapters {from}–{lastKept}, already generated in this batch, are kept in the outline recovery draft, which can be viewed or copied but cannot replace saved content. The saved outline was not changed. Open Architecture and generate the plot outline again from chapter {from}.', chapters)
    : note('生成途中作品设定、提示词模板或写作 Skill 被修改，这批大纲已在第 {stoppedAt} 章停止，没有再发送请求。本批已生成的第 {from}–{lastKept} 章保留在「大纲恢复稿」中，只能查看或复制，不能覆盖正式内容。正式大纲未被改动。请到「架构」页重新生成情节大纲，从第 {from} 章开始。',
      'The book settings, a prompt template or a writing skill changed during generation, so this outline batch stopped at chapter {stoppedAt} without sending another request. Chapters {from}–{lastKept}, already generated in this batch, are kept in the outline recovery draft, which can be viewed or copied but cannot replace saved content. The saved outline was not changed. Open Architecture and generate the plot outline again from chapter {from}.', chapters)
}

class NonRecoverablePlotOutlineError extends AuthorError {
  constructor(locale: ErrorDisplayLocale, summary: AuthorNote) {
    super({ note: summary }, failureText(locale, { note: summary }))
  }
}

const CHINESE_CHAPTER_DIGITS: Readonly<Record<string, number>> = Object.freeze({
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
})
const CHINESE_CHAPTER_UNITS: Readonly<Record<string, number>> = Object.freeze({ 十: 10, 百: 100, 千: 1000 })
const CHAPTER_NUMBER_TOKEN = '[0-9零〇一二两三四五六七八九十百千]+'
const ZH_CHAPTER_TITLE_RE = new RegExp(
  `^[\\t ]*(?:#{1,6}[\\t ]+|[-*+][\\t ]+)?第(${CHAPTER_NUMBER_TOKEN})(?:[–—-](${CHAPTER_NUMBER_TOKEN}))?章(?=[\\t ]*(?:[:：.．—-]|$))`,
  'gmu',
)
const EN_CHAPTER_TITLE_RE = /^[\t ]*(?:#{1,6}[\t ]+|[-*+][\t ]+)?Chapters?[\t ]+(\d+)(?:[\t ]*[–—-][\t ]*(\d+))?(?=[\t ]*(?:[:.：—-]|$))/gimu

function parseChapterNumberToken(token: string): number | null {
  if (/^\d+$/u.test(token)) {
    const value = Number(token)
    return Number.isSafeInteger(value) ? value : null
  }
  let result = 0
  let digit = 0
  for (const char of token) {
    if (char in CHINESE_CHAPTER_DIGITS) {
      digit = CHINESE_CHAPTER_DIGITS[char]!
      continue
    }
    const unit = CHINESE_CHAPTER_UNITS[char]
    if (!unit) return null
    result += (digit || 1) * unit
    digit = 0
  }
  return result + digit
}

function findPlotOutlineTitleRanges(text: string): PlotOutlineTitleRange[] {
  const ranges: PlotOutlineTitleRange[] = []
  for (const regex of [ZH_CHAPTER_TITLE_RE, EN_CHAPTER_TITLE_RE]) {
    regex.lastIndex = 0
    for (const match of text.matchAll(regex)) {
      const from = parseChapterNumberToken(match[1]!)
      const to = parseChapterNumberToken(match[2] ?? match[1]!)
      if (from !== null && to !== null) {
        const index = match.index ?? 0
        const lineEnd = text.indexOf('\n', index)
        ranges.push({
          from,
          to,
          index,
          headingLineEnd: lineEnd < 0 ? text.length : lineEnd,
        })
      }
    }
  }
  return ranges.sort((left, right) => left.index - right.index)
}

function assertPlotOutlineTitleCoverage(
  merged: string,
  seedText: string,
  from: number,
  to: number,
  locale: ErrorDisplayLocale,
  allowIncompleteLastEntry = false,
): void {
  const seedPriorCounts = new Map<string, number>()
  for (const range of findPlotOutlineTitleRanges(seedText)) {
    if (range.to >= from) continue
    const key = `${range.from}:${range.to}`
    seedPriorCounts.set(key, (seedPriorCounts.get(key) ?? 0) + 1)
  }
  const covered = new Set<number>()
  const invalid: string[] = []
  const entries = findPlotOutlineTitleRanges(merged)
  let nextExpectedChapter = from
  for (const [index, range] of entries.entries()) {
    const key = `${range.from}:${range.to}`
    if (range.to < from) {
      const remaining = seedPriorCounts.get(key) ?? 0
      if (remaining > 0) seedPriorCounts.set(key, remaining - 1)
      else invalid.push(`${range.from}-${range.to}`)
      continue
    }
    if (range.from < from || range.to > to || range.from > range.to) {
      invalid.push(`${range.from}-${range.to}`)
      continue
    }
    if (range.from !== nextExpectedChapter) invalid.push(`${range.from}-${range.to}`)
    nextExpectedChapter = Math.max(nextExpectedChapter, range.to + 1)
    const nextHeadingIndex = entries[index + 1]?.index ?? merged.length
    const entryBody = stripPlotOutlineProgressLine(
      merged.slice(Math.min(range.headingLineEnd + 1, merged.length), nextHeadingIndex),
    ).trim()
    if (!entryBody && !(allowIncompleteLastEntry && index === entries.length - 1)) {
      invalid.push(`${range.from}-${range.to}:empty`)
    }
    for (let chapter = range.from; chapter <= range.to; chapter += 1) {
      if (covered.has(chapter)) invalid.push(String(chapter))
      covered.add(chapter)
    }
  }
  const missing: number[] = []
  for (let chapter = from; chapter <= to; chapter += 1) {
    if (!covered.has(chapter)) missing.push(chapter)
  }
  if (invalid.length > 0 || missing.length > 0) {
    const counts = { from, to, missingCount: missing.length, invalidCount: invalid.length }
    if (invalid.length > 0) {
      throw new NonRecoverablePlotOutlineError(locale, note(
        '大纲正文未按顺序提供本批第 {from}–{to} 章的非空条目（缺失 {missingCount} 章，空白、重复、乱序或越界 {invalidCount} 处），结果未按完成保存。 完整模型输出仍保留在 AI 输出中，但这种结构错误不能自动续写；请修正范围后重新生成。',
        'The outline body does not provide non-empty entries in order for batch chapters {from}-{to} ({missingCount} missing; {invalidCount} empty, duplicate, out of order, or out of range), so the result was not saved as complete. The complete model output remains visible in AI output, but this structural error cannot be continued automatically; correct the range and regenerate.',
        counts,
      ))
    }
    throw authorError(locale, { note: note(
      '大纲正文未按顺序提供本批第 {from}–{to} 章的非空条目（缺失 {missingCount} 章，空白、重复、乱序或越界 {invalidCount} 处），结果未按完成保存。',
      'The outline body does not provide non-empty entries in order for batch chapters {from}-{to} ({missingCount} missing; {invalidCount} empty, duplicate, out of order, or out of range), so the result was not saved as complete.',
      counts,
    ) })
  }
}



function synopsisInputsFingerprint(
  expected: ProjectCoreSynopsisExpected,
  stepGuidance: string,
  range: PlotOutlineChapterRange,
  template: unknown,
): string {
  const sourceInputs = {
    premise: expected.premise,
    charactersArch: expected.charactersArch,
    worldbuilding: expected.worldbuilding,
    genre: expected.genre,
    totalChapters: expected.totalChapters,
    wordsPerChapter: expected.wordsPerChapter,
    writingLanguage: expected.writingLanguage,
    plotStructure: expected.plotStructure,
    narrativePov: expected.narrativePov,
    globalGuidance: expected.globalGuidance,
  }
  return synopsisFactsFingerprint([
    JSON.stringify(sourceInputs),
    stepGuidance,
    `${range.from}:${range.to}`,
    JSON.stringify(template),
  ])
}

/**
 * 「本批生成范围」指令：批次可任意处于第 from–to 章。当 from > 1 时模型
 * 必须从已有前缀（seed）末尾自然衔接继续写；to < total 时剩余章节只允许
 * 一行占位概览，等待后续批次补齐。
 */
function synopsisBatchInstruction(
  writingLanguage: WritingLanguage,
  from: number,
  to: number,
  totalChapters: number,
): string {
  const leading = from > 1
    ? promptLanguageText(
        writingLanguage,
        `第 1–${from - 1} 章的大纲已在【已完成大纲前缀】中给出：不得重复、改写或复述该前缀；从第 ${from} 章起自然衔接继续书写。`,
        `Chapters 1-${from - 1} are already covered in the [confirmed outline prefix]: do not repeat, rewrite, or restate it; continue naturally from chapter ${from}.`,
      )
    : ''
  const trailing = to < totalChapters
    ? promptLanguageText(
        writingLanguage,
        `第 ${to + 1}–${totalChapters} 章本次不展开细写：只写一行“后续概览：……”概览整段走向（不超过 200 字），等待后续批次继续生成。该行不得使用“第N章”或“第N–M章”标题，也不计入本批覆盖。`,
        `Chapters ${to + 1}-${totalChapters} must not be expanded in this batch: write one short “Later overview: ...” line (200 characters or fewer) for that future span. Do not title it “Chapter N” or “Chapters N-M”; it does not count toward this batch's coverage.`,
      )
    : ''
  const contract = [
    leading,
    promptLanguageText(
      writingLanguage,
      `【本次生成范围（重要）】\n本次必须对第 ${from}–${to} 章输出完整详细的情节大纲（全书共 ${totalChapters} 章）。每章或连续章组必须以独立行标题开头，严格使用“第N章：标题”或“第N–M章：标题”格式，并在标题下一行起写非空正文。`,
      `[Generation scope for this batch (important)]\nDetail complete plot outline entries for chapters ${from}-${to} of ${totalChapters}. Start every chapter or consecutive chapter group with its own heading, strictly formatted as “Chapter N: Title” or “Chapters N-M: Title”, then write a non-empty body beginning on the next line.`,
    ),
    trailing,
    promptLanguageText(
      writingLanguage,
      `【批次收尾（辅助信息）】完整覆盖第 ${from}–${to} 章后，可在最后一行附上以下进度（如附上，范围必须准确）：${plotOutlineProgressLine(writingLanguage, from, to, totalChapters)}`,
      `[Batch completion line (supporting information)] After fully covering chapters ${from}-${to}, you may append this progress line; if included, its range must be exact: ${plotOutlineProgressLine(writingLanguage, from, to, totalChapters)}`,
    ),
  ].filter(Boolean).join('\n\n')
  return contract
}

/** 正常结束后以正文覆盖为准；可选自报进度不能与本批冲突。 */
function assertPlotOutlineBatchComplete(
  merged: string,
  from: number,
  to: number,
  totalChapters: number,
  locale: ErrorDisplayLocale,
): void {
  const mark = findPlotOutlineProgressMark(merged)
  if (!mark && !merged.includes('大纲批次进度') && !merged.includes('[Outline batch progress:')) return
  if (!mark
    || mark.from !== from
    || mark.to !== to
    || mark.totalChapters !== totalChapters
  ) {
    throw authorError(locale, { note: note(
      '大纲输出包含无效的批次完成标记（需要与本批范围完全一致：第 {from}–{to} 章、全书 {totalChapters} 章），批次范围可能错位，结果未按完成保存。',
      'The outline output contains an invalid batch-completion marker (expected chapters {from}-{to} of {totalChapters}); its range may be incorrect, so it was not saved as complete.',
      { from, to, totalChapters },
    ) })
  }
}

const PLOT_STRUCTURES = new Set<NovelConfig['plotStructure']>([
  'three_act',
  'heros_journey',
  'save_the_cat',
  'kishotenketsu',
  'multi_thread',
  'freeform',
])
const NARRATIVE_POVS = new Set<NovelConfig['narrativePOV']>([
  'third_limited',
  'first_person',
  'third_omniscient',
  'multi_pov',
])
const REQUIRED_CONFIG_TEXT_FIELDS = [
  'genre',
  'targetAudience',
  'subGenre',
  'coreOutline',
  'worldSetting',
  'goldenFinger',
  'protagonistProfile',
  'globalGuidance',
  'writingStyle',
] as const

function buildNovelConfigJSONContract(
  totalChapters: number,
  wordsPerChapter: number,
  writingLanguage: WritingLanguage,
): string {
  return promptLanguageText(writingLanguage, `【不可变小说配置 JSON 合同】
- 必填且必须为非空字符串的 9 个字段：genre、targetAudience、subGenre、coreOutline、worldSetting、goldenFinger、protagonistProfile、globalGuidance、writingStyle。
- plotStructure 必填，且值必须严格为以下英文枚举之一：three_act | heros_journey | save_the_cat | kishotenketsu | multi_thread | freeform。
- narrativePOV 必填，且值必须严格为以下英文枚举之一：third_limited | first_person | third_omniscient | multi_pov。
- totalChapters 与 wordsPerChapter 是作者权威设置，可以省略；totalChapters 若输出必须严格等于 ${totalChapters}；wordsPerChapter 若输出必须严格等于 ${wordsPerChapter}。
- globalGuidance 必须是 4–8 条跨章节长期有效的简短规则，每条规则独占一行，在 JSON 字符串中用 \\n 表示换行，总计不得超过 ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} 字符；禁止逐章列大纲或分配章节区间。
- referenceWorks 可省略；若输出必须是字符串。
- 只输出一个完整 JSON 对象。枚举只允许上述英文值，不得输出中文枚举、近义词、说明文字、Markdown、代码围栏或思考过程。`, `[Immutable novel-configuration JSON contract]
- The following nine fields are required non-empty strings: genre, targetAudience, subGenre, coreOutline, worldSetting, goldenFinger, protagonistProfile, globalGuidance, writingStyle.
- plotStructure is required and must be exactly one of: three_act | heros_journey | save_the_cat | kishotenketsu | multi_thread | freeform.
- narrativePOV is required and must be exactly one of: third_limited | first_person | third_omniscient | multi_pov.
- totalChapters and wordsPerChapter are authoritative author settings and may be omitted. If present, they must equal ${totalChapters} and ${wordsPerChapter} respectively.
- globalGuidance must contain 4–8 short, stable cross-chapter rules, one rule per line, with line breaks encoded as \\n in the JSON string, within ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} characters. Do not enumerate chapters or allocate chapter ranges.
- referenceWorks may be omitted; if present, it must be a string.
- Output one complete JSON object only. Do not emit aliases, explanatory prose, Markdown, code fences, or reasoning.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function decodeCompleteNovelConfig(
  content: string,
  expectedTotalChapters: number,
  expectedWordsPerChapter: number,
  locale: ErrorDisplayLocale,
): NovelConfig {
  const invalid = (summary: AuthorNote) => authorError(locale, { note: summary })
  let value: unknown
  try {
    const trimmed = content.trim()
    const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed)
    value = JSON.parse(fenced?.[1].trim() ?? trimmed)
  } catch {
    throw invalid(note('AI 返回的小说配置不是完整 JSON 对象', 'The AI novel configuration is not a complete JSON object.'))
  }
  if (!isRecord(value)) throw invalid(note('AI 返回的小说配置必须是 JSON 对象', 'The AI novel configuration must be a JSON object.'))

  const textFields: Record<(typeof REQUIRED_CONFIG_TEXT_FIELDS)[number], string> = {} as never
  for (const field of REQUIRED_CONFIG_TEXT_FIELDS) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw invalid(note('AI 返回的小说配置缺少非空字段：{field}', 'The AI novel configuration is missing the non-empty field {field}.', { field: authorOwned(field) }))
    }
    textFields[field] = value[field].trim()
  }
  if (typeof value.plotStructure !== 'string' || !PLOT_STRUCTURES.has(value.plotStructure as NovelConfig['plotStructure'])) {
    throw invalid(note('AI 返回的小说配置包含非法 plotStructure', 'The AI novel configuration has an invalid plotStructure.'))
  }
  if (typeof value.narrativePOV !== 'string' || !NARRATIVE_POVS.has(value.narrativePOV as NovelConfig['narrativePOV'])) {
    throw invalid(note('AI 返回的小说配置包含非法 narrativePOV', 'The AI novel configuration has an invalid narrativePOV.'))
  }
  for (const [field, expected] of [
    ['totalChapters', expectedTotalChapters],
    ['wordsPerChapter', expectedWordsPerChapter],
  ] as const) {
    const candidate = value[field]
    if (candidate !== undefined && (
      typeof candidate !== 'number'
      || !Number.isSafeInteger(candidate)
      || candidate <= 0
      || candidate !== expected
    )) {
      throw invalid(note(
        'AI 返回的小说配置包含无效 {field}，不得回退或覆盖作者设置',
        'The AI novel configuration has an invalid {field}; it may not replace or override the author\'s setting.',
        { field: authorOwned(field) },
      ))
    }
  }
  if (value.referenceWorks !== undefined && typeof value.referenceWorks !== 'string') {
    throw invalid(note('AI 返回的小说配置包含无效 referenceWorks', 'The AI novel configuration has an invalid referenceWorks.'))
  }

  return {
    genre: textFields.genre,
    targetAudience: textFields.targetAudience,
    subGenre: textFields.subGenre,
    totalChapters: expectedTotalChapters,
    wordsPerChapter: expectedWordsPerChapter,
    plotStructure: value.plotStructure as NovelConfig['plotStructure'],
    narrativePOV: value.narrativePOV as NovelConfig['narrativePOV'],
    coreOutline: textFields.coreOutline,
    worldSetting: textFields.worldSetting,
    goldenFinger: textFields.goldenFinger,
    protagonistProfile: textFields.protagonistProfile,
    globalGuidance: textFields.globalGuidance,
    writingStyle: textFields.writingStyle,
    ...(typeof value.referenceWorks === 'string' ? { referenceWorks: value.referenceWorks.trim() } : {}),
  }
}

/**
 * 不可由设置页模板覆盖的结构契约。用户仍可调整角色创作指导，但角色身份
 * 不再依赖 Markdown 标题或后续第二次模型提取。
 */
const MIN_CHARACTER_SLOTS = 3
const MANIFEST_LENGTH_REPLACEMENTS = 2
const CHARACTER_DETAIL_BATCH_SIZE = 3
const MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES = 32_768
function promptUtf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength }

export interface ArchitectureProjectSnapshot {
  targetUnits?: number
  expectedProjectPath: string
  novelConfig: Readonly<NovelConfig>
  planningIntent?: ArchitecturePlanningIntent
}

function assertArchitectureProjectSessionCurrent(
  projectSession: ProjectSessionContext,
  context: CommandExecuteParams['context'],
): void {
  if (!sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )) {
    throw authorError(context.interfaceLocale, { note: note('当前项目已切换，架构生成已停止以避免写入错误项目', 'The current project changed, so architecture generation stopped to avoid writing to the wrong project.') })
  }
}

async function loadPartialData(
  projectPath: string,
  projectSession: ProjectSessionContext,
): Promise<PartialArchData> {
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:read-json',
    `${projectPath}/${CANONICAL_PROJECT_DIRECTORY}/partial_arch.json`,
    projectPath,
  )
  if (result.success && result.data) return result.data as PartialArchData
  return {}
}

export async function savePartialData(
  projectPath: string,
  data: PartialArchData,
  projectSession: ProjectSessionContext,
  unexplained: ActionName | AuthorNote,
): Promise<void> {
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:write-json',
    `${projectPath}/${CANONICAL_PROJECT_DIRECTORY}/partial_arch.json`,
    data,
    projectPath,
  )
  requireIpcSuccess(result, unexplained)
}

async function writeArchToDb(
  key: 'premise' | 'charactersArch' | 'worldbuilding' | 'synopsis',
  content: string,
  expectedProjectPath: string,
  runId: string,
  projectSession: ProjectSessionContext,
  context: CommandExecuteParams['context'],
  generationRunHandle?: MainGenerationRunHandle,
): Promise<void> {
  const cleanContent = stripThinkingTags(content)
  const result = generationRunHandle
    ? await ipc.invokeWithProjectSession(projectSession, 'db:project-core-commit-generated', { data: { [key]: cleanContent }, generationRunHandle }, expectedProjectPath)
    : await ipc.invokeWithProjectSession(projectSession, 'db:project-core-update', { [key]: cleanContent }, expectedProjectPath)
  if (!result.success) {
    throw workflowMainProcessError(context.interfaceLocale, specificWriteFailure(result), '故事架构写入数据库失败', 'Failed to write story architecture to the database.')
  }

  // 通知 UI 层实时刷新架构完成状态
  const { globalEventBus } = await import('../../../shared/event-bus')
  globalEventBus.emit('ARCH_FILE_UPDATED', {
    fileName: `${key}.md`,
    projectPath: expectedProjectPath,
    projectSession,
    runId,
  })
}

// --- 独立命令类 ---

export class GenerateConfigCommand extends BaseWorkflowCommand<string> {
  constructor(
    private idea: string,
    private totalChapters: number,
    private wordsPerChapter: number,
    private onGenerated: (config: Partial<NovelConfig>) => void,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    const { novelConfig, aiSources } = useProjectStore.getState().currentProject!
    const expectedConfig = structuredClone(novelConfig)
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params, expectedConfig, aiSources), {
      authorInputs: [{ id: 'config:author-config', text: JSON.stringify(expectedConfig) }, { id: 'config:author-idea', text: this.idea }, { id: 'config:requested-size', text: JSON.stringify({ totalChapters: this.totalChapters, wordsPerChapter: this.wordsPerChapter }) }],
      operation: 'generate-global-config', promptKeys: ['generate_global_config'], skillStages: ['planning'], output: 'structured-data',
      outputOverrides: [{ purpose: 'generate-global-guidance-replacement', output: 'visible-text' }],
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams, expectedConfig: NovelConfig, expectedSources: AiSources | undefined): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const existingConfig = expectedConfig
    callbacks.log(text(
      '正在调度配置专家 AI，准备解析您的脑洞...',
      'Preparing the configuration model to structure your story idea...',
    ))

    const template = await resolvePromptTemplate('generate_global_config', projectSession, writingLanguage)
    if (!template) throw authorError(context.interfaceLocale, { note: note('未找到 generate_global_config 模板', 'The generate_global_config template was not found.') })

    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withUserIdea(this.idea)
      .withNumberOfChapters(this.totalChapters)
      .withWordNumber(this.wordsPerChapter)
    const configJSONContract = buildNovelConfigJSONContract(
      this.totalChapters,
      this.wordsPerChapter,
      writingLanguage,
    )
    const authorConfigContext = Object.keys(existingConfig).length > 0
      ? promptLanguageText(
          writingLanguage,
          `【作者已有配置】\n以下非空内容和选择是作者权威输入：长文本只能在保留原文的基础上补充，类型、受众、结构与视角选择不得改写。\n${JSON.stringify(existingConfig, null, 2)}`,
          `[Existing author configuration]\nThe following non-empty content and choices are authoritative. Preserve long-form text and only add useful details; do not change the author's genre, audience, structure, or point-of-view choices.\n${JSON.stringify(existingConfig, null, 2)}`,
        )
      : ''
    const originalTask = [promptBuilder.build(), authorConfigContext, configJSONContract]
      .filter(Boolean)
      .join('\n\n')

    const initial = await this.callLLMResult(
      originalTask,
      promptBuilder.getSystemRole(),
      callbacks,
      {
        responseFormat: { type: 'json_object' },
        purpose: 'generate-global-config',
        reasoningStage: 'planning',
        writingSkillStage: 'planning',
      },
      context,
    )
    let resultRaw: string
    if (initial.finishReason === 'stop') {
      resultRaw = initial.content
    } else if (initial.finishReason === 'length') {
      callbacks.log(text(
        '首轮配置 JSON 达到输出上限，已丢弃不可信截断内容，正在请求一次完整替代 JSON...',
        'The first configuration JSON reached the output limit. The untrusted truncated response was discarded; requesting one complete replacement JSON...',
      ))
      const replacement = await this.callLLMResult(
        promptLanguageText(
          writingLanguage,
          `上一轮输出因长度限制而中断。上一轮截断内容是不可信数据，已被丢弃，不得引用或续接。\n\n`
            + `【原始任务合同】\n${originalTask}\n\n`
            + '【硬性要求】\n从头完成原始任务，只输出一个完整替代 JSON。不要只补后缀，不要解释、Markdown 或思考过程。',
          `The previous response stopped at the length limit. Its truncated content is untrusted and discarded; do not quote or continue it.\n\n`
            + `[Original task contract]\n${originalTask}\n\n`
            + '[Hard requirement]\nRestart the original task and output one complete replacement JSON object only. Do not emit a suffix, explanation, Markdown, or reasoning.',
        ),
        promptBuilder.getSystemRole(),
        callbacks,
        {
          responseFormat: { type: 'json_object' },
          purpose: 'generate-global-config-replacement',
          reasoningStage: 'planning',
          writingSkillStage: 'planning',
        },
        context,
      )
      if (replacement.finishReason !== 'stop') {
        throw this.createIncompleteCompletionError(context, replacement.finishReason, replacement.receipt)
      }
      resultRaw = replacement.content
    } else {
      throw this.createIncompleteCompletionError(context, initial.finishReason, initial.receipt)
    }
    this.assertNotCancelled(context)

    callbacks.log(text(
      '解析完成，正在应用到项目配置...',
      'Parsing is complete; applying the result to the project configuration...',
    ))
    let parsed: NovelConfig
    try {
      parsed = decodeCompleteNovelConfig(resultRaw, this.totalChapters, this.wordsPerChapter, context.interfaceLocale)
    } catch (e) {
      throw authorError(context.interfaceLocale, explained(context.interfaceLocale,
        note('AI 返回的小说配置不完整或无效，结果未应用。详细信息', 'The AI novel configuration was incomplete or invalid, so the result was not applied. Details:'),
        note('AI 返回的小说配置不完整或无效，结果未应用。', 'The AI novel configuration was incomplete or invalid, so the result was not applied.'),
        reasonOf(e)), { cause: e })
    }
    if (!isGeneratedGlobalGuidanceValid(parsed.globalGuidance)) {
      callbacks.log(text(
        '生成的全局写作要求不符合 4–8 条简短规则合同，正在执行唯一一次字段级完整替代。',
        'The generated global guidance did not satisfy the 4–8 short-rule contract; requesting the single field-level replacement.',
      ))
      const replacement = await this.callLLM(
        promptLanguageText(
          writingLanguage,
          `只纠正小说配置中的 globalGuidance 字段。写 ${GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–${GENERATED_GLOBAL_GUIDANCE_MAX_RULES} 条跨章节长期有效的简短规则，每条独占一行，总计不超过 ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} 字符。不得逐章列大纲、分配章节区间或复述核心大纲。只输出规则正文，不要标题、解释、Markdown 或 JSON。\n\n【已验证的其余小说配置，仅作上下文】\n${JSON.stringify({ ...parsed, globalGuidance: undefined }, null, 2)}`,
          `Correct only the globalGuidance field in the novel configuration. Write ${GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–${GENERATED_GLOBAL_GUIDANCE_MAX_RULES} short, stable cross-chapter rules, one per line, within ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} characters total. Do not enumerate chapters, allocate chapter ranges, or restate the core outline. Output only the rules, with no title, explanation, Markdown, or JSON.\n\n[Validated remaining novel configuration — context only]\n${JSON.stringify({ ...parsed, globalGuidance: undefined }, null, 2)}`,
        ),
        promptBuilder.getSystemRole(),
        callbacks,
        {
          purpose: 'generate-global-guidance-replacement',
          reasoningStage: 'planning',
          writingSkillStage: 'planning',
        },
        context,
      )
      const replacementGuidance = this.stripThinkingTags(replacement).trim()
      if (!isGeneratedGlobalGuidanceValid(replacementGuidance)) {
        throw authorError(context.interfaceLocale, { note: note('全局写作要求仍不符合 {GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–{GENERATED_GLOBAL_GUIDANCE_MAX_RULES} 条且不超过 {GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} 字符的合同，配置未应用。', 'The global guidance still does not satisfy the {GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–{GENERATED_GLOBAL_GUIDANCE_MAX_RULES}-rule, {GENERATED_GLOBAL_GUIDANCE_MAX_CHARS}-character contract, so the configuration was not applied.', { GENERATED_GLOBAL_GUIDANCE_MIN_RULES, GENERATED_GLOBAL_GUIDANCE_MAX_RULES, GENERATED_GLOBAL_GUIDANCE_MAX_CHARS }) })
      }
      parsed = { ...parsed, globalGuidance: replacementGuidance }
    }

    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) {
      throw authorError(context.interfaceLocale, { note: note('当前项目已切换，智能配置结果未应用', 'The current project changed, so the generated configuration was not applied.') })
    }
    const generatedConfig = mergeExpandedNovelConfig(existingConfig, parsed)
    const aiSources = recordAiSources(existingConfig, expectedSources, generatedConfig)
    const mainOwned = this.requireGenerationExecution().mainOwned
    if (mainOwned) {
      const handle = context.mainGenerationRunHandle
      if (!handle) throw new Error('GENERATION_COMMIT_HANDLE_REQUIRED')
      const committed = await useProjectStore.getState().commitGeneratedNovelConfig(generatedConfig, expectedConfig, projectSession, handle, undefined, aiSources)
      if (!committed) throw new Error('GENERATION_CONFIG_COMMIT_FAILED')
    }
    this.onGenerated(generatedConfig)
    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) {
      throw authorError(context.interfaceLocale, { note: note('当前项目已切换，智能配置结果未保存', 'The current project changed, so the generated configuration was not saved.') })
    }
    if (!mainOwned) useProjectStore.getState().setAiSources(aiSources, projectSession)
    const saved = mainOwned || await useProjectStore.getState().saveProject(projectSession)
    this.assertNotCancelled(context)

    if (saved) {
      callbacks.log(text(
        'AI 配置生成并保存成功，请检查各字段后点击「生成架构」',
        'The AI configuration was generated and saved. Review the fields, then select Generate architecture.',
      ))
    } else {
      callbacks.log(text(
        'AI 配置生成成功，请检查各字段后点击「立即保存」',
        'The AI configuration was generated. Review the fields, then select Save now.',
      ))
    }
    callbacks.setProgress(100)
    return text('生成的配置已成功应用！', 'The generated configuration was applied successfully.')
  }
}

export class GenerateCoreSeedCommand extends BaseWorkflowCommand<string> {
  constructor(
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params), {
      authorInputs: stepAuthorInputs(params.context, 'premise', this.snapshot),
      operation: 'generate-core-seed', promptKeys: ['premise'], skillStages: ['planning'], output: 'visible-text',
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const writingLanguage = workflowWritingLanguage(context)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot
    const modelFacts = localizeNovelConfigFacts(config, writingLanguage)
    callbacks.log(text('生成故事前提...', 'Generating story premise...'))

    const template = await resolvePromptTemplate('premise', projectSession, writingLanguage)
    if (!template) throw authorError(context.interfaceLocale, { note: note('未找到 premise 模板', 'The story-premise template was not found.') })

    const missingValue = promptLanguageText(writingLanguage, '（未填写）', '(not provided)')
    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withGenre(modelFacts.genre)
      .withSubGenre(config.subGenre || modelFacts.genre)
      .withTopic(config.coreOutline || missingValue)
      .withTargetAudience(modelFacts.targetAudience)
      .withNumberOfChapters(config.totalChapters)
      .withWordNumber(config.wordsPerChapter)
      .withCoreSetting(config.worldSetting || missingValue)
      .withGoldenFinger(config.goldenFinger || missingValue)
      .withProtagonistProfile(config.protagonistProfile || missingValue)
      .withGlobalGuidance(config.globalGuidance || missingValue)
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).premise || '')
      .withReferenceWorks(config.referenceWorks || '')

    const result = await this.callLLMWithBuilder(
      promptBuilder,
      callbacks,
      { purpose: 'generate-core-seed', reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )
    if (!result.trim()) throw authorError(context.interfaceLocale, { note: note('故事前提生成失败，AI 返回空内容', 'Story premise generation failed because the AI returned empty content.') })
    if (context.cancelled) throw new WorkflowCancelledError(text('工作流已取消', 'Workflow was cancelled.'))

    const heading = promptLanguageText(writingLanguage, '故事前提', 'Story Premise')
    const content = `# ${heading}\n\n${result}\n`
    this.assertNotCancelled(context)
    await writeArchToDb(
      'premise',
      content,
      expectedProjectPath,
      context.runId,
      projectSession,
      context,
      this.requireGenerationExecution().mainOwned ? context.mainGenerationRunHandle : undefined,
    )
    this.assertNotCancelled(context)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    partial.premise_result = result
    this.assertNotCancelled(context)
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      note('保存架构生成进度失败', 'Failed to save the architecture-generation progress.'),
    )
    context.data.partial = partial

    callbacks.log(text(
      '故事前提已生成并写入数据库',
      'Story premise generated and saved to the database.',
    ))
    return result
  }
}

export class GenerateCharactersCommand extends BaseWorkflowCommand<string> {
  private readonly artifactReferences: Array<NonNullable<GenerationAttemptReceipt['visibleArtifact']> & { purpose?: string; finishReason: string }> = []

  protected override reportGenerationPromptBudget(callbacks: StepCallbacks, receipt: GenerationAttemptReceipt): void {
    super.reportGenerationPromptBudget(callbacks, receipt)
    if (receipt.visibleArtifact) this.artifactReferences.push({ ...receipt.visibleArtifact,
      purpose: receipt.purpose, finishReason: receipt.finishReason })
  }

  constructor(
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    return this.executeWithGenerationRuntime('character-architecture', params, () => this.executeWithinGeneration(params), {
      authorInputs: stepAuthorInputs(params.context, 'characters', this.snapshot),
      operation: 'character-architecture', promptKeys: ['character_dynamics'], skillStages: ['planning'], output: 'structured-data',
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const writingLanguage = workflowWritingLanguage(context)
    const promptCopy = characterArchitecturePrompts(writingLanguage)
    const creativeTemplate = await resolvePromptTemplate('character_dynamics', projectSession, writingLanguage)
    if (!creativeTemplate) throw authorError(context.interfaceLocale, { note: note('角色规划模板丢失', 'The character-planning template is missing.') })
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot
    const modelFacts = localizeNovelConfigFacts(config, writingLanguage)

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const premise_result = core?.premise || ''

    if (!premise_result || premise_result.includes('待生成') || premise_result.length < 50) {
      throw authorError(context.interfaceLocale, { note: note('故事前提尚未生成或内容不完整，请返回勾选生成', 'The story premise is missing or incomplete. Go back and include it for generation.') })
    }

    callbacks.log(text('生成角色名单...', 'Generating the cast...'))

    const missingValue = promptLanguageText(writingLanguage, '（未填写）', '(not provided)')
    const manifestContext = {
      premise: premise_result,
      genre: modelFacts.genre,
      protagonistProfile: config.protagonistProfile || missingValue,
      goldenFinger: config.goldenFinger || missingValue,
      worldSetting: config.worldSetting || missingValue,
      coreOutline: config.coreOutline || missingValue,
      globalGuidance: config.globalGuidance || missingValue,
      stepGuidance: ((context.data.stepGuidance as Record<string, string>) || {}).characters || missingValue,
      referenceWorks: config.referenceWorks || missingValue,
    }
    const manifestContextJson = JSON.stringify(manifestContext)
    const templateVariables = {
      premise: manifestContext.premise,
      genre: manifestContext.genre,
      protagonist_profile: manifestContext.protagonistProfile,
      global_guidance: manifestContext.globalGuidance,
      step_guidance: manifestContext.stepGuidance,
      reference_works: manifestContext.referenceWorks,
      number_of_chapters: String(config.totalChapters),
      golden_finger: config.goldenFinger || missingValue,
      world_building: config.worldSetting || missingValue,
    }
    const creativeSystem = composePromptSystemRole(creativeTemplate, writingLanguage)
    const creativeGuidance = renderPromptTaskGuidance(creativeTemplate, templateVariables, writingLanguage)
    const manifestSystem = `${creativeSystem}\n\n${promptCopy.manifestSystem}`
    const manifestTask = promptCopy.manifestTask(manifestContextJson, MIN_CHARACTER_SLOTS)
    const manifestPrompt = creativeGuidance
      ? `${creativeGuidance}\n\n${manifestTask}`
      : manifestTask
    const manifestSection = (sectionName: string, key: keyof typeof manifestContext) => ({
      sectionName,
      messageIndex: 1,
      finalText: JSON.stringify({ [key]: manifestContext[key] }).slice(1, -1),
    })
    const manifestRaw = await this.callLLMWithBoundedCompletion(
      manifestPrompt,
      manifestSystem,
      callbacks,
      { mode: 'replace-structured-output', maxContinuations: MANIFEST_LENGTH_REPLACEMENTS },
      {
        responseFormat: { type: 'json_object' },
        purpose: 'character-architecture-manifest',
        reasoningStage: 'planning',
        writingSkillStage: 'planning',
        promptBudget: {
          limitUtf8Bytes: MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES,
          sections: [
            {
              sectionName: 'system-instructions',
              messageIndex: 0,
              finalText: manifestSystem,
            },
            manifestSection('story-premise', 'premise'),
            manifestSection('genre', 'genre'),
            manifestSection('protagonist-profile', 'protagonistProfile'),
            manifestSection('golden-finger', 'goldenFinger'),
            manifestSection('world-setting', 'worldSetting'),
            manifestSection('core-outline', 'coreOutline'),
            manifestSection('global-guidance', 'globalGuidance'),
            manifestSection('step-guidance', 'stepGuidance'),
            manifestSection('reference-works', 'referenceWorks'),
          ],
        },
      },
      context,
    ).catch((error: unknown) => {
      const attempts = this.artifactReferences.filter(reference => reference.purpose === 'character-architecture-manifest')
      if (attempts.length > MANIFEST_LENGTH_REPLACEMENTS && attempts.every(reference => reference.finishReason === 'length')) {
        throw authorError(context.interfaceLocale, { note: note('已有角色没有变动。人物太多，模型一次写不下：到「设置」里模型的「高级设置」调大「最大输出 Tokens」再生成，或在角色名单用「粘贴 / 导入角色卡」补上。', 'Your existing characters are unchanged. The cast is too long for one model reply: raise Max output tokens in the model’s Advanced settings and generate again, or add people with Paste or import cards on the Cast page.') })
      }
      throw error
    })
    context.data.characterManifestArtifacts = this.artifactReferences.map(reference => ({ ...reference }))
    const manifestArtifact = this.artifactReferences.at(-1)
    let manifest: CharacterIdentitySlot[]
    try {
      manifest = decodeCharacterIdentityManifest(manifestRaw)
    } catch (error) {
      const because = reasonOf(error)
      throw authorError(context.interfaceLocale, { note: note('角色身份清单无效，没有保存角色数据', 'The character identity manifest was invalid, so no character data was saved.'), ...(because ? { because } : {}) }, { cause: error })
    }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const manifestById = new Map(manifest.map(slot => [slot.slotId, slot]))
    const detailContract: StructuredBatchContract<CharacterIdentitySlot, CharacterDetailOutput> = {
      buildTask: ({ items, validatedPrefix }) => {
        this.assertNotCancelled(context)
        assertArchitectureProjectSessionCurrent(projectSession, context)
        const prefix = JSON.stringify(validatedPrefix.map(entry => ({
          slotId: entry.slotId,
          name: entry.name,
          role: entry.role,
          relationships: entry.relationships,
        })))
        const frozenManifest = JSON.stringify({ slots: manifest })
        const slotIds = items.map(slot => slot.slotId).join(', ')
        const detailTask = promptCopy.detailTask({
          context: manifestContextJson,
          manifest: frozenManifest,
          slotIds,
          validatedPrefix: prefix,
        })
        const detailPrompt = creativeGuidance
          ? `${creativeGuidance}\n\n${detailTask}`
          : detailTask
        const detailSystem = `${creativeSystem}\n\n${promptCopy.detailSystem}`
        const detailRequestBytes = promptUtf8Bytes(detailSystem) + promptUtf8Bytes(detailPrompt)
        const fixedDetailRequestBytes = detailRequestBytes - promptUtf8Bytes(prefix)
        return {
          purpose: 'character-architecture-details',
          output: 'structured-data',
          messages: [
            { role: 'system', content: detailSystem },
            {
              role: 'user',
              content: detailPrompt,
            },
          ],
          promptBudget: {
            limitUtf8Bytes: fixedDetailRequestBytes + MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES,
            sections: [
              {
                sectionName: 'system-instructions',
                messageIndex: 0,
                finalText: detailSystem,
              },
              manifestSection('story-premise', 'premise'),
              manifestSection('genre', 'genre'),
              manifestSection('protagonist-profile', 'protagonistProfile'),
              manifestSection('golden-finger', 'goldenFinger'),
              manifestSection('world-setting', 'worldSetting'),
              manifestSection('core-outline', 'coreOutline'),
              manifestSection('global-guidance', 'globalGuidance'),
              manifestSection('step-guidance', 'stepGuidance'),
              manifestSection('reference-works', 'referenceWorks'),
              {
                sectionName: 'identity-manifest',
                messageIndex: 1,
                finalText: frozenManifest,
              },
              {
                sectionName: 'batch-slot-ids',
                messageIndex: 1,
                finalText: slotIds,
              },
              {
                sectionName: 'validated-prefix',
                messageIndex: 1,
                finalText: prefix,
              },
            ],
          },
        }
      },
      inputKey: slot => slot.slotId,
      outputKey: entry => entry.slotId,
      decode: decodeCharacterDetails,
      validateItem: (entry) => {
        const basicError = validateCharacterDetail(entry)
        if (basicError) return basicError
        const slot = manifestById.get(entry.slotId)
        if (!slot || slot.name !== entry.name || slot.role !== entry.role) return '角色详情身份与冻结清单不一致'
        return undefined
      },
    }
    const generationExecution = this.requireGenerationExecution()
    const detailExecution = await createStructuredBatchExecutor({
      contract: detailContract,
      session: injectWritingSkillIntoSession(generationExecution.session, context, 'planning'),
      writingLanguage,
      onAttempt: receipt => this.reportGenerationPromptBudget(callbacks, receipt),
    }).execute({
      items: manifest,
      limits: { maxBatchItems: CHARACTER_DETAIL_BATCH_SIZE },
      signal: generationExecution.signal,
    })
    context.data.characterDetailArtifacts = detailExecution.receipt.attempts.flatMap(receipt => receipt.visibleArtifact
      ? [{ ...receipt.visibleArtifact, purpose: receipt.purpose, finishReason: receipt.finishReason }] : [])
    if (!detailExecution.ok) {
      if (detailExecution.failure.terminal) throw detailExecution.failure.terminal
      if (detailExecution.failure.reason === 'root_budget') {
        throw authorError(context.interfaceLocale, { note: note('已有角色没有变动。人物太多，这次生成的额度（请求次数与时长）用完了：到「设置」里模型的「高级设置」调大「最大输出 Tokens」再生成，或在角色名单用「粘贴 / 导入角色卡」补上。', 'Your existing characters are unchanged. The cast used up this run’s request and time budget: raise Max output tokens in the model’s Advanced settings and generate again, or add people with Paste or import cards on the Cast page.') })
      }
      const diagnostic = detailExecution.failure.diagnostic
      const attempts = detailExecution.receipt.attempts.length > 0
        ? detailExecution.receipt.attempts
            .map(attempt => `purpose=${attempt.purpose ?? 'unknown'} finishReason=${attempt.finishReason}`)
            .join('; ')
        : 'none'
      const failureReceipt = [
        `code=${detailExecution.failure.code}`,
        `reason=${detailExecution.failure.reason ?? 'unknown'}`,
        ...(diagnostic
          ? [`diagnosticCode=${diagnostic.code} diagnosticPath=${diagnostic.path} diagnosticField=${diagnostic.field}`]
          : []),
        `attempts=${attempts}`,
      ].join(' ')
      // detail 是只给诊断看的中文原文，和收据一起进运行日志。
      const { detail, failure } = detailExecution.failure
      callbacks.log(text(
        `角色详情失败收据：${detail ? `${detail}；` : ''}${failureReceipt}`,
        `Character details failure receipt: ${failureReceipt}`,
      ))
      throw authorError(context.interfaceLocale, failure)
    }
    if (detailExecution.items.length !== manifest.length) {
      throw authorError(context.interfaceLocale, { note: note('角色详情未完整覆盖冻结身份清单', 'Character details did not fully cover the frozen identity manifest.') })
    }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const handle = context.mainGenerationRunHandle
    const detailArtifacts = (detailExecution.receipt.acceptedArtifacts ?? []).map(({ artifact }) => artifact)
    if (!handle || !manifestArtifact || detailArtifacts.length === 0) throw new Error('CHARACTER_PROPOSAL_GENERATION_ARTIFACT_REQUIRED')
    const artifacts = [...new Map([manifestArtifact, ...detailArtifacts].map(artifact => [artifact.artifactId,
      { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash }])).values()]
    const batch = await ipc.invokeWithProjectSession(projectSession, 'character-proposal:stage', {
      source: { kind: 'generation', inputKind: 'architecture', handle, artifacts, manifestArtifactId: manifestArtifact.artifactId },
    })
    context.data.characterProposalBatch = batch
    callbacks.setProgress(100)
    callbacks.log(text('角色提议已保存，等待明确采用；尚未写入正式角色。', 'Character proposals saved for explicit adoption; no formal characters were written.'))
    return formatCharacterProposalPreview(batch, text)
  }
}

export class AdoptGeneratedCharactersCommand extends BaseWorkflowCommand<string> {
  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const session = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(session, context)
    this.assertNotCancelled(context)
    const shown = context.data.characterProposalBatch as CharacterProposalBatch | undefined
    if (!shown) throw new Error('CHARACTER_PROPOSAL_PREVIEW_REQUIRED')
    if (shown.status === 'cancelled') throw new Error('CHARACTER_PROPOSAL_CANCELLED')
    if (shown.status === 'approved') return formatCharacterProposalPreview(shown, (zh, en) => workflowUiText(context, zh, en))
    const choices = context.data.characterProposalChoices as CharacterProposalChoices | undefined
    if (choices && (choices.proposalBatchId !== shown.proposalBatchId || choices.revision !== shown.revision)) throw new Error('CHARACTER_PROPOSAL_CHOICES_STALE')
    const result = await ipc.invokeWithProjectSession(session, 'character-proposal:approve', {
      proposalBatchId: shown.proposalBatchId, expectedRevision: shown.revision,
      operationId: `character-adoption:${context.runId}`, selections: choices?.selections ?? defaultCharacterProposalSelections(shown),
      relationships: choices ? adoptedRelationships(shown, choices) : [],
    })
    context.data.characterProposalBatch = result.batch
    this.notifyRefresh(['characterCards'], session.projectPath, session)
    const text = (zh: string, en: string) => workflowUiText(context, zh, en)
    callbacks.log(text('角色采用决策已保存；身份未明确的提议继续保留。', 'Character decisions saved; unresolved proposals remain available.'))
    return formatCharacterProposalPreview(result.batch, text)
  }
}

export class GenerateWorldBuildingCommand extends BaseWorkflowCommand<string> {
  constructor(
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
    private readonly options: { resumeWorldBuilding?: boolean; resumeHandle?: MainGenerationRunHandle } = {},
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    if (this.options.resumeWorldBuilding && !this.options.resumeHandle) throw authorError(params.context.interfaceLocale, { note: note('旧候选没有持久运行记录，仍可查看或复制；请明确重新开始生成。', 'This legacy candidate has no persistent run record. It remains available to view or copy; explicitly restart generation.') })
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params), {
      authorInputs: stepAuthorInputs(params.context, 'worldbuilding', this.snapshot, null, this.options.resumeWorldBuilding),
      operation: 'generate-world-building', promptKeys: ['world_building'], skillStages: ['planning'], output: 'visible-text',
      ...(this.options.resumeWorldBuilding ? { resumeHandle: this.options.resumeHandle } : {}),
      onRunOpened: async handle => {
        const session = requireWorkflowProjectSession(params.context)
        const partial = (params.context.data.partial as PartialArchData) || await loadPartialData(this.snapshot.expectedProjectPath, session)
        partial.world_building_generation_handle = handle
        await savePartialData(this.snapshot.expectedProjectPath, partial, session,
          catalogNote('error.generationRunRecordSaveFailed'))
        params.context.data.partial = partial
      },
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const writingLanguage = workflowWritingLanguage(context)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot
    const modelFacts = localizeNovelConfigFacts(config, writingLanguage)

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const premise_result = core?.premise || ''

    if (!premise_result || premise_result.includes('待生成') || premise_result.length < 50) {
      throw authorError(context.interfaceLocale, { note: note('故事前提尚未生成或内容不完整，请返回勾选生成', 'The story premise is missing or incomplete. Go back and include it for generation.') })
    }

    const resumeRequested = this.options.resumeWorldBuilding === true
    callbacks.log(text(
      resumeRequested ? '正在读取世界观未完成候选...' : '生成世界观...',
      resumeRequested ? 'Reading the incomplete worldbuilding candidate...' : 'Generating worldbuilding...',
    ))
    const template = await resolvePromptTemplate('world_building', projectSession, writingLanguage)
    if (!template) throw authorError(context.interfaceLocale, { note: note('模板丢失', 'The worldbuilding template is missing.') })

    const missingValue = promptLanguageText(writingLanguage, '（未填写）', '(not provided)')
    const requestedStepGuidance = ((context.data.stepGuidance as Record<string, string>) || {}).worldbuilding || ''
    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    context.data.partial = partial
    let stepGuidance = requestedStepGuidance
    let seedText = ''
    let expectedDbHash = synopsisFactsFingerprint([core?.worldbuilding || ''])

    if (resumeRequested) {
      seedText = this.requireGenerationExecution().mainOwned
        ? (await this.readMainVisibleComposition())?.text ?? ''
        : recoverableWorldBuildingCandidate(partial)
      if (!seedText
        || partial.world_building_step_guidance === undefined
        || !partial.world_building_facts_fingerprint
        || !partial.world_building_db_hash
      ) {
        throw authorError(context.interfaceLocale, { note: note('未找到可恢复的世界观候选；正式世界观保持不变，请重新生成。', 'No recoverable worldbuilding candidate was found. The formal worldbuilding remains unchanged; regenerate instead.') })
      }
      if (this.requireGenerationExecution().mainOwned && typeof (context.data.stepGuidance as Record<string, unknown> | undefined)?.worldbuilding === 'string'
        && requestedStepGuidance !== partial.world_building_step_guidance) throw authorError(context.interfaceLocale, { note: note('作者步骤指导已变化，旧候选不能自动续写。', 'The author step guidance changed; the old candidate cannot be resumed automatically.') })
      stepGuidance = partial.world_building_step_guidance
      expectedDbHash = partial.world_building_db_hash
      if (synopsisFactsFingerprint([core?.worldbuilding || '']) !== expectedDbHash) {
        throw authorError(context.interfaceLocale, { note: note('正式世界观自候选保存后已变化，旧候选不能自动覆盖新内容；候选仍可查看或复制。', 'The formal worldbuilding changed after the candidate was saved, so the old candidate cannot overwrite it. The candidate remains available to view or copy.') })
      }
    }

    const factsFingerprint = synopsisFactsFingerprint([
      premise_result,
      JSON.stringify(core?.charactersArch || ''),
      JSON.stringify(config),
      stepGuidance,
      JSON.stringify(template),
    ])
    if (resumeRequested && partial.world_building_facts_fingerprint !== factsFingerprint) {
      throw authorError(context.interfaceLocale, { note: note('故事前提、小说配置、角色图谱或世界观模板在候选保存后变了，旧候选不能接着生成，仍可查看或复制。', 'The premise, novel configuration, character map, or worldbuilding template changed after the candidate was saved, so it cannot be continued. You can still view or copy it.') })
    }

    if (this.requireGenerationExecution().mainOwned && !resumeRequested) {
      await this.persistWorldBuildingCandidate(projectSession, expectedProjectPath, context, '', factsFingerprint, expectedDbHash, stepGuidance)
    }

    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withCoreSeed(premise_result)
      .withTopic(config.coreOutline || '')
      .withCharacterDynamics(core?.charactersArch || '')
      .withGenre(modelFacts.genre)
      .withCoreSetting(config.worldSetting || missingValue)
      .withGoldenFinger(config.goldenFinger || missingValue)
      .withProtagonistProfile(config.protagonistProfile || missingValue)
      .withGlobalGuidance(config.globalGuidance || missingValue)
      .withStepGuidance(stepGuidance)
    const taskPrompt = promptBuilder.build()
    const systemPrompt = promptBuilder.getSystemRole()
    const llmOptions = {
      purpose: 'generate-world-building',
      reasoningStage: 'planning' as const,
      writingSkillStage: 'planning' as const,
    }
    let result: string
    let persistedCandidate = seedText
    try {
      if (!seedText) {
        const initial = await this.callLLMResult(
          taskPrompt,
          systemPrompt,
          callbacks,
          llmOptions,
          context,
        )
        const candidate = initial.content.trim()
        if (candidate && ['stop', 'length'].includes(initial.finishReason) && this.requireGenerationExecution().mainOwned) {
          const handle = context.mainGenerationRunHandle
          const artifact = initial.receipt.visibleArtifact
          if (!handle || !artifact) throw new Error('GENERATION_COMPOSITION_ARTIFACT_REQUIRED')
          const candidateHash = await hashAuthorText(candidate)
          const composition = await ipc.invokeWithProjectSession(projectSession, 'generation:compose-visible', handle, [artifact.artifactId], candidateHash)
          if (composition.text !== candidate || composition.textHash !== candidateHash) throw new Error('GENERATION_COMPOSITION_RECEIPT_MISMATCH')
        }
        if (initial.finishReason === 'stop') {
          result = candidate
        } else if (initial.finishReason === 'length' && candidate) {
          persistedCandidate = candidate
          await this.persistWorldBuildingCandidate(
            projectSession,
            expectedProjectPath,
            context,
            persistedCandidate,
            factsFingerprint,
            expectedDbHash,
            stepGuidance,
          )
          result = await this.callLLMWithAppendContinuation({
            taskPrompt,
            systemPrompt,
            callbacks,
            context,
            llmOptions,
            seedText: persistedCandidate,
            maxContinuations: 1,
            taskLabel: text('世界观', 'Worldbuilding'),
            onPartialAvailable: mergedText => { persistedCandidate = mergedText.trim() },
          })
        } else {
          throw this.createIncompleteCompletionError(context, initial.finishReason, initial.receipt)
        }
      } else {
        result = await this.callLLMWithAppendContinuation({
          taskPrompt,
          systemPrompt,
          callbacks,
          context,
          llmOptions,
          seedText,
          maxContinuations: 1,
          taskLabel: text('世界观恢复', 'Worldbuilding recovery'),
          onPartialAvailable: mergedText => { persistedCandidate = mergedText.trim() },
        })
      }
    } catch (error) {
      if (context.cancelled) throw error
      if (persistedCandidate) {
        await this.persistWorldBuildingCandidate(
          projectSession,
          expectedProjectPath,
          context,
          persistedCandidate,
          factsFingerprint,
          expectedDbHash,
          stepGuidance,
        )
        throw new WorldBuildingResumeAvailableError(context.interfaceLocale, explained(context.interfaceLocale,
          note('世界观未能完整生成，已保存未完成候选且未覆盖正式世界观。可查看、复制或稍后续写。原因', 'Worldbuilding did not complete. The incomplete candidate was saved without overwriting the formal worldbuilding; you can view, copy, or resume it later. Reason:'),
          note('世界观未能完整生成，已保存未完成候选且未覆盖正式世界观。可查看、复制或稍后续写。', 'Worldbuilding did not complete. The incomplete candidate was saved without overwriting the formal worldbuilding; you can view, copy, or resume it later.'),
          reasonOf(error)))
      }
      throw error
    }

    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const latestTemplate = await resolvePromptTemplate('world_building', projectSession, writingLanguage)
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const latestCore = await ipc.invokeWithProjectSession(
      projectSession,
      'db:project-core-get',
      expectedProjectPath,
    )
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const latestProject = useProjectStore.getState().currentProject
    const latestFactsFingerprint = latestProject && latestTemplate
      ? synopsisFactsFingerprint([
          latestCore?.premise || '',
          JSON.stringify(latestCore?.charactersArch || ''),
          JSON.stringify(latestProject.novelConfig),
          stepGuidance,
          JSON.stringify(latestTemplate),
        ])
      : ''
    const formalWorldBuildingChanged = synopsisFactsFingerprint([
      latestCore?.worldbuilding || '',
    ]) !== expectedDbHash
    const sourceFactsChanged = latestFactsFingerprint !== factsFingerprint
    if (formalWorldBuildingChanged || sourceFactsChanged) {
      await this.persistWorldBuildingCandidate(
        projectSession,
        expectedProjectPath,
        context,
        result,
        factsFingerprint,
        expectedDbHash,
        stepGuidance,
      )
      throw new WorldBuildingResumeAvailableError(context.interfaceLocale, {
        note: sourceFactsChanged
          ? note('生成期间故事前提、小说配置、角色图谱或模板变了，本次结果已保留为候选，没写入正式世界观，可查看或复制。', 'The premise, novel configuration, character map, or template changed during generation. This result was kept as a candidate and not written to worldbuilding; you can view or copy it.')
          : note('世界观生成期间正式内容已被修改，本次结果已保留为候选且未覆盖作者修改；可查看或复制候选。', 'The formal worldbuilding changed while generation was running. This result was kept as a candidate and did not overwrite the author edit; you can view or copy it.'),
      })
    }
    const heading = promptLanguageText(writingLanguage, '世界观', 'Worldbuilding')
    await writeArchToDb(
      'worldbuilding',
      `# ${heading}\n\n${result}\n`,
      expectedProjectPath,
      context.runId,
      projectSession,
      context,
      this.requireGenerationExecution().mainOwned ? context.mainGenerationRunHandle : undefined,
    )
    this.assertNotCancelled(context)

    partial.world_building_result = result
    delete partial.world_building_partial_result
    delete partial.world_building_incomplete
    delete partial.world_building_facts_fingerprint
    delete partial.world_building_db_hash
    delete partial.world_building_step_guidance
    this.assertNotCancelled(context)
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      note('保存架构生成进度失败', 'Failed to save the architecture-generation progress.'),
    )
    context.data.partial = partial

    callbacks.log(text(
      '世界观已生成并写入数据库',
      'Worldbuilding generated and saved to the database.',
    ))
    return result
  }

  private async persistWorldBuildingCandidate(
    projectSession: ProjectSessionContext,
    expectedProjectPath: string,
    context: WorkflowContext,
    candidate: string,
    factsFingerprint: string,
    dbHash: string,
    stepGuidance: string,
  ): Promise<void> {
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    if (this.requireGenerationExecution().mainOwned) delete partial.world_building_partial_result
    else partial.world_building_partial_result = candidate
    partial.world_building_incomplete = true
    partial.world_building_facts_fingerprint = factsFingerprint
    partial.world_building_db_hash = dbHash
    partial.world_building_step_guidance = stepGuidance
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      note('保存世界观未完成候选失败', 'Failed to save the incomplete worldbuilding candidate.'),
    )
    context.data.partial = partial
  }
}

export class GeneratePlotArchitectureCommand extends BaseWorkflowCommand<string> {
  constructor(
    private selectedSteps: string[],
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
    private readonly options: {
      /** 从上次中断点续写当前批次（需要有效检查点：incomplete=true 且指纹匹配）。 */
      resumeSynopsis?: boolean
      resumeHandle?: MainGenerationRunHandle
        restartHandle?: MainGenerationRunHandle
      /** 本次生成范围 [from..to]；缺省 = 第 1 章到全书（显式覆盖重写）。 */
      synopsisRange?: PlotOutlineChapterRange | null
    } = {},
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    if (this.options.resumeSynopsis && !this.options.resumeHandle) throw authorError(params.context.interfaceLocale, { note: note('旧候选没有持久运行记录，仍可查看或复制；请明确重新开始生成。', 'This legacy candidate has no persistent run record. It remains available to view or copy; explicitly restart generation.') })
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params), {
      authorInputs: stepAuthorInputs(params.context, 'synopsis', this.snapshot, this.options.synopsisRange, this.options.resumeSynopsis),
      operation: 'generate-plot-outline', promptKeys: ['synopsis'], skillStages: ['planning'], output: 'visible-text',
      ...(this.options.resumeSynopsis ? { resumeHandle: this.options.resumeHandle } : {}),
        ...(this.options.restartHandle ? { restartHandle: this.options.restartHandle } : {}),
      onRunOpened: async handle => {
        const session = requireWorkflowProjectSession(params.context)
        const partial = (params.context.data.partial as PartialArchData) || await loadPartialData(this.snapshot.expectedProjectPath, session)
        partial.synopsis_generation_handle = handle
        await savePartialData(this.snapshot.expectedProjectPath, partial, session,
          catalogNote('error.generationRunRecordSaveFailed'))
        params.context.data.partial = partial
      },
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    if (this.requireGenerationExecution().mainOwned && context.mainGenerationRunHandle) {
      const recovery = await ipc.invokeWithProjectSession(requireWorkflowProjectSession(context), 'generation:read-context', { handle: context.mainGenerationRunHandle })
      if (recovery.plotOutline) return this.executeChapterOutline({ context, callbacks }, recovery, recovery.plotOutline)
    }
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const writingLanguage = workflowWritingLanguage(context)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot
    const modelFacts = localizeNovelConfigFacts(config, writingLanguage)

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const premise = core?.premise || ''
    const char_dyn = core?.charactersArch || ''
    const world_b = core?.worldbuilding || ''

    if (!premise || premise.includes('待生成')) throw authorError(context.interfaceLocale, { note: note('故事前提未生成', 'The story premise has not been generated.') })
    if (!char_dyn || char_dyn.includes('待生成')) throw authorError(context.interfaceLocale, { note: note('角色名单未生成', 'The cast has not been generated.') })
    if (!world_b || world_b.includes('待生成')) throw authorError(context.interfaceLocale, { note: note('世界观未生成', 'Worldbuilding has not been generated.') })

    const totalChapters = Number(config.totalChapters) > 0 ? Number(config.totalChapters) : 0
    if (totalChapters <= 0) throw authorError(context.interfaceLocale, { note: note('小说配置的总章数无效，无法生成情节大纲', 'The total chapter count in the novel configuration is invalid; the plot outline cannot be generated.') })

    const sourceExpected: ProjectCoreSynopsisExpected = {
      synopsis: core?.synopsis || '',
      premise,
      charactersArch: char_dyn,
      worldbuilding: world_b,
      genre: config.genre || '',
      totalChapters,
      wordsPerChapter: Number(config.wordsPerChapter) || 0,
      writingLanguage,
      plotStructure: config.plotStructure || '',
      narrativePov: config.narrativePOV || '',
      globalGuidance: config.globalGuidance || '',
    }
    const requestedStepGuidance = ((context.data.stepGuidance as Record<string, string>) || {}).synopsis || ''

    const resumeRequested = this.options.resumeSynopsis === true
    callbacks.log(text(
      resumeRequested
        ? '正在读取上次中断的情节大纲...'
        : '生成情节大纲...',
      resumeRequested
        ? 'Reading the interrupted plot outline...'
        : 'Generating plot outline...',
    ))

    const template = await resolvePromptTemplate('synopsis', projectSession, writingLanguage)
    if (!template) throw authorError(context.interfaceLocale, { note: note('模板丢失', 'The plot-outline template is missing.') })

    const { getPlotStructureGuide, getNarrativePOVLabel } = await import('../architecture-workflow')
    const guide = getPlotStructureGuide(
      config.plotStructure || 'three_act',
      totalChapters,
      writingLanguage,
    )
    const pov = getNarrativePOVLabel(config.narrativePOV || 'third_limited', writingLanguage)

    // ===== 状态机：解析本次批次模式与检查点 =====
    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    context.data.partial = partial
    const coveredTo = partial.synopsis_covered_to ?? 0
    const interrupted = partial.synopsis_incomplete === true
    const checkpointFingerprint = partial.synopsis_facts_fingerprint

    let mode: 'resume' | 'fresh' | 'batch'
    let from: number
    let to: number
    let seedText = ''
    let confirmedPrefix = ''
    let effectiveStepGuidance = requestedStepGuidance

    if (resumeRequested) {
      // ---- 断点续写：无有效检查点必须 fail-closed，绝不退化为覆盖生成 ----
      if (!interrupted) {
        throw authorError(context.interfaceLocale, { note: note('没有可续写的情节大纲。请从「AI 生成故事架构」重新生成。', 'There is no interrupted plot outline to resume. Regenerate from “Generate story architecture”.') })
      }
      if (!partial.synopsis_range) {
        throw authorError(context.interfaceLocale, { note: note('上次中断的进度不完整，无法续写。请从「AI 生成故事架构」重新生成。', 'The saved progress is incomplete and cannot be resumed. Regenerate from “Generate story architecture”.') })
      }
      from = partial.synopsis_range.from
      to = partial.synopsis_range.to
      if (partial.synopsis_step_guidance === undefined) {
        throw authorError(context.interfaceLocale, { note: note('这份旧版情节大纲缺少生成时的输入记录，不能接着生成。已有内容都已保留，请从第 1 章重新生成。', 'This older plot outline lacks its generation inputs, so it cannot be continued. Everything is kept; regenerate from chapter 1.') })
      }
      if (this.requireGenerationExecution().mainOwned && typeof (context.data.stepGuidance as Record<string, unknown> | undefined)?.synopsis === 'string'
        && requestedStepGuidance !== partial.synopsis_step_guidance) throw authorError(context.interfaceLocale, { note: note('作者步骤指导已变化，旧候选不能自动续写。', 'The author step guidance changed; the old candidate cannot be resumed automatically.') })
      effectiveStepGuidance = partial.synopsis_step_guidance
      const expectedCheckpointFingerprint = synopsisInputsFingerprint(
        sourceExpected,
        effectiveStepGuidance,
        { from, to },
        template,
      )
      if (checkpointFingerprint !== expectedCheckpointFingerprint) {
        throw authorError(context.interfaceLocale, { note: note('故事前提、角色、世界观或总章数等在中断后变了，不能接着生成。请从「AI 生成故事架构」重新生成情节大纲。', 'The premise, characters, worldbuilding, chapter count, or similar inputs changed after the interruption, so it cannot be continued. Regenerate the plot outline from “Generate story architecture”.') })
      }
      if (this.requireGenerationExecution().mainOwned) {
        if (partial.synopsis_db_hash !== synopsisFactsFingerprint([sourceExpected.synopsis])) throw authorError(context.interfaceLocale, { note: note('正式大纲已变化，不能采用旧候选。', 'The formal outline changed; the old candidate cannot be adopted.') })
        seedText = (await this.readMainVisibleComposition())?.text ?? ''
        if (from > 1) {
          const heading = `# ${promptLanguageText(writingLanguage, '情节大纲', 'Plot Outline')}\n\n`
          const completeCheckpoint = { synopsis_incomplete: false, synopsis_covered_to: from - 1 }
          const suffix = renderSynopsisDbText('', writingLanguage, totalChapters, completeCheckpoint).slice(heading.length)
          if (!sourceExpected.synopsis.startsWith(heading) || !sourceExpected.synopsis.endsWith(suffix)) {
            throw authorError(context.interfaceLocale, { note: note('正式大纲格式已变化，不能恢复续批。', 'The formal outline format changed, so this batch cannot be resumed.') })
          }
          confirmedPrefix = sourceExpected.synopsis.slice(heading.length, -suffix.length)
          if (!confirmedPrefix || renderSynopsisDbText(confirmedPrefix, writingLanguage, totalChapters, completeCheckpoint) !== sourceExpected.synopsis) {
            throw authorError(context.interfaceLocale, { note: note('正式大纲与已确认前缀不一致，不能恢复续批。', 'The formal outline does not match the confirmed prefix, so this batch cannot be resumed.') })
          }
        }
      } else {
      seedText = assertCheckpointDbMirrorCurrent(
        partial,
        sourceExpected.synopsis,
        writingLanguage,
        totalChapters,
        reason => authorError(context.interfaceLocale, { note: reason }),
      )
      }
      if (composeVisibleContinuation(confirmedPrefix, seedText).length < MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS) {
        throw authorError(context.interfaceLocale, { note: note('上次中断时保存的内容太短，无法续写。请从「AI 生成故事架构」重新生成。', 'Too little was saved before the interruption to resume. Regenerate from “Generate story architecture”.') })
      }
      mode = 'resume'
    } else {
      const requested = this.options.synopsisRange ?? null
      if (requested && (
        !Number.isSafeInteger(requested.from) || !Number.isSafeInteger(requested.to)
        || requested.from < 1 || requested.to > totalChapters || requested.from > requested.to
      )) {
        throw authorError(context.interfaceLocale, { note: note('章节范围无效：必须满足 1 ≤ from ≤ to ≤ {totalChapters}', 'Invalid chapter range: expected 1 ≤ from ≤ to ≤ {totalChapters}.', { totalChapters }) })
      }
      from = requested?.from ?? 1
      to = requested?.to ?? totalChapters
      if (from === 1) {
        // 覆盖重写（显式发起）或首次生成。若只覆盖到一半会静默丢弃
        // 第 to+1–coveredTo 章的已确认大纲 → 拒绝，要求续批或全量重写。
        if (!interrupted && coveredTo > 0 && to < coveredTo) {
          throw authorError(context.interfaceLocale, { note: note(
            '本批只生成到第 {to} 章，将丢弃已确认的第 {firstDiscarded}–{coveredTo} 章大纲。若只需补充，请从第 {continueFrom} 章发起续批；若确定重写，请生成 1–{fullTo} 章全量覆盖。',
            'This batch stops at chapter {to} and would discard the confirmed outline for chapters {firstDiscarded}-{coveredTo}. To extend, continue from chapter {continueFrom}; to rewrite, regenerate the full range 1-{fullTo}.',
            { to, firstDiscarded: to + 1, coveredTo, continueFrom: coveredTo + 1, fullTo: Math.max(coveredTo, totalChapters) },
          ) })
        }
        mode = 'fresh'
      } else {
        // 连续续批：不得跳跃、不得重写已确认前缀、源事实不得变化
        if (interrupted) {
          throw authorError(context.interfaceLocale, { note: note('当前存在未完成的批次（可断点续写）。请先完成该批次，再发起下一批生成。', 'A batch is still incomplete (it can be resumed). Finish that batch before starting the next one.') })
        }
        if (coveredTo <= 0 || from !== coveredTo + 1) {
          const chapters = { from, coveredTo, continueFrom: coveredTo + 1 }
          throw authorError(context.interfaceLocale, { note: coveredTo > 0 && from <= coveredTo
            ? note('第 {from} 章已包含在已确认大纲中。请从第 {continueFrom} 章继续，或从第 1 章显式选择覆盖重写。',
              'Chapter {from} is already inside the confirmed outline. Continue from chapter {continueFrom}, or explicitly rewrite from chapter 1.', chapters)
            : note('大纲必须连续生成：当前已覆盖至第 {coveredTo} 章，本批应从第 {continueFrom} 章开始。',
              'The outline must grow contiguously: chapters up to {coveredTo} are confirmed, so this batch must start at chapter {continueFrom}.', chapters) })
        }
        if (!partial.synopsis_range) {
          throw authorError(context.interfaceLocale, { note: note('上一批的进度不完整，无法接着生成。请从第 1 章重新生成。', 'The previous batch’s progress is incomplete, so generation cannot continue. Regenerate from chapter 1.') })
        }
        if (partial.synopsis_step_guidance === undefined) {
          throw authorError(context.interfaceLocale, { note: note('这份旧版情节大纲缺少生成时的输入记录，不能接着生成。已有内容都已保留，请从第 1 章重新生成。', 'This older plot outline lacks its generation inputs, so it cannot be continued. Everything is kept; regenerate from chapter 1.') })
        }
        const checkpointStepGuidance = partial.synopsis_step_guidance
        const expectedCheckpointFingerprint = synopsisInputsFingerprint(
          sourceExpected,
          checkpointStepGuidance,
          partial.synopsis_range,
          template,
        )
        if (checkpointFingerprint !== expectedCheckpointFingerprint) {
          throw authorError(context.interfaceLocale, { note: note('故事前提、角色、世界观或总章数等在上次生成后变了，已有大纲接不上。请在「AI 生成故事架构」里从第 1 章重新生成。', 'The premise, characters, worldbuilding, chapter count, or similar inputs changed since the last generation, so the existing outline cannot be extended. Regenerate from chapter 1 in “Generate story architecture”.') })
        }
        seedText = assertCheckpointDbMirrorCurrent(
          partial,
          sourceExpected.synopsis,
          writingLanguage,
          totalChapters,
          reason => authorError(context.interfaceLocale, { note: reason }),
        )
        if (this.requireGenerationExecution().mainOwned) confirmedPrefix = seedText
        mode = 'batch'
      }
    }

    const factsFingerprint = synopsisInputsFingerprint(
      sourceExpected,
      effectiveStepGuidance,
      { from, to },
      template,
    )
    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withCoreSeed(premise)
      .withCharacterDynamics(char_dyn)
      .withWorldBuilding(world_b)
      .withGenre(modelFacts.genre)
      .withNumberOfChapters(totalChapters)
      .withWordNumber(config.wordsPerChapter)
      .withPlotStructureGuide(guide)
      .withNarrativePov(pov)
      .withGlobalGuidance(config.globalGuidance || promptLanguageText(writingLanguage, '（未填写）', '(not provided)'))
      .withStepGuidance(effectiveStepGuidance)

    if (mode === 'resume') {
      callbacks.log(text(
        `正在续写上次中断的第 ${from}–${to} 章（全书 ${totalChapters} 章）...`,
        `Resuming the interrupted chapters ${from}-${to} of ${totalChapters}...`,
      ))
    } else if (mode === 'fresh') {
      callbacks.log(text(
        to < totalChapters
          ? `正在生成第 ${from}–${to} 章大纲（全书 ${totalChapters} 章；本批后可从第 ${to + 1} 章继续分块补齐）...`
          : `正在生成全书 ${totalChapters} 章情节大纲...`,
        to < totalChapters
          ? `Generating the outline for chapters ${from}-${to} of ${totalChapters} (later batches may continue from chapter ${to + 1})...`
          : `Generating the ${totalChapters}-chapter plot outline...`,
      ))
    } else {
      callbacks.log(text(
        `正在续接第 ${from}–${to} 章（保留已确认的第 1–${coveredTo} 章，不会覆盖）...`,
        `Continuing chapters ${from}-${to} (chapters 1-${coveredTo} are kept unchanged)...`,
      ))
    }

    const taskPrompt = [
      promptBuilder.build(),
      synopsisBatchInstruction(writingLanguage, from, to, totalChapters),
      confirmedPrefix
        ? promptLanguageText(writingLanguage, `【已完成大纲前缀】\n${confirmedPrefix}`, `[Confirmed outline prefix]\n${confirmedPrefix}`)
        : '',
    ].filter(Boolean).join('\n\n')

    const previousBatchPartial = mode === 'batch' && this.requireGenerationExecution().mainOwned ? { ...partial } : undefined
    if (this.requireGenerationExecution().mainOwned && !resumeRequested) {
      await this.persistInterruptedSynopsis(projectSession, expectedProjectPath, context, '', { from, to }, factsFingerprint, effectiveStepGuidance, sourceExpected)
    }
    const stagedBatchPartial = previousBatchPartial ? { ...partial } : undefined
    const generationSeedText = mode === 'batch' && confirmedPrefix ? '' : seedText
    const validationSeedText = mode === 'resume' && confirmedPrefix
      ? composeVisibleContinuation(confirmedPrefix, seedText)
      : seedText

    // ===== 有界生成：seed 续写 + 自动续写；任何失败先交出已合并文本 =====
    let interruptedContent = ''
    let merged = ''
    const runCompletion = async (): Promise<string> => {
      const generated = await this.callLLMWithAppendContinuation({
        taskPrompt,
        systemPrompt: promptBuilder.getSystemRole(),
        callbacks,
        context,
        llmOptions: {
          purpose: mode === 'resume'
            ? 'generate-plot-architecture-resume'
            : mode === 'batch'
              ? 'generate-plot-architecture-batch'
              : 'generate-plot-architecture',
          reasoningStage: 'planning',
          writingSkillStage: 'planning',
        },
        seedText: generationSeedText,
        maxContinuations: 3,
        onPartialAvailable: content => { interruptedContent = composeVisibleContinuation(confirmedPrefix, content) },
      })
      if (confirmedPrefix && !generated.trim()) throw authorError(context.interfaceLocale, { note: note('情节大纲生成失败，AI 返回空内容', 'Plot outline generation failed because the AI returned empty content.') })
      merged = composeVisibleContinuation(confirmedPrefix, generated)
      return merged
    }

    // 中断/机械校验失败时：落盘已完成部分并抛出可续写错误
    const persistAndRaiseResume = async (
      partialBody: string,
      cause: Error,
      allowIncompleteLastEntry = false,
    ): Promise<never> => {
      if (partialBody.length < MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS) throw cause
      try {
        assertPlotOutlineTitleCoverage(
          partialBody,
          validationSeedText,
          from,
          to,
          context.interfaceLocale,
          allowIncompleteLastEntry,
        )
      } catch (error) {
        if (error instanceof NonRecoverablePlotOutlineError) throw error
      }
      this.assertNotCancelled(context)
      assertArchitectureProjectSessionCurrent(projectSession, context)
      await this.persistInterruptedSynopsis(
        projectSession,
        expectedProjectPath,
        context,
        partialBody,
        { from, to },
        factsFingerprint,
        effectiveStepGuidance,
        sourceExpected,
      )
      callbacks.log(text(
        `已完成部分（约 ${partialBody.length} 字）已保存，可点击「继续生成情节大纲」从断点续写`,
        `The completed part (about ${partialBody.length} ${pluralEn(partialBody.length, 'character')}) was saved. Click “Continue plot outline” to resume from the break point.`,
      ))
      // 已保存的部分不少于 MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS 字，英文只用复数。
      const params = { chars: partialBody.length, from, to }
      throw new PlotOutlineResumeAvailableError(context.interfaceLocale, explained(context.interfaceLocale,
        note('情节大纲没生成完就中断了，已完成的约 {chars} 字已保存。\n点「继续生成情节大纲」接着写第 {from}–{to} 章；本批太大就先在「AI 生成架构」调小每批章数。\n中断原因', 'Plot-outline generation stopped early. The finished part (about {chars} characters) was saved.\nClick “Continue plot outline” to finish chapters {from}-{to}; if the batch is too large, first choose a smaller per-batch range in “Generate story architecture”.\nReason:', params),
        note('情节大纲没生成完就中断了，已完成的约 {chars} 字已保存。\n点「继续生成情节大纲」接着写第 {from}–{to} 章；本批太大就先在「AI 生成架构」调小每批章数。', 'Plot-outline generation stopped early. The finished part (about {chars} characters) was saved.\nClick “Continue plot outline” to finish chapters {from}-{to}; if the batch is too large, first choose a smaller per-batch range in “Generate story architecture”.', params),
        reasonOf(cause)))
    }

    try {
      merged = await runCompletion()
    } catch (error) {
      const partialText = stripThinkingTags(interruptedContent).trim()
      const seedTrimmed = stripThinkingTags(composeVisibleContinuation(confirmedPrefix, generationSeedText)).trim()
      const madeProgress = Boolean(partialText) && partialText !== seedTrimmed
      if (
        !context.cancelled
        && madeProgress
        && partialText.length >= MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS
      ) {
        try {
          await persistAndRaiseResume(partialText, error as Error, true)
        } catch (resumeError) {
          if (resumeError instanceof NonRecoverablePlotOutlineError && previousBatchPartial && stagedBatchPartial) {
            await this.rollbackSynopsisCheckpoint(expectedProjectPath, projectSession, context, previousBatchPartial, stagedBatchPartial)
          }
          throw resumeError
        }
      }
      if (previousBatchPartial && stagedBatchPartial) {
        await this.rollbackSynopsisCheckpoint(expectedProjectPath, projectSession, context, previousBatchPartial, stagedBatchPartial)
      }
      throw error
    }

    if (!merged.trim()) throw authorError(context.interfaceLocale, { note: note('情节大纲生成失败，AI 返回空内容', 'Plot outline generation failed because the AI returned empty content.') })
    if (previousBatchPartial && stagedBatchPartial
      && stripPlotOutlineProgressLine(merged).trim() === confirmedPrefix.trim()) {
      await this.rollbackSynopsisCheckpoint(expectedProjectPath, projectSession, context, previousBatchPartial, stagedBatchPartial)
      throw authorError(context.interfaceLocale, { note: note('这一批没有写出新的情节大纲，上一批的内容已保留。', 'This batch added no plot-outline content; the previous batch was kept.') })
    }

    // ===== 完成校验：正文必须完整覆盖本批；附带进度行时也必须与范围一致 =====
    let confirmedBody = ''
    try {
      assertPlotOutlineTitleCoverage(merged, validationSeedText, from, to, context.interfaceLocale)
      assertPlotOutlineBatchComplete(merged, from, to, totalChapters, context.interfaceLocale)
      confirmedBody = stripPlotOutlineProgressLine(merged)
    } catch (error) {
      if (error instanceof NonRecoverablePlotOutlineError) {
        if (previousBatchPartial && stagedBatchPartial) {
          await this.rollbackSynopsisCheckpoint(expectedProjectPath, projectSession, context, previousBatchPartial, stagedBatchPartial)
        }
        throw error
      }
      await persistAndRaiseResume(stripPlotOutlineProgressLine(merged), error as Error)
    }
    if (!confirmedBody) {
      // persistAndRaiseResume 已以中断错误终结；此处仅为类型安全的兜底。
      throw authorError(context.interfaceLocale, { note: note('情节大纲未完成且无法保存', 'The plot outline is incomplete and could not be saved.') })
    }

    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)

    // ===== 落盘：先写检查点（权威进度 + DB 镜像指纹），再镜像到 DB 正文 =====
    const previousPartial = previousBatchPartial ?? { ...partial }
    partial.synopsis_result = confirmedBody
    partial.synopsis_incomplete = false
    partial.synopsis_covered_to = to
    partial.synopsis_range = { from, to }
    partial.synopsis_facts_fingerprint = factsFingerprint
    partial.synopsis_body_hash = synopsisFactsFingerprint([confirmedBody])
    partial.synopsis_step_guidance = effectiveStepGuidance
    const dbOutlineText = renderSynopsisDbText(confirmedBody, writingLanguage, totalChapters, partial)
    partial.synopsis_db_hash = synopsisFactsFingerprint([dbOutlineText])
    context.data.partial = partial
    this.assertNotCancelled(context)
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      note('保存情节大纲本批进度失败', 'Failed to save the plot-outline batch progress.'),
    )
    if (context.cancelled) {
      await this.rollbackSynopsisCheckpoint(
        expectedProjectPath,
        projectSession,
        context,
        previousPartial,
        partial,
      )
    }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)

    await this.commitSynopsisWithCheckpointRollback(
      dbOutlineText,
      expectedProjectPath,
      context.runId,
      projectSession,
      context,
      sourceExpected,
      previousPartial,
      partial,
      text('故事架构写入数据库失败', 'Failed to write story architecture to the database.'),
    )
    this.assertNotCancelled(context)

    // 全书完成的「全流程」运行（前提+角色+世界观+大纲一次做完）才清理检查点文件；
    // 分块/续批运行保留检查点供后续批次与断点续写使用。
    if (to >= totalChapters
      && this.selectedSteps.includes('premise') && this.selectedSteps.includes('characters')
      && this.selectedSteps.includes('worldbuilding') && this.selectedSteps.includes('synopsis')) {
      this.assertNotCancelled(context)
      requireIpcSuccess(
        await ipc.invokeWithProjectSession(
          projectSession,
          'fs:write-file',
          `${expectedProjectPath}/${CANONICAL_PROJECT_DIRECTORY}/partial_arch.json`,
          '{}',
          expectedProjectPath,
        ),
        note('清理架构生成进度失败', 'Failed to clear the architecture-generation progress.'),
      )
    }

    callbacks.log(text(
      to >= totalChapters
        ? (mode === 'resume' ? '情节大纲续写完成，全书大纲已就绪' : '情节大纲已生成，全书大纲已就绪')
        : (mode === 'resume'
            ? `第 ${from}–${to} 章续写完成；全书还剩第 ${to + 1} 章起待生成`
            : `第 ${from}–${to} 章已生成；全书还剩第 ${to + 1} 章起待生成`),
      to >= totalChapters
        ? (mode === 'resume' ? 'Plot-outline continuation complete; the full outline is ready.' : 'Plot outline generated; the full outline is ready.')
        : (mode === 'resume'
            ? `Batch chapters ${from}-${to} continued; chapters ${to + 1}+ are still pending.`
            : `Batch chapters ${from}-${to} generated; chapters ${to + 1}+ are still pending.`),
    ))
    return confirmedBody
  }

  private async executeChapterOutline({ context, callbacks }: Pick<CommandExecuteParams, 'context' | 'callbacks'>, recovery: GenerationRecoveryContext, initial: PlotOutlineProgress): Promise<string> {
    const session = requireWorkflowProjectSession(context), handle = context.mainGenerationRunHandle!
    const text = (zh: string, en: string) => workflowUiText(context, zh, en)
    const { expectedProjectPath } = this.snapshot
    const sourceExpected = initial.sourceExpected
    const configInput = recovery.authorInputs.find(input => input.id === 'architecture:author-config')
    if (!configInput) throw new Error('GENERATION_PLOT_OUTLINE_SOURCE_INVALID')
    const config: NovelConfig = JSON.parse(configInput.text)
    const guidance = recovery.authorInputs.find(input => input.id === 'architecture:step-guidance:synopsis')?.text ?? ''
    const requestedGuidance = (context.data.stepGuidance as Record<string, unknown> | undefined)?.synopsis
    if (this.options.resumeSynopsis && typeof requestedGuidance === 'string' && requestedGuidance !== guidance) throw new Error('GENERATION_PLOT_OUTLINE_GUIDANCE_CHANGED')
    if (!sourceExpected.premise || !sourceExpected.charactersArch || !sourceExpected.worldbuilding) throw authorError(context.interfaceLocale, { note: note('故事前提、角色名单和世界观必须先完成。', 'Complete the premise, characters and worldbuilding first.') })
    const language = sourceExpected.writingLanguage
    const template = await resolvePromptTemplate('synopsis', session, language)
    if (!template) throw authorError(context.interfaceLocale, { note: note('模板丢失', 'The plot-outline template is missing.') })
    const { getPlotStructureGuide, getNarrativePOVLabel } = await import('../architecture-workflow')
    const promptBuilder = new ArchitecturePromptBuilder(template, language)
      .withCoreSeed(sourceExpected.premise).withCharacterDynamics(sourceExpected.charactersArch).withWorldBuilding(sourceExpected.worldbuilding)
      .withGenre(localizeNovelConfigFacts(config, language).genre).withNumberOfChapters(sourceExpected.totalChapters)
      .withWordNumber(sourceExpected.wordsPerChapter)
      .withPlotStructureGuide(getPlotStructureGuide(config.plotStructure || 'three_act', sourceExpected.totalChapters, language))
      .withNarrativePov(getNarrativePOVLabel(config.narrativePOV || 'third_limited', language))
      .withGlobalGuidance(sourceExpected.globalGuidance).withStepGuidance(guidance)
    const representedConfig: Record<string, unknown> = { genre: config.genre, totalChapters: sourceExpected.totalChapters,
      wordsPerChapter: sourceExpected.wordsPerChapter, plotStructure: config.plotStructure, narrativePOV: config.narrativePOV,
      globalGuidance: sourceExpected.globalGuidance, writingLanguage: language }
    const additionalConfig = Object.fromEntries(Object.entries(config).filter(([key, value]) => representedConfig[key] !== value))
    const originalPrompt = [promptBuilder.build(), ...(Object.keys(additionalConfig).length ? [promptLanguageText(language,
      `【其余冻结作者配置，须保留全部硬要求】\n${JSON.stringify(additionalConfig)}`,
      `[Additional frozen author configuration; preserve all hard requirements]\n${JSON.stringify(additionalConfig)}`)] : [])].join('\n\n')
    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, session)
    const factsFingerprint = synopsisInputsFingerprint(sourceExpected, guidance, initial.range, template)
    const saveNavigation = async (outline: PlotOutlineProgress, complete = false) => {
      partial.synopsis_protocol = PLOT_OUTLINE_PROTOCOL
      partial.synopsis_generation_handle = handle
      partial.synopsis_incomplete = !complete
      partial.synopsis_range = { ...outline.range }
      partial.synopsis_covered_to = complete ? outline.range.to : outline.range.from - 1
      partial.synopsis_step_guidance = guidance
      partial.synopsis_facts_fingerprint = factsFingerprint
      if (outline.confirmedPrefix === null) throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
      const body = joinPlotOutlineEntries(outline.confirmedPrefix, outline.composition?.text ?? '')
      partial.synopsis_body_hash = synopsisFactsFingerprint([body])
      partial.synopsis_db_hash = synopsisFactsFingerprint([complete ? renderPlotOutlineRange(outline.composition?.text ?? '', outline.range, sourceExpected) : sourceExpected.synopsis])
      if (complete) partial.synopsis_result = body
      else delete partial.synopsis_result
      context.data.partial = partial
      await savePartialData(expectedProjectPath, partial, session, ['保存情节大纲进度', 'save the plot-outline progress', '情節大綱の進捗の保存'])
    }
    const stopped = (cursor: Extract<PlotOutlineProgress['cursor'], { kind: 'stopped' }>) => {
      if (cursor.reason === 'source-invalid') return authorError(context.interfaceLocale, { note: writtenNote(plotOutlineSourceInvalidText(sourceExpected.synopsis, workflowUiLocale(context))) })
      const n = { n: cursor.chapterNumber }
      return authorError(context.interfaceLocale, { note: {
        'attempts-exhausted': note('恢复稿里有已写好的章节，第 {n} 章最后一次的回复在「原始候选」里，正式大纲没动。第 {n} 章两次都没写成完整的单章大纲，自动生成停在这里。到「架构」页点「编辑恢复稿」接着生成。',
          'The recovery draft has the finished chapters; the last reply for chapter {n} is under Original candidate; the saved outline is unchanged. Chapter {n} failed twice to come back as one complete chapter outline, so generation stopped there. Open Architecture and choose Edit recovery draft to keep going.', n),
        'unknown-completion': note('恢复稿里有已写好的章节，正式大纲没动。第 {n} 章的回复没有正常结束，自动生成停在这里。到「架构」页点「编辑恢复稿」接着生成。',
          'The recovery draft has the finished chapters; the saved outline is unchanged. The reply for chapter {n} did not finish normally, so generation stopped there. Open Architecture and choose Edit recovery draft to keep going.', n),
        'in-flight': note('恢复稿里有已写好的章节，正式大纲没动。第 {n} 章上一次请求还没有结果，自动生成停在这里。到「架构」页点「编辑恢复稿」接着生成。',
          'The recovery draft has the finished chapters; the saved outline is unchanged. The previous request for chapter {n} has no result yet, so generation stopped there. Open Architecture and choose Edit recovery draft to keep going.', n),
      }[cursor.reason] })
    }
    const requestCallbacks = { ...callbacks, setProgress: () => {} }
    const publishProgress = (outline: PlotOutlineProgress) => {
      const total = outline.range.to - outline.range.from + 1
      const accepted = outline.cursor.kind === 'complete' ? total : outline.cursor.chapterNumber - outline.range.from
      callbacks.setProgress(Math.min(99, Math.round(accepted * 100 / total)))
    }
    let outline = initial
    // 来源无效时没有可写进检查点的前缀，先给与恢复入口相同的说明；其余停止原因照常先写检查点。
    if (outline.cursor.kind === 'stopped' && outline.cursor.reason === 'source-invalid') throw stopped(outline.cursor)
    await saveNavigation(outline)
    publishProgress(outline)
    while (outline.cursor.kind !== 'complete') {
      this.assertNotCancelled(context)
      assertArchitectureProjectSessionCurrent(session, context)
      const cursor = outline.cursor
      if (cursor.kind === 'stopped') throw stopped(cursor)
      if (cursor.kind === 'accept') {
        const next = joinPlotOutlineEntries(outline.composition?.text ?? '', cursor.text)
        await ipc.invokeWithProjectSession(session, 'generation:compose-visible', handle,
          [...(outline.composition?.artifactIds ?? []), ...cursor.artifactIds], await hashAuthorText(next), PLOT_OUTLINE_PROTOCOL)

      } else {
        callbacks.log(text(`正在生成第 ${cursor.chapterNumber} 章大纲${cursor.attempt === 'compact' ? '，进行唯一一次原事实重建' : ''}。`,
          `Generating the outline for chapter ${cursor.chapterNumber}${cursor.attempt === 'compact' ? ' with its single rebuild from original facts' : ''}.`))
        try {
          await this.callLLMResult(`${originalPrompt}\n\n${plotOutlineRequestContract(outline, cursor.chapterNumber, cursor.attempt)}`,
            `${promptBuilder.getSystemRole()}\n\n${planningTargetInstruction('outline', outline.targetUnits, language)}`, requestCallbacks, { purpose: plotOutlinePurpose(cursor.chapterNumber, cursor.attempt), reasoningStage: 'planning', writingSkillStage: 'planning' }, context)
        } catch (error) {
          const code = failureCode(errorCodeOf(error))
          if (!code || !PLOT_OUTLINE_SOURCE_CHANGED_CODES.has(code)) throw error
          throw new PlotOutlineSourceChangedError(context.interfaceLocale, code,
            sourceChangedMidBatch(code === 'GENERATION_SOURCE_CHANGED_MODEL', cursor.chapterNumber, outline.range.from), { cause: error })
        }
      }
      const current = await ipc.invokeWithProjectSession(session, 'generation:read', handle)
      if (!current.plotOutline) throw new Error('GENERATION_PLOT_OUTLINE_SOURCE_INVALID')
      outline = current.plotOutline
      if (cursor.kind === 'accept') await saveNavigation(outline)
      publishProgress(outline)
    }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(session, context)
    const synopsis = renderPlotOutlineRange(outline.composition?.text ?? '', outline.range, sourceExpected)
    try {
      const committed = await ipc.invokeWithProjectSession(session, 'db:project-core-synopsis-commit', { synopsis, expected: sourceExpected, generationRunHandle: handle }, expectedProjectPath)
      requireIpcSuccess(committed, ['保存完整情节大纲', 'save the complete plot outline', '情節大綱全体の保存'])
    } catch (error) {
      // 最后一章生成完、正式保存前来源变了：主进程在保存这一步只报通用码，不分模型还是其他来源。
      const code = failureCode(errorCodeOf(error))
      if (!code || !PLOT_OUTLINE_SOURCE_CHANGED_CODES.has(code)) throw error
      const range = outline.range
      throw new PlotOutlineSourceChangedError(context.interfaceLocale, code, range.from === range.to
        ? note('本批第 {from} 章大纲已生成完，但保存前模型设置、作品设定、提示词模板或写作 Skill 改过，正式保存被拒绝。这批大纲保留在「大纲恢复稿」中，只能查看或复制，不能覆盖正式内容。正式大纲未被改动。请到「架构」页重新生成情节大纲，从第 {from} 章开始。',
          'The outline for chapter {from} finished, but the model settings, book settings, a prompt template, or a writing skill changed before saving, so saving was refused. The batch is kept in the outline recovery draft, which can be viewed or copied but cannot replace saved content. The saved outline was not changed. Open Architecture and generate the plot outline again from chapter {from}.', range)
        : note('本批第 {from}–{to} 章大纲已生成完，但保存前模型设置、作品设定、提示词模板或写作 Skill 改过，正式保存被拒绝。这批大纲保留在「大纲恢复稿」中，只能查看或复制，不能覆盖正式内容。正式大纲未被改动。请到「架构」页重新生成情节大纲，从第 {from} 章开始。',
          'The outline for chapters {from}–{to} finished, but the model settings, book settings, a prompt template, or a writing skill changed before saving, so saving was refused. The batch is kept in the outline recovery draft, which can be viewed or copied but cannot replace saved content. The saved outline was not changed. Open Architecture and generate the plot outline again from chapter {from}.', range), { cause: error })
    }
    await saveNavigation(outline, true)
    const { globalEventBus } = await import('../../../shared/event-bus')
    globalEventBus.emit('ARCH_FILE_UPDATED', { fileName: 'synopsis.md', projectPath: expectedProjectPath, projectSession: session, runId: context.runId })
    callbacks.log(text(`第 ${outline.range.from}–${outline.range.to} 章大纲已完整保存。`, `The complete outline for chapters ${outline.range.from}-${outline.range.to} was saved.`))
    return synopsis
  }

  private async rollbackSynopsisCheckpoint(
    expectedProjectPath: string,
    projectSession: ProjectSessionContext,
    context: WorkflowContext,
    previousPartial: PartialArchData,
    writtenPartial: PartialArchData,
  ): Promise<void> {
    const readResult = await ipc.invokeWithProjectSession(
      projectSession,
      'fs:read-json',
      `${expectedProjectPath}/${CANONICAL_PROJECT_DIRECTORY}/partial_arch.json`,
      expectedProjectPath,
    )
    if (!readResult.success || !readResult.data) {
      throw authorError(context.interfaceLocale, { note: note('读不到刚保存的生成进度，请再试一次。', 'The saved generation progress could not be read back. Try again.') })
    }
    const currentPartial = readResult.data as PartialArchData
    if (!sameSynopsisCheckpoint(currentPartial, writtenPartial)) {
      context.data.partial = currentPartial
      return
    }
    const restored = restoreSynopsisCheckpoint(currentPartial, previousPartial)
    await savePartialData(
      expectedProjectPath,
      restored,
      projectSession,
      note('恢复上一版情节大纲进度失败', 'Failed to restore the previous plot-outline progress.'),
    )
    context.data.partial = restored
  }

  private async commitSynopsisWithCheckpointRollback(
    synopsis: string,
    expectedProjectPath: string,
    runId: string,
    projectSession: ProjectSessionContext,
    context: WorkflowContext,
    expected: ProjectCoreSynopsisExpected,
    previousPartial: PartialArchData,
    writtenPartial: PartialArchData,
    fallbackError: string,
  ): Promise<void> {
    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'db:project-core-synopsis-commit',
      { synopsis: stripThinkingTags(synopsis), expected, ...(this.requireGenerationExecution().mainOwned ? { generationRunHandle: context.mainGenerationRunHandle } : {}) },
      expectedProjectPath,
    )
    if (!result.success) {
      const failure = specificWriteFailure(result)
      const commitFailure: Failure = failure?.code === 'PROJECT_CORE_SYNOPSIS_CHANGED'
        ? { code: failure.code, note: note('项目数据已变化，已拒绝覆盖情节大纲。', 'Project data changed while the outline was being generated, so overwriting it was refused.') }
        : failure ?? { note: writtenNote(fallbackError) }
      try {
        await this.rollbackSynopsisCheckpoint(
          expectedProjectPath,
          projectSession,
          context,
          previousPartial,
          writtenPartial,
        )
      } catch (rollbackError) {
        throw authorError(context.interfaceLocale, {
          note: note('情节大纲没能保存，之前的进度也没能恢复。', 'The plot outline could not be saved, and the previous progress could not be restored either.'),
          because: commitFailure,
        }, { cause: rollbackError })
      }
      throw authorError(context.interfaceLocale, commitFailure)
    }

    const { globalEventBus } = await import('../../../shared/event-bus')
    globalEventBus.emit('ARCH_FILE_UPDATED', {
      fileName: 'synopsis.md',
      projectPath: expectedProjectPath,
      projectSession,
      runId,
    })
  }

  /**
   * 中断时落盘：先写检查点（权威：正文 + 批次范围 + 源事实指纹 + 未完成标记），
   * 再镜像 DB 正文并附加「未完成」说明。检查点写入失败时不提供续写入口。
   */
  private async persistInterruptedSynopsis(
    projectSession: ProjectSessionContext,
    expectedProjectPath: string,
    context: WorkflowContext,
    partialText: string,
    range: PlotOutlineChapterRange,
    factsFingerprint: string,
    stepGuidance: string,
    sourceExpected: ProjectCoreSynopsisExpected,
  ): Promise<void> {
    const writingLanguage = workflowWritingLanguage(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    const previousPartial = { ...partial }
    if (this.requireGenerationExecution().mainOwned) delete partial.synopsis_result
    else partial.synopsis_result = partialText
    partial.synopsis_incomplete = true
    partial.synopsis_covered_to = range.from - 1
    partial.synopsis_range = { from: range.from, to: range.to }
    partial.synopsis_facts_fingerprint = factsFingerprint
    partial.synopsis_body_hash = synopsisFactsFingerprint([partialText])
    partial.synopsis_step_guidance = stepGuidance
    const dbOutlineText = renderSynopsisDbText(
      partialText,
      writingLanguage,
      sourceExpected.totalChapters,
      partial,
    )
    partial.synopsis_db_hash = synopsisFactsFingerprint([this.requireGenerationExecution().mainOwned ? sourceExpected.synopsis : dbOutlineText])
    context.data.partial = partial
    this.assertNotCancelled(context)
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      note('保存中断时的情节大纲进度失败', 'Failed to save the interrupted plot-outline progress.'),
    )
    // Main owns interrupted candidate text; formal synopsis remains unchanged.
    if (this.requireGenerationExecution().mainOwned) return
    if (context.cancelled) {
      await this.rollbackSynopsisCheckpoint(
        expectedProjectPath,
        projectSession,
        context,
        previousPartial,
        partial,
      )
    }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)

    await this.commitSynopsisWithCheckpointRollback(
      dbOutlineText,
      expectedProjectPath,
      context.runId,
      projectSession,
      context,
      sourceExpected,
      previousPartial,
      partial,
      text('故事架构写入数据库失败', 'Failed to write story architecture to the database.'),
    )
  }
}
