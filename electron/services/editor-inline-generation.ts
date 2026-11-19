import { textHash, type DurableGenerationRun } from '../repositories/generation-run-repository'
import { EDITOR_CONTEXT_PLAN, EDITOR_CONTEXT_TRIM_ORDER, EDITOR_INLINE_ANNOTATION_MAX_COUNT, EDITOR_INLINE_INSTRUCTION_MAX_LENGTH, editorInlineInsertsAfterSelection,
  type EditorContextBlock, type EditorContextKind, type EditorContextOmission, type EditorInlineAnnotation, type EditorInlineInput, type EditorInlineContext, type EditorInlineMaterials } from '../../src/shared/editor-inline-generation'
import { estimateMaterialTokens } from '../../src/shared/generation-owner-contract'
import type { WritingLanguage } from '../../src/shared/writing-language'
import { composePromptSystemRole, type PromptTemplate } from '../../src/services/builtin-prompt-templates'
import { renderPrompt } from '../../src/shared/render-prompt'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import { isDeepStrictEqual } from 'node:util'

const instructions = {
  refine: ['润色这部分，使语言自然、具体并增强场景表现力。', 'Refine this passage for natural, specific language and stronger scene craft.'],
  expand: ['扩写这部分，补充与情节有关的动作、感官和环境细节。', 'Expand this passage with plot-relevant action, sensory detail, and setting.'],
  continue: ['根据现有因果和人物动机，自然续写接下来的情节。', 'Continue naturally from the established causality and character motivation.'],
  dialogue: ['将这部分改写为有区分度、能推动冲突的自然对话。', 'Rewrite this passage as distinct, natural dialogue that advances the conflict.'],
} as const

const validNote = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && [...value].length <= EDITOR_INLINE_INSTRUCTION_MAX_LENGTH
const validInstruction = (input: EditorInlineInput) => input.action === 'instruct'
  ? validNote(input.instruction)
  : input.action === 'batch-instruct'
    ? Array.isArray(input.annotations) && input.annotations.length > 0 && input.annotations.length <= EDITOR_INLINE_ANNOTATION_MAX_COUNT && !Object.hasOwn(input, 'instruction')
    : typeof input.action === 'string' && Object.hasOwn(instructions, input.action) && !Object.hasOwn(input, 'instruction') && !Object.hasOwn(input, 'annotations')

function validAnnotations(input: EditorInlineInput): boolean {
  if (input.action !== 'batch-instruct') return !Object.hasOwn(input, 'annotations')
  if (input.from !== 0 || input.to !== input.documentText.length) return false
  const ids = new Set<string>()
  let previousTo = 0
  for (const annotation of input.annotations as EditorInlineAnnotation[]) {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)
      || Object.keys(annotation).some(key => !['id', 'from', 'to', 'selectedText', 'instruction'].includes(key))
      || typeof annotation.id !== 'string' || !annotation.id.trim() || annotation.id.length > 128 || ids.has(annotation.id)
      || !Number.isSafeInteger(annotation.from) || !Number.isSafeInteger(annotation.to) || annotation.from < previousTo || annotation.to <= annotation.from
      || annotation.to > input.documentText.length || input.documentText.slice(annotation.from, annotation.to) !== annotation.selectedText
      || !validNote(annotation.instruction)) return false
    ids.add(annotation.id)
    previousTo = annotation.to
  }
  return true
}

function validChapterContext(input: EditorInlineInput): boolean {
  const context = input.chapterContext
  if (context === undefined) return !Object.hasOwn(input, 'chapterContext')
  const readable = new Map(EDITOR_CONTEXT_PLAN[input.action].flatMap(entry => 'maxChars' in entry ? [] : [[entry.kind, entry.required] as const]))
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.keys(context).sort().join() !== 'blocks,chapterNumber,unreadable,version'
    || context.version !== 1 || !Number.isSafeInteger(context.chapterNumber) || context.chapterNumber < 1
    || !Array.isArray(context.blocks) || !Array.isArray(context.unreadable)) return false
  const seen = new Set<string>()
  for (const block of context.blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block) || Object.keys(block).sort().join() !== 'kind,required,text'
      || readable.get(block.kind as never) !== block.required || typeof block.text !== 'string' || !block.text.trim() || seen.has(block.kind)) return false
    seen.add(block.kind)
  }
  for (const kind of context.unreadable) {
    if (!readable.has(kind) || seen.has(kind)) return false
    seen.add(kind)
  }
  return true
}

export function validateEditorInlineInput(input: EditorInlineInput): EditorInlineInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['action', 'documentText', 'from', 'to', 'selectedText', 'instruction', 'annotations', 'filePath', 'chapterContext'].includes(key))
    || input.filePath !== undefined && (typeof input.filePath !== 'string' || !input.filePath)
    || !validInstruction(input) || typeof input.documentText !== 'string' || typeof input.selectedText !== 'string'
    || !Number.isSafeInteger(input.from) || !Number.isSafeInteger(input.to) || input.from < 0 || input.to <= input.from
    || input.to > input.documentText.length || input.documentText.slice(input.from, input.to) !== input.selectedText
    || !validAnnotations(input) || !validChapterContext(input)
    || Buffer.byteLength(input.documentText + (input.chapterContext?.blocks.map(block => block.text).join('') ?? ''), 'utf8') > 8 * 1024 * 1024) throw new Error('GENERATION_EDITOR_INPUT_INVALID')
  const { filePath, ...rest } = input
  return structuredClone(filePath === undefined ? rest : input)
}
const sentenceEnd = /(?:\r?\n\s*\r?\n|[。！？!?…][”’"'）)\]】」』]*|\.[”’"')\]]*(?=\s|$))/gu
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff
/** 选区前最后 maxChars 字，从其中第一个句末之后开始。 */
function textBefore(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text.trim()
  let tail = text.slice(-maxChars)
  if (isLowSurrogate(tail.charCodeAt(0))) tail = tail.slice(1)
  const boundary = new RegExp(sentenceEnd.source, 'u').exec(tail)
  return (boundary ? tail.slice(boundary.index + boundary[0].length).trim() : '') || tail.trim()
}
const cutMark = ['……（本章后面还有，这里只摘开头）', '… (the chapter goes on; only its opening is shown)'] as const
/** 选区后最前 maxChars 字，截到其中最后一个句末；截过就标明后面还有，免得模型把摘录末尾当成章末。 */
function textAfter(text: string, maxChars: number, english: boolean): string {
  if (text.trimEnd().length <= maxChars) return text.trim()
  let head = text.slice(0, maxChars)
  if (isLowSurrogate(text.charCodeAt(maxChars))) head = head.slice(0, -1)
  const end = [...head.matchAll(sentenceEnd)].at(-1)
  return `${(end ? head.slice(0, end.index + end[0].length).trim() : '') || head.trim()}
${cutMark[english ? 1 : 0]}`
}
function selectMaterials(context: EditorInlineContext, inputTokens: number): EditorInlineMaterials {
  const chapter = context.chapterContext
  const supplied = new Map(chapter?.blocks.map(block => [block.kind, block.text]))
  let included: EditorContextBlock[] = EDITOR_CONTEXT_PLAN[context.action].flatMap(entry => {
    const text = !('maxChars' in entry) ? supplied.get(entry.kind)
      : entry.kind === 'preceding' ? textBefore(context.documentText.slice(0, context.from), entry.maxChars) : textAfter(context.documentText.slice(context.to), entry.maxChars, context.writingLanguage === 'en-US')
    return text ? [{ kind: entry.kind, text, required: entry.required }] : []
  })
  const omitted: EditorContextOmission[] = (chapter?.unreadable ?? []).map(kind => ({ kind, reason: 'unreadable' }))
  const tokens = (blocks: EditorContextBlock[]) => estimateMaterialTokens(Buffer.byteLength(JSON.stringify(editorInlineTask({ ...context, materials: { included: blocks, omitted } }).messages), 'utf8'))
  for (const kind of EDITOR_CONTEXT_TRIM_ORDER) {
    if (tokens(included) <= inputTokens) break
    if (!included.some(block => block.kind === kind && !block.required)) continue
    included = included.filter(block => block.kind !== kind)
    omitted.push({ kind, reason: 'budget' })
  }
  return { included, omitted }
}
/**
 * 有章节上下文或是续写时按额度选一次材料；没有章号的续写只有前文和后文。
 * 重建时传回开跑时冻结的上下文，沿用它的材料（升级前的运行没有材料，照旧替换选区）。
 */
export function buildEditorInlineContext(input: EditorInlineInput, writingLanguage: WritingLanguage, template: PromptTemplate, inputTokens = Infinity,
  frozen?: Pick<EditorInlineContext, 'materials'>): EditorInlineContext {
  const valid = validateEditorInlineInput(input)
  if (template.key !== 'edit_selected_text' || typeof template.content !== 'string') throw new Error('GENERATION_EDITOR_TEMPLATE_INVALID')
  const context: EditorInlineContext = { ...valid, kind: 'author-draft', documentHash: textHash(valid.documentText), writingLanguage, template: structuredClone(template) }
  const materials = frozen ? frozen.materials && structuredClone(frozen.materials)
    : valid.chapterContext || valid.action === 'continue' ? selectMaterials(context, inputTokens) : undefined
  return materials ? { ...context, materials } : context
}
export function readEditorInlineContext(run: DurableGenerationRun): EditorInlineContext {
  const context = run.binding.sourceManifest.editorInlineContext as EditorInlineContext | undefined
  if (run.binding.sourceManifest.operation !== 'editor-inline' || !context
    || textHash(JSON.stringify(context)) !== run.binding.sourceManifest.editorInlineContextHash
    || textHash(context.documentText) !== context.documentHash) throw new Error('GENERATION_EDITOR_CONTEXT_INVALID')
  const input = validateEditorInlineInput(run.binding.sourceManifest.editorInlineInput as EditorInlineInput)
  const frozen = { action: context.action, documentText: context.documentText, from: context.from, to: context.to, selectedText: context.selectedText,
    ...(context.action === 'instruct' ? { instruction: context.instruction } : {}),
    ...(context.action === 'batch-instruct' ? { annotations: context.annotations } : {}),
    ...(context.filePath !== undefined ? { filePath: context.filePath } : {}),
    ...(context.chapterContext !== undefined ? { chapterContext: context.chapterContext } : {}) }
  if (!isDeepStrictEqual(input, frozen)) throw new Error('GENERATION_EDITOR_CONTEXT_INVALID')
  return structuredClone(context)
}
export function readEditorInlineTask(run: DurableGenerationRun): GenerationTask {
  readEditorInlineContext(run)
  const task = run.binding.sourceManifest.editorInlineTask as GenerationTask | undefined
  if (!task || textHash(JSON.stringify(task)) !== run.binding.sourceManifest.editorInlineTaskHash) throw new Error('GENERATION_EDITOR_TASK_INVALID')
  return structuredClone(task)
}
/** 同一段原文在章里出现不止一次时，批注针对的是第几处。 */
function occurrence(documentText: string, annotation: { from: number; selectedText: string }): { nth: number; total: number } | null {
  let total = 0, nth = 0
  for (let at = documentText.indexOf(annotation.selectedText); at !== -1; at = documentText.indexOf(annotation.selectedText, at + 1)) {
    total += 1
    if (at <= annotation.from) nth = total
  }
  return total > 1 ? { nth, total } : null
}
function editInstruction(context: EditorInlineContext, english: boolean): string {
  if (context.action === 'batch-instruct') {
    const annotations = context.annotations.map((annotation, index) => {
      const place = occurrence(context.documentText, annotation)
      const where = !place ? '' : english ? ` (occurrence ${place.nth} of ${place.total} in the chapter)` : `（全文第 ${place.nth} 处（共 ${place.total} 处））`
      return english
        ? `[Annotation ${index + 1}]\nOriginal passage${where}:\n${annotation.selectedText}\nAuthor note:\n${annotation.instruction}`
        : `【批注 ${index + 1}】\n对应原文${where}：\n${annotation.selectedText}\n作者意见：\n${annotation.instruction}`
    }).join('\n\n')
    return english
      ? `Revise the complete chapter according to every annotation below. Each note applies to its corresponding original passage. Keep passages without annotations unchanged unless a change is required for continuity.\n\n${annotations}`
      : `按下面的全部批注修改完整章节。每条意见只针对对应原文；未批注的内容保持原样，确为衔接所必需时除外。\n\n${annotations}`
  }
  if (inDocument(context)) return english ? 'Continue in the same form and style as the original text.' : '照原文的体裁和写法往下写。'
  if (context.action !== 'instruct') return instructions[context.action][english ? 1 : 0]
  return english
    ? `Revise this passage as the author's note asks. The note outranks every other preference.\n${context.instruction}`
    : `按作者意见修改这部分。作者意见优先于其他任何偏好。\n${context.instruction}`
}
/** 没有章号的续写（设定文档、恢复稿等）不预设是小说正文：指令、规则和材料标签都照原文体裁说。 */
const inDocument = (context: EditorInlineContext) => context.chapterContext === undefined && editorInlineInsertsAfterSelection(context)
const continueRule = ['这次是续写：选中的正文是续写的起点，保持原样。只输出紧接在它后面的新内容，第一句直接接着选中正文的最后一句往下写，不要重复、改写或总结选中的正文。',
  'This is a continuation: the selected prose is where it starts, and it stays as it is. Output only the new text that follows it, starting right where its last sentence ends; do not repeat, rewrite, or summarize the selected prose.'] as const
const holdRule = ['人物手里有什么、已经放下什么，以前文和选中正文为准，放下的东西不再拿回手里。',
  ' What the characters hold or have put down follows the earlier text and the selection; nothing already put down is picked up again.'] as const
const textNoun = (context: EditorInlineContext, english: boolean) => inDocument(context) ? (english ? 'document text' : '文档') : (english ? 'chapter text' : '本章正文')
/** 有后文的续写插在中间，后文第一句就是停止点；选区在末尾时没有。 */
function followingOpening(context: EditorInlineContext): string | undefined {
  const following = editorInlineInsertsAfterSelection(context) ? context.materials!.included.find(block => block.kind === 'following')?.text : undefined
  if (!following) return undefined
  const end = new RegExp(sentenceEnd.source, 'u').exec(following)
  return (end ? following.slice(0, end.index + end[0].length) : following).trim()
}
function followingRule(first: string, english: boolean, noun: string): string {
  return english
    ? `The ${noun} after the selection (the following text) is settled, and the continuation is inserted between the selection and it; the following text comes right after the continuation. Its first sentence is "${first}". Stop before that sentence: do not write it or what it describes, and when the continuation ends, where the characters are and who is present must be as they are just before it. Everything the following text describes, including its dialogue, and every event or hook in the chapter plan that the following text has not reached, happens in or after the following text: write none of it early, let no one say its lines first, and do not move anyone to a place the following text reaches later. Expand only the moment the selection ends on: small actions, what is seen and heard, unspoken reactions; no change of place, no new people or objects. Make it about as long as the selection: more than a sentence or two, but no more than twice its length. Do not contradict the following text or repeat its sentences.`
    : `选中正文之后的${noun}（后文）已经写定，续写插在选中正文和后文之间，后文紧跟在续写后面。后文第一句是「${first}」。续写停在这句之前：不要写出这句，也不要写它说的事；续写结束时，人物在哪里、谁在场，都要和这句发生之前一样。后文里写到的事、对话、地方和细节，以及本章蓝图里后文还没写到的事件和悬念，都发生在后文里或后文之后：续写里一件也不提前写，后文里的话不让人物先说，也不要让人物走到后文才到的地方。续写只展开选中正文结尾那一刻：动作的细处、看到听到的、人物没说出口的反应；不换地方，不让新的人或东西出场。篇幅和选中正文相当，不要只写一两句，也不超过它的两倍。不能与后文矛盾，也不要重复后文的句子。`
}
function systemRole(context: EditorInlineContext): Pick<PromptTemplate, 'systemRole'> {
  const english = context.writingLanguage === 'en-US'
  if (editorInlineInsertsAfterSelection(context)) {
    const first = followingOpening(context)
    const rule = continueRule[english ? 1 : 0] + (inDocument(context) ? '' : holdRule[english ? 1 : 0])
    return { systemRole: [context.template.systemRole?.trim(), rule, first && followingRule(first, english, textNoun(context, english))].filter(Boolean).join('\n') }
  }
  if (context.action !== 'instruct' && context.action !== 'batch-instruct') return context.template
  const noteRule = english
    ? "The author's note is itself the newest explicit author fact. Where the note conflicts with the preservation requirements above, or with the explicit-facts clause of the contract below, follow the note; keep everything the note does not mention."
    : '作者这次的批注意见本身就是最新的作者明确事实。意见与上述保留要求冲突时，或与下文合同里「作者与项目的明确事实」那一条冲突时，以作者意见为准；意见没提到的部分照常保留。'
  const batchRule = context.action === 'batch-instruct'
    ? english
      ? 'The selected prose below is the complete chapter. Apply all annotations in one pass and output only the complete revised chapter, never only the annotated passages.'
      : '下文选中的正文是完整章节。请一次性落实所有批注，并且只输出修改后的完整章节，不能只输出被批注的片段。'
    : ''
  return { systemRole: [context.template.systemRole?.trim(), noteRule, batchRule].filter(Boolean).join('\n') }
}
const materialLabels: Record<EditorContextKind, readonly [string, string]> = {
  style: ['【文风、视角与全局要求】', '[Style, point of view, and global requirements]'],
  blueprint: ['【本章蓝图】', '[Chapter plan]'],
  characters: ['【出场人物（截至本章）】', '[Characters as of this chapter]'],
  threads: ['【相关活跃线索（截至本章）】', '[Relevant active threads as of this chapter]'],
  'previous-ending': ['【上一章结尾】', '[End of the previous chapter]'],
  preceding: ['【选中正文之前的本章正文】', '[Chapter text before the selection]'],
  following: ['【选中正文之后的本章正文】', '[Chapter text after the selection]'],
}
const documentLabels: Partial<typeof materialLabels> = {
  preceding: ['【选中正文之前的文档】', '[Document text before the selection]'],
  following: ['【选中正文之后的文档】', '[Document text after the selection]'],
}
function materialsText(context: EditorInlineContext, materials: EditorInlineMaterials, english: boolean): string {
  if (!materials.included.length) return ''
  const document = inDocument(context)
  const header = english ? `[${document ? 'Document' : 'Chapter'} context: reference only, so the result fits what comes before and after. Do not repeat or rewrite it.]`
    : `【${document ? '文档' : '本章'}上下文：只作参考，让结果接得上前因后果；不要复述，也不要改写这些内容】`
  return [header, ...materials.included.map(block => `${((document && documentLabels[block.kind]) || materialLabels[block.kind])[english ? 1 : 0]}\n${block.text}`)].join('\n\n')
}
export function editorInlineTask(context: EditorInlineContext): GenerationTask {
  const { template, writingLanguage } = context
  const english = writingLanguage === 'en-US'
  const prompt = renderPrompt(template, { edit_instruction: editInstruction(context, english), selected_text: context.selectedText }, writingLanguage)
  const materials = context.materials ? materialsText(context, context.materials, english) : ''
  const first = followingOpening(context)
  const stop = !first ? '' : english
    ? `\n\n(Reminder: the continuation stops before the following text's first sentence, "${first}". Stay in the same place, write nothing the following text or the chapter plan has later, and keep it to one or two paragraphs, no more than twice the selection's length.)`
    : `\n\n（提醒：续写停在后文第一句「${first}」之前。不换地方，不写后文和蓝图里后面的事；写一到两段，不超过选中正文的两倍长。）`
  return { purpose: `editor-ai-${context.action}`, reasoningStage: context.action === 'refine' ? 'review' : 'drafting', output: 'visible-text', messages: [
    { role: 'system', content: composePromptSystemRole(systemRole(context), writingLanguage) },
    { role: 'user', content: (materials ? `${materials}\n\n${prompt}` : prompt) + stop },
  ] }
}
