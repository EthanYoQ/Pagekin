import { latestNodesBefore, type ContinuityNode } from './character-continuity'
import type { CharacterStateTextField } from './character-roster'
import { writingLanguageText, type WritingLanguage } from './writing-language'

const MAX_ENTRIES_PER_CHARACTER = 8
const MAX_CONTENT_CHARS = 80

const STATE_LABELS: Readonly<Record<CharacterStateTextField, readonly [string, string]>> = Object.freeze({
  location: ['位置', 'location'],
  powerLevel: ['实力', 'power level'],
  physicalState: ['身体状态', 'physical state'],
  mentalState: ['心理状态', 'mental state'],
  keyItems: ['关键物品', 'key items'],
  recentEvents: ['近期经历', 'recent events'],
})

/** 按 characterId 存的提示词行。没有任何节点的角色不在里面，档案沿用原来的行。 */
export type CharacterTimelinePromptLines = Record<string, string[]>

interface PromptEntry { authored: boolean; chapter: number; text: string }

function clipped(text: string): string {
  const chars = [...text.replace(/\s+/gu, ' ').trim()]
  return chars.length > MAX_CONTENT_CHARS ? `${chars.slice(0, MAX_CONTENT_CHARS - 1).join('')}…` : chars.join('')
}

function promptEntry(node: ContinuityNode, language: WritingLanguage, targetName: string, conflict: boolean): PromptEntry | null {
  const say = (zhCN: string, enUS: string) => writingLanguageText(language, zhCN, enUS)
  const [zhAspect, enAspect] = node.aspect === 'relation' ? [`与${targetName}的关系`, `relationship with ${targetName}`] : STATE_LABELS[node.aspect]
  const value = clipped(node.value), chapter = node.effectiveChapter
  const suffix = conflict
    ? say(`（与${targetName}有多条关系并存，待作者裁定，不要替作者选）`, ` (several relationships with ${targetName} coexist; the author has not decided, do not pick one)`)
    : ''
  switch (node.provenance.kind) {
    case 'author':
    case 'adopted':
      return { authored: true, chapter, text: `${say(`作者设定（自第${chapter}章起）${zhAspect}：${value}`, `Author-set from chapter ${chapter}: ${enAspect}: ${value}`)}${suffix}` }
    case 'derived': {
      if (!node.quote?.text.trim()) return null
      const quote = clipped(node.quote.text), source = node.provenance.source.chapterNumber
      return { authored: false, chapter: source, text: `${say(`定稿记录·${zhAspect}（第${source}章，原文：${quote}）`, `Finalized record, ${enAspect} (chapter ${source}, exact text: ${quote})`)}${suffix}` }
    }
    case 'legacy':
      if (node.aspect === 'relation') return { authored: true, chapter, text: `relationship: ${targetName} (${value})${suffix}` }
      return node.provenance.authorChapter === undefined ? null
        : { authored: true, chapter: node.provenance.authorChapter, text: `${node.aspect}@chapter${node.provenance.authorChapter}: ${value}` }
  }
}

/** M08 基线的状态是升级那一刻的快照；关系基线没有章号，是名单里一直有的事实，按开篇就有算。 */
const withTimelessBaselineRelations = (nodes: readonly ContinuityNode[]): ContinuityNode[] =>
  nodes.map(node => node.aspect === 'relation' && node.provenance.kind === 'legacy' ? { ...node, effectiveChapter: 0 } : node)

export function characterTimelinePromptLines(input: {
  nodes: readonly ContinuityNode[]
  chapter: number
  characterIds: readonly string[]
  currentNames: ReadonlyMap<string, string>
  language: WritingLanguage
}): CharacterTimelinePromptLines {
  const { states, relations } = latestNodesBefore(withTimelessBaselineRelations(input.nodes), input.chapter, input.characterIds)
  const withNodes = new Set(input.nodes.map(node => node.subjectId))
  const entries = new Map(input.characterIds.filter(id => withNodes.has(id)).map(id => [id, [] as PromptEntry[]]))
  const add = (node: ContinuityNode, targetName: string, conflict: boolean) => {
    const entry = promptEntry(node, input.language, targetName, conflict)
    if (entry) entries.get(node.subjectId)!.push(entry)
  }
  for (const node of states) add(node, '', false)
  for (const pair of relations) for (const line of pair.lines)
    add(line, input.currentNames.get(pair.targetId) ?? line.targetName, pair.conflict)
  return Object.fromEntries([...entries].map(([id, list]) => [id, list
    .sort((left, right) => Number(right.authored) - Number(left.authored) || right.chapter - left.chapter || (left.text < right.text ? -1 : 1))
    .slice(0, MAX_ENTRIES_PER_CHARACTER).map(entry => entry.text)]))
}
