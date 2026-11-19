import { ipc } from './ipc-client'
import { promptLanguageText } from './prompt-language'
import { activeNarrativeThreadBlock, listRelevantNarrativeThreads, readCharacterProfiles } from './workflows/chapter-context-readers'
import { previousChapterEnding } from './workflows/chapter-materials'
import { localizeNovelConfigFacts } from '../shared/novel-config-localization'
import { EDITOR_CONTEXT_PLAN, EDITOR_CONTEXT_PREVIOUS_ENDING_BELOW, type EditorContextBlock, type EditorContextReadKind,
  type EditorInlineChapterContext, type EditorInlineRequest } from '../shared/editor-inline-generation'
import type { NovelConfig, ProjectSessionContext } from '../shared/ipc-channels'
import type { WritingLanguage } from '../shared/writing-language'

/** 读不出（抛错或名册待修）记 unreadable；读到空就不带这一块。 */
type Read = { text: string } | 'unreadable'

/** 章内编辑时给主进程备候选块。读哪些块只看工具表。 */
export async function prepareEditorChapterContext(request: {
  session: ProjectSessionContext
  novelConfig: Partial<NovelConfig>
  language: WritingLanguage
  chapterNumber: number
  action: EditorInlineRequest['action']
  /** 选区前本章正文的字数。 */
  precedingChars: number
}): Promise<EditorInlineChapterContext> {
  const { session, language, chapterNumber } = request
  const path = session.projectPath
  const say = (zh: string, en: string) => promptLanguageText(language, zh, en)
  const wanted = new Map(EDITOR_CONTEXT_PLAN[request.action].flatMap(entry => 'maxChars' in entry ? [] : [[entry.kind, entry.required] as const]))
  const blueprint = wanted.has('blueprint') || wanted.has('characters') || wanted.has('threads')
    ? await ipc.invokeWithProjectSession(session, 'db:blueprint-get', chapterNumber, path).catch(() => undefined) : null
  const names = blueprint?.characters ?? []
  const reads: Partial<Record<EditorContextReadKind, () => Promise<Read>>> = {
    style: async () => {
      const pov = localizeNovelConfigFacts({ narrativePOV: request.novelConfig.narrativePOV }, language).narrativePOV
      return { text: [pov && say(`叙事视角：${pov}`, `Point of view: ${pov}`),
        request.novelConfig.writingStyle?.trim() && say(`文风：${request.novelConfig.writingStyle.trim()}`, `Style: ${request.novelConfig.writingStyle.trim()}`),
        request.novelConfig.globalGuidance?.trim() && say(`全局写作要求：${request.novelConfig.globalGuidance.trim()}`, `Global requirements: ${request.novelConfig.globalGuidance.trim()}`),
      ].filter(Boolean).join('\n') }
    },
    blueprint: async () => blueprint === undefined ? 'unreadable' : { text: !blueprint ? '' : [
      [say('标题', 'Title'), blueprint.title], [say('本章作用', 'Role'), blueprint.role], [say('本章目的', 'Purpose'), blueprint.purpose],
      [say('关键事件', 'Key events'), blueprint.keyEvents], [say('出场人物', 'Characters'), blueprint.characters.join(say('、', ', '))],
      [say('悬念钩子', 'Hook'), blueprint.suspenseHook], [say('作者微操', 'Author guidance'), blueprint.userGuidance],
    ].filter(([, value]) => value?.trim()).map(([label, value]) => `${label}${say('：', ': ')}${value!.trim()}`).join('\n') },
    characters: async () => {
      if (!names.length) return { text: '' }
      const read = await readCharacterProfiles(path, session, language, chapterNumber, names, undefined)
      return read.unavailable ? 'unreadable' : { text: read.text }
    },
    threads: async () => {
      const threads = await listRelevantNarrativeThreads(path, session, { chapterNumber, title: blueprint?.title ?? '', keyEvents: blueprint?.keyEvents ?? '', characters: names })
      return threads === null ? 'unreadable' : { text: activeNarrativeThreadBlock(threads, chapterNumber, language).lines.join('\n') }
    },
    'previous-ending': async () => {
      if (chapterNumber === 1 || request.precedingChars >= EDITOR_CONTEXT_PREVIOUS_ENDING_BELOW) return { text: '' }
      try {
        const meta = await ipc.invokeWithProjectSession(session, 'db:draft-get-finalized', chapterNumber - 1, path)
        const full = meta ? await ipc.invokeWithProjectSession(session, 'db:draft-get-full', meta.id, path) : null
        return { text: full ? previousChapterEnding(full.content) : '' }
      } catch {
        return 'unreadable'
      }
    },
  }
  const blocks: EditorContextBlock[] = []
  const unreadable: EditorContextReadKind[] = []
  await Promise.all([...wanted].map(async ([kind, required]) => {
    const read = await reads[kind]!().catch((): Read => 'unreadable')
    if (read === 'unreadable') unreadable.push(kind)
    else if (read.text.trim()) blocks.push({ kind, text: read.text, required })
  }))
  const order = [...wanted.keys()]
  blocks.sort((a, b) => order.indexOf(a.kind as EditorContextReadKind) - order.indexOf(b.kind as EditorContextReadKind))
  unreadable.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return { version: 1, chapterNumber, blocks, unreadable }
}
