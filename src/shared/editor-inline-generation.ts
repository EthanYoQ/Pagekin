import type { MainGenerationRunHandle, MainGenerationRunView, MainGenerationExecuteReceipt } from '../services/generation/generation-runtime'
import type { PromptTemplate } from '../services/builtin-prompt-templates'
import type { WritingLanguage } from './writing-language'

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
export type EditorContextReadKind = 'style' | 'blueprint' | 'characters' | 'threads' | 'previous-ending'
export type EditorContextDocumentKind = 'preceding' | 'following'
export type EditorContextKind = EditorContextReadKind | EditorContextDocumentKind
export type EditorContextBlock = { kind: EditorContextKind; text: string; required: boolean }
type EditorContextPlanEntry = { kind: EditorContextReadKind; required: boolean } | { kind: EditorContextDocumentKind; required: true; maxChars: number }

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
export const EDITOR_CONTEXT_TRIM_ORDER: readonly EditorContextReadKind[] = ['previous-ending', 'threads', 'characters']
export const EDITOR_CONTEXT_PREVIOUS_ENDING_BELOW = 800

export type EditorInlineChapterContext = {
  version: 1
  chapterNumber: number
  blocks: EditorContextBlock[]
  unreadable: EditorContextReadKind[]
}
export type EditorContextOmission = { kind: EditorContextKind; reason: 'budget' | 'unreadable' }
export type EditorInlineMaterials = { included: EditorContextBlock[]; omitted: EditorContextOmission[] }

export type EditorInlineInput = EditorInlineRequest & {
  documentText: string
  from: number
  to: number
  selectedText: string
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
  'editor-inline:delivered': { args: [{ handle: MainGenerationRunHandle }]; return: void }
}
