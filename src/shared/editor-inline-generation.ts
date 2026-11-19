import type { MainGenerationRunHandle, MainGenerationRunView, MainGenerationExecuteReceipt } from '../services/generation/generation-runtime'
import type { PromptTemplate } from '../services/builtin-prompt-templates'
import type { WritingLanguage } from './writing-language'

/** 上限按码点计，不是 UTF-16 单元。 */
export const EDITOR_INLINE_INSTRUCTION_MAX_LENGTH = 2000
export const EDITOR_INLINE_ANNOTATION_MAX_COUNT = 100
export type EditorInlineFixedAction = 'refine' | 'expand' | 'continue' | 'dialogue'
export type EditorInlineAnnotation = {
  id: string
  from: number
  to: number
  selectedText: string
  instruction: string
}
export type EditorInlineRequest = { action: EditorInlineFixedAction }
  | { action: 'instruct'; instruction: string }
  | { action: 'batch-instruct'; annotations: EditorInlineAnnotation[] }
/** 渲染层从库里读的块。 */
export type EditorContextReadKind = 'style' | 'blueprint' | 'characters' | 'threads' | 'previous-ending'
/** 主进程从冻结的正文里切的块。 */
export type EditorContextDocumentKind = 'preceding' | 'following'
export type EditorContextKind = EditorContextReadKind | EditorContextDocumentKind
export type EditorContextBlock = { kind: EditorContextKind; text: string; required: boolean }
type EditorContextPlanEntry = { kind: EditorContextReadKind; required: boolean } | { kind: EditorContextDocumentKind; required: true; maxChars: number }

/** 每个工具带哪些块，按发给模型的顺序排。 */
export const EDITOR_CONTEXT_PLAN: Readonly<Record<EditorInlineRequest['action'], readonly EditorContextPlanEntry[]>> = (() => {
  const style = { kind: 'style', required: true } as const
  const blueprint = { kind: 'blueprint', required: true } as const
  const characters = { kind: 'characters', required: false } as const
  const threads = { kind: 'threads', required: false } as const
  const near = [{ kind: 'preceding', required: true, maxChars: 500 }, { kind: 'following', required: true, maxChars: 500 }] as const
  return {
    refine: [style, ...near],
    expand: [style, blueprint, characters, ...near],
    instruct: [style, blueprint, characters, ...near],
    dialogue: [style, blueprint, { kind: 'characters', required: true }, ...near],
    continue: [style, blueprint, characters, threads, { kind: 'previous-ending', required: false },
      { kind: 'preceding', required: true, maxChars: 3000 }, { kind: 'following', required: true, maxChars: 600 }],
    'batch-instruct': [style, blueprint, characters, threads],
  }
})()
/** 窗口不够时可选块被裁的先后。 */
export const EDITOR_CONTEXT_TRIM_ORDER: readonly EditorContextReadKind[] = ['previous-ending', 'threads', 'characters']
/** 选区前的正文短于这个字数时，续写才去读上一章结尾。 */
export const EDITOR_CONTEXT_PREVIOUS_ENDING_BELOW = 800

/** 章内编辑时渲染层备好的候选块；架构文档、恢复稿和升级前的运行没有。 */
export type EditorInlineChapterContext = {
  version: 1
  chapterNumber: number
  blocks: EditorContextBlock[]
  /** 读不出而略去的块。 */
  unreadable: EditorContextReadKind[]
}
export type EditorContextOmission = { kind: EditorContextKind; reason: 'budget' | 'unreadable' }
/** 主进程开跑时选定并冻结的材料，重建时原样沿用。 */
export type EditorInlineMaterials = { included: EditorContextBlock[]; omitted: EditorContextOmission[] }

export type EditorInlineInput = EditorInlineRequest & {
  documentText: string
  from: number
  to: number
  selectedText: string
  /** 发起时所在稿的 filePath；升级前的运行没有。 */
  filePath?: string
  chapterContext?: EditorInlineChapterContext
}
export type EditorInlineContext = EditorInlineInput & {
  kind: 'author-draft'
  documentHash: string
  writingLanguage: WritingLanguage
  template: PromptTemplate
  materials?: EditorInlineMaterials
}
/** 带本章材料的续写只输出接续的新内容，接受时插在选区之后；其余情况替换选区。 */
export const editorInlineInsertsAfterSelection = (context: Pick<EditorInlineContext, 'action' | 'materials'>) =>
  context.action === 'continue' && context.materials !== undefined
export interface EditorInlineRecovery {
  view: MainGenerationRunView
  modelId: string
  context: EditorInlineContext
  sourceStatus: 'current' | 'conflict'
}
export interface EditorInlineGenerationChannels {
  'editor-inline:begin': { args: [{ input: EditorInlineInput; modelId: string; uiActionNonce: string }]; return: EditorInlineRecovery }
  'editor-inline:read-recovery': { args: [{ handle: MainGenerationRunHandle }]; return: EditorInlineRecovery }
  'editor-inline:execute': { args: [{ handle: MainGenerationRunHandle }]; return: MainGenerationExecuteReceipt }
  'editor-inline:cancel': { args: [{ handle: MainGenerationRunHandle }]; return: MainGenerationRunView }
  /** 气泡把这次的建议显示给作者了；之后运行侧页不再列出它。 */
  'editor-inline:delivered': { args: [{ handle: MainGenerationRunHandle }]; return: void }
}
