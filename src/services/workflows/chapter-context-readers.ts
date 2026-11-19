import { ipc } from '../ipc-client'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { WritingLanguage } from '../../shared/writing-language'
import { promptLanguageText } from '../prompt-language'
import { pluralEn } from '../../shared/plural-en'
import { CHARACTER_STATE_TEXT_FIELDS, type CharacterRosterEntry } from '../../shared/character-roster'
import { characterTimelinePromptLines, type CharacterTimelinePromptLines } from '../../shared/character-timeline-prompt'
import { isChapterThreadTaskSchedule, narrativeThreadSchedule, type ChapterThreadTask, type NarrativeThreadView } from '../../shared/narrative-thread'

/** 写正文与编辑器共用的本章材料读取。每块都只取到 chapterNumber 为止。 */

const ACTIVE_THREAD_CONTEXT_MAX_CHARS = 1200
const ACTIVE_THREAD_CONTEXT_MAX_ITEMS = 6

export interface CharacterProfilesRead {
  text: string
  timeline: CharacterTimelinePromptLines
  timelineUnits: number
  timelineUnavailable: boolean
  rosterRevision?: number
  /** 名册读不出或来源待修，text 只是一句说明。 */
  unavailable?: true
}

async function readCharacterTimeline(
  projectPath: string,
  projectSession: ProjectSessionContext,
  language: WritingLanguage,
  chapterNumber: number,
  entries: readonly CharacterRosterEntry[],
  selected: ReadonlySet<CharacterRosterEntry>,
): Promise<CharacterTimelinePromptLines | null> {
  const characterIds = [...selected].flatMap(card => card.characterId ?? [])
  try {
    return characterTimelinePromptLines({
      nodes: await ipc.invokeWithProjectSession(projectSession, 'db:character-continuity-nodes', characterIds, projectPath),
      chapter: chapterNumber,
      characterIds,
      currentNames: new Map(entries.flatMap(card => card.characterId ? [[card.characterId, card.name] as const] : [])),
      language,
    })
  } catch {
    return null
  }
}

export async function readCharacterProfiles(
  projectPath: string,
  projectSession: ProjectSessionContext,
  writingLanguage: WritingLanguage,
  chapterNumber: number,
  relevantCharacterNames: readonly string[],
  recordedTimeline: CharacterTimelinePromptLines | undefined,
): Promise<CharacterProfilesRead> {
  const unavailable = (text: string, rosterRevision?: number): CharacterProfilesRead => ({ text, timeline: {}, timelineUnits: 0, timelineUnavailable: false, rosterRevision, unavailable: true })
  try {
    const roster = await ipc.invokeWithProjectSession(projectSession, 'db:character-roster-read', projectPath)
    if (roster.status !== 'ready' && roster.status !== 'empty') {
      return unavailable(promptLanguageText(
        writingLanguage,
        '（角色资料来源未知或待修复；未作为作者事实注入）',
        '(character-profile provenance is unknown or needs repair; it was not injected as author fact)',
      ), roster.revision)
    }
    const profiles: string[] = []
    const relevantNames = new Set(relevantCharacterNames.map(name => name.trim()).filter(Boolean))
    const selected = new Set<typeof roster.entries[number]>()
    for (const name of relevantNames) {
      const named = roster.entries.filter(card => card.name === name)
      const renamed = roster.entries.filter(card => card.name !== name && card.characterId
        && roster.aliases?.some(alias => alias.name === name && alias.characterId === card.characterId))
      // 旧名被另一角色复用时无法判断蓝图指谁，宁可不注入也不注入错的档案或中断写稿。
      if (renamed.length === 0) for (const card of named) selected.add(card)
      else if (named.length === 0 && renamed.length === 1) selected.add(renamed[0])
    }
    const read = recordedTimeline ?? await readCharacterTimeline(projectPath, projectSession, writingLanguage, chapterNumber, roster.entries, selected)
    const timeline = read ?? {}
    let timelineUnits = 0
    for (const card of selected) {
      const timelineLines = card.characterId ? timeline[card.characterId] : undefined
      const facts = [
        card.gender && `gender: ${card.gender}`,
        card.age && `age: ${card.age}`,
        card.appearance && `appearance: ${card.appearance}`,
        card.personality && `personality: ${card.personality}`,
        card.background && `background: ${card.background}`,
        card.abilities && `abilities: ${card.abilities}`,
        card.motivation && `motivation: ${card.motivation}`,
        card.arc && `arc: ${card.arc}`,
        card.notes && `notes: ${card.notes}`,
      ].filter(Boolean)
      if (!timelineLines) for (const relationship of card.relationships ?? []) {
        const target = relationship.target?.trim()
        const relation = relationship.relation?.trim()
        if (target && relation) facts.push(`relationship: ${target} (${relation})`)
      }
      const legacyRelationshipNotes = card.legacyRelationshipNotes?.trim()
      if (legacyRelationshipNotes) {
        facts.push(promptLanguageText(
          writingLanguage,
          `relationship（legacy 来源未知）: ${legacyRelationshipNotes}`,
          `relationship (legacy provenance unknown): ${legacyRelationshipNotes}`,
        ))
      }
      if (timelineLines) {
        facts.push(...timelineLines)
        timelineUnits += new TextEncoder().encode(timelineLines.map(line => ` | ${line}`).join('')).length
      } else for (const field of CHARACTER_STATE_TEXT_FIELDS) {
        const provenance = card.currentState?.provenance?.[field]
        const value = card.currentState?.[field]?.trim()
        if (provenance?.kind === 'author' && provenance.chapterNumber <= chapterNumber && value) {
          facts.push(`${field}@chapter${provenance.chapterNumber}: ${value}`)
        }
      }
      profiles.push(`${card.name} (${card.role || 'unknown'})${facts.length ? ` | ${facts.join(' | ')}` : ''}`)
    }
    return { text: profiles.length > 0 ? profiles.join('\n') : '', timeline, timelineUnits, timelineUnavailable: read === null, rosterRevision: roster.revision }
  } catch {
    return unavailable(promptLanguageText(
      writingLanguage,
      '（角色资料读取失败；未把旧 currentState 或 characters_arch 当作作者事实）',
      '(character profiles unavailable; legacy currentState and characters_arch were not treated as author facts)',
    ))
  }
}

/** 读取失败返回 null，与没有相关线索区分开。 */
export async function listRelevantNarrativeThreads(
  projectPath: string,
  projectSession: ProjectSessionContext,
  chapter: { chapterNumber: number; title: string; keyEvents: string; characters: readonly string[] },
): Promise<NarrativeThreadView[] | null> {
  try {
    return await ipc.invokeWithProjectSession(
      projectSession,
      'db:narrative-thread-list-relevant',
      { chapterNumber: chapter.chapterNumber, title: chapter.title, keyEvents: chapter.keyEvents, characters: [...chapter.characters] },
      projectPath,
    )
  } catch {
    return null
  }
}

export function threadScheduleNote(schedule: ChapterThreadTask['schedule']): { zhCN: string; enUS: string } {
  if (schedule.kind === 'overdue') {
    return { zhCN: `已逾期 ${schedule.chaptersOverdue} 章`, enUS: `overdue by ${schedule.chaptersOverdue} ${pluralEn(schedule.chaptersOverdue, 'chapter')}` }
  }
  return schedule.kind === 'assigned'
    ? { zhCN: '作者指定本章推进', enUS: 'assigned by the author to this chapter' }
    : { zhCN: '本章到期', enUS: 'due this chapter' }
}

/** 证据只取本章之前定稿的章。 */
export function activeNarrativeThreadBlock(
  threads: readonly NarrativeThreadView[],
  chapterNumber: number,
  writingLanguage: WritingLanguage,
): { text: string; lines: string[]; count: number; leftOut: number } {
  const header = promptLanguageText(
    writingLanguage,
    '【当前相关活跃叙事线索】',
    '[Relevant active narrative threads]',
  )
  const lines: string[] = []
  let usedChars = header.length + 1
  for (const thread of threads) {
    if (lines.length === ACTIVE_THREAD_CONTEXT_MAX_ITEMS) break
    const source = thread.events.filter(event => event.chapterNumber < chapterNumber).at(-1)
    const schedule = narrativeThreadSchedule(thread, chapterNumber)
    const note = schedule && isChapterThreadTaskSchedule(schedule) ? threadScheduleNote(schedule) : null
    const mark = note ? promptLanguageText(writingLanguage, `${note.zhCN}；`, `${note.enUS}; `) : ''
    const line = promptLanguageText(
      writingLanguage,
      `- ${thread.title} [${thread.status}]（${mark}目标第${thread.targetStartChapter}–${thread.targetEndChapter}章；作者意图：${thread.authorIntent}${source ? `；来源第${source.chapterNumber}章：${source.evidence}` : ''}）`,
      `- ${thread.title} [${thread.status}] (${mark}target Chapters ${thread.targetStartChapter}–${thread.targetEndChapter}; author intent: ${thread.authorIntent}${source ? `; source Chapter ${source.chapterNumber}: ${source.evidence}` : ''})`,
    )
    const nextLength = line.length + (lines.length > 0 ? 1 : 0)
    if (usedChars + nextLength > ACTIVE_THREAD_CONTEXT_MAX_CHARS) continue
    lines.push(line)
    usedChars += nextLength
  }
  const leftOut = threads.length - lines.length
  if (lines.length === 0) return { text: '', lines, count: 0, leftOut }
  return { text: `${header}\n${lines.join('\n')}`, lines, count: lines.length, leftOut }
}
