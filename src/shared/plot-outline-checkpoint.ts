import type { MainGenerationRunHandle } from '../services/generation/generation-runtime'
import { PLOT_OUTLINE_PROTOCOL, plotOutlineCoverageNote, plotOutlineLastChapter, plotOutlineNextChapter } from './plot-outline-contract'
import type { WritingLanguage } from './writing-language'

export interface SynopsisCheckpoint {
  synopsis_protocol?: typeof PLOT_OUTLINE_PROTOCOL
  synopsis_generation_handle?: MainGenerationRunHandle
  synopsis_result?: string
  synopsis_incomplete?: boolean
  synopsis_covered_to?: number
  synopsis_range?: { from: number; to: number }
  synopsis_db_hash?: string
  synopsis_body_hash?: string
}

export const MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS = 120

const SYNOPSIS_INCOMPLETE_MARKER_ZH = [
  '',
  '> ⚠️ **本大纲未完成**：生成被输出长度中断，以上为已自动保存的已完成部分。',
  '> 可在「AI 输出」提示处点击「继续生成情节大纲」，从断点续写补齐本批章节。',
  '',
].join('\n')

const SYNOPSIS_INCOMPLETE_MARKER_EN = [
  '',
  '> ⚠ **This outline is incomplete**: generation stopped at the output length limit; the completed part above was saved automatically.',
  '> Click “Continue plot outline” in the AI output notice to resume this batch.',
  '',
].join('\n')

export function synopsisFactsFingerprint(facts: readonly string[]): string {
  const joined = facts.join('\u0001')
  let hash = 5381
  for (let index = 0; index < joined.length; index += 1) {
    hash = ((hash << 5) + hash + joined.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

export function renderSynopsisDbText(
  body: string,
  writingLanguage: WritingLanguage,
  totalChapters: number,
  checkpoint: Pick<SynopsisCheckpoint, 'synopsis_incomplete' | 'synopsis_covered_to'>,
): string {
  const english = writingLanguage === 'en-US'
  const heading = english ? 'Plot Outline' : '情节大纲'
  if (checkpoint.synopsis_incomplete === true) {
    return `# ${heading}\n\n${body}\n${english ? SYNOPSIS_INCOMPLETE_MARKER_EN : SYNOPSIS_INCOMPLETE_MARKER_ZH}`.trim()
  }
  const coveredTo = checkpoint.synopsis_covered_to ?? totalChapters
  const visibleBody = coveredTo < totalChapters
    ? `${body}\n\n${plotOutlineCoverageNote(coveredTo, totalChapters, writingLanguage)}`
    : body
  return `# ${heading}\n\n${visibleBody}`.trim()
}

export function assertCheckpointDbMirrorCurrent(
  partial: SynopsisCheckpoint,
  dbOutlineText: string,
  writingLanguage: WritingLanguage,
  totalChapters: number,
  uiText: (zhCNText: string, enUSText: string) => string,
): string {
  const range = partial.synopsis_range
  const coveredTo = partial.synopsis_covered_to ?? 0
  if (!range
    || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
    || range.from < 1 || range.from > range.to || range.to > totalChapters
    || !Number.isSafeInteger(coveredTo) || coveredTo < 0 || coveredTo > totalChapters
    || (partial.synopsis_incomplete !== true && coveredTo !== range.to)
    || (partial.synopsis_incomplete === true && coveredTo >= range.to)
  ) {
    throw new Error(uiText(
      '情节大纲检查点的章节范围或进度已损坏，无法安全续写。请从第 1 章重新生成。',
      'The plot-outline checkpoint has a damaged range or progress value and cannot be continued safely. Regenerate from chapter 1.',
    ))
  }
  const checkpointBody = typeof partial.synopsis_result === 'string'
    ? partial.synopsis_result.trim()
    : ''
  if (!checkpointBody) {
    throw new Error(uiText(
      '情节大纲检查点缺少正文，无法安全续写。请从第 1 章重新生成。',
      'The plot-outline checkpoint has no body and cannot be continued safely. Regenerate from chapter 1.',
    ))
  }
  const dbOutlineHash = synopsisFactsFingerprint([dbOutlineText])
  const recordedHash = partial.synopsis_db_hash
  if (recordedHash === undefined) {
    throw new Error(uiText(
      '续批检查点没有数据库镜像指纹，无法确认大纲未被手动修改。请从「AI 生成故事架构」从第 1 章重新生成大纲。',
      'The continuation checkpoint has no database-mirror fingerprint, so we cannot confirm the outline was not edited by hand. Regenerate the outline from chapter 1 in “Generate story architecture”.',
    ))
  }
  if (recordedHash !== dbOutlineHash) {
    throw new Error(uiText(
      '情节大纲正文在上次生成后已被手动修改，续批会覆盖这些修改，已拒绝。'
        + '如需保留修改，请基于修改后的正文从第 1 章重新生成；若该修改有误，请先撤销后再续批。',
      'The outline body was manually edited after the last generation; continuing would overwrite those edits, so it was rejected. '
        + 'To keep the edits, regenerate from chapter 1 on top of them; if the edit was a mistake, revert it before continuing.',
    ))
  }
  if (renderSynopsisDbText(checkpointBody, writingLanguage, totalChapters, partial) !== dbOutlineText
    || (partial.synopsis_body_hash !== undefined
      && partial.synopsis_body_hash !== synopsisFactsFingerprint([checkpointBody]))
  ) {
    throw new Error(uiText(
      '情节大纲检查点正文与数据库原文不一致，无法安全续写。数据库正文未被覆盖。',
      'The plot-outline checkpoint body does not exactly match the database source. The database outline was not overwritten.',
    ))
  }
  return checkpointBody
}

export function hasVisibleIncompleteSynopsisMarker(dbOutlineText: string): boolean {
  return dbOutlineText.includes('本大纲未完成')
    || dbOutlineText.includes('This outline is incomplete')
}

export function hasVisiblePartialSynopsisMarker(dbOutlineText: string): boolean {
  return hasVisibleIncompleteSynopsisMarker(dbOutlineText)
    || dbOutlineText.includes('本大纲已覆盖至第')
    || dbOutlineText.includes('This outline covers chapters')
}

export function isUsableSynopsisCheckpoint(
  value: unknown,
  dbOutlineText: string,
  writingLanguage: WritingLanguage,
  totalChapters: number,
): boolean {
  if (!value || typeof value !== 'object') return false
  const partial = value as SynopsisCheckpoint
  if (partial.synopsis_protocol === PLOT_OUTLINE_PROTOCOL && partial.synopsis_incomplete && partial.synopsis_generation_handle) return true
  try {
    return assertCheckpointDbMirrorCurrent(
      partial,
      dbOutlineText,
      writingLanguage,
      totalChapters,
      (zhCNText) => zhCNText,
    ).length >= MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS
  } catch {
    return false
  }
}

export function isRecoverableSynopsisCheckpoint(
  value: unknown,
  dbOutlineText: string,
  writingLanguage: WritingLanguage,
  totalChapters: number,
): boolean {
  return Boolean((value as SynopsisCheckpoint | null)?.synopsis_incomplete)
    && isUsableSynopsisCheckpoint(value, dbOutlineText, writingLanguage, totalChapters)
}

export type OutlineProgress =
  | { kind: 'empty' }
  | { kind: 'interrupted' }
  | { kind: 'partial'; coveredTo: number; total: number }
  | { kind: 'unresumable' }
  | { kind: 'complete' }

export function outlineProgress(synopsis: string, checkpoint: unknown, writingLanguage: WritingLanguage, totalChapters: number): OutlineProgress {
  if (synopsis.length <= 50) return { kind: 'empty' }
  if (isRecoverableSynopsisCheckpoint(checkpoint, synopsis, writingLanguage, totalChapters)) return { kind: 'interrupted' }
  if (plotOutlineLastChapter(synopsis) === 0) return { kind: 'empty' }
  const next = plotOutlineNextChapter({ synopsis, totalChapters, writingLanguage })
  if (next > 1) return { kind: 'partial', coveredTo: next - 1, total: totalChapters }
  return hasVisiblePartialSynopsisMarker(synopsis) ? { kind: 'unresumable' } : { kind: 'complete' }
}
