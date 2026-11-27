import type { ModelProfile, ProjectSessionContext } from '../../shared/ipc-channels'
import type { Locale } from '../../i18n/types'
import { isProjectSessionCurrent } from '../../components/project-session-gate'
import { useLLMStore } from '../../stores/llm-store'
import { currentInterfaceLocale, useLocaleStore } from '../../stores/locale-store'
import { failureText, reasonOf } from '../../i18n/app-errors'
import { useWorkflowStore, workflowResourceConflictMessage } from '../../stores/workflow-store'
import { readWritableChapters, type WritableChapters } from '../authoritative-chapter-sequence'
import { readConsistencyPreflight, type ConsistencyPreflightResult } from '../consistency-preflight'
import { ipc } from '../ipc-client'
import { guardChapterWriting } from '../workflow-guards'
import type { ChapterWritePrefill } from '../../stores/layout-store'
import { createChapterWorkflow } from './chapter-workflow'
import type { ChapterBlueprint } from './directory-workflow'
import {
  createChapterInfoFromDialogInput,
  DEFAULT_CHAPTER_WORDS_TARGET,
  normalizeChapterWordsTarget,
} from './chapter-creation-parameters'

/** 写作一章的表单值：写作弹层只改指导与检索关键词，其余取自蓝图。 */
export interface ChapterWriteForm {
  chapterNumber: number | ''
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: string
  userGuidance: string
  knowledgeHint: string
  wordsTarget: number | ''
}

export function isGenerationModel(model: ModelProfile): boolean {
  return model.purposes.includes('generation')
}

export function availableGenerationModelId(
  models: ModelProfile[],
  modelId: string | null | undefined,
): string | null {
  return modelId && models.some(model => model.id === modelId && isGenerationModel(model))
    ? modelId
    : null
}

export function preferredGenerationModelId(models: ModelProfile[], defaultModelId: string | null): string | null {
  return availableGenerationModelId(models, defaultModelId)
    ?? models.find(isGenerationModel)?.id
    ?? null
}

export function chapterDefaultWordsTarget(wordsPerChapter: number | undefined): number {
  return normalizeChapterWordsTarget(wordsPerChapter, DEFAULT_CHAPTER_WORDS_TARGET)
}

/** 蓝图里交给写作的字段；出场人物以顿号连接，启动时再按顿号或逗号拆开。 */
export function blueprintWritePrefill(blueprint: ChapterBlueprint): ChapterWritePrefill {
  return {
    title: blueprint.title,
    role: blueprint.role,
    purpose: blueprint.purpose,
    keyEvents: blueprint.keyEvents,
    characters: blueprint.characters.join('、'),
    userGuidance: blueprint.userGuidance || '',
  }
}

/** 从章节蓝图「写作此章」带来的预填参数换成表单值；目标字数取设定里的每章字数，检索关键词留空。 */
export function chapterWriteFormFromPrefill(prefill: Record<string, unknown>, defaultWordsTarget: number): ChapterWriteForm {
  return {
    chapterNumber: Number(prefill.chapterNumber) || 1,
    title: String(prefill.title || ''),
    role: String(prefill.role ?? '发展'),
    purpose: String(prefill.purpose || ''),
    keyEvents: String(prefill.keyEvents || ''),
    characters: String(prefill.characters || ''),
    userGuidance: String(prefill.userGuidance || ''),
    knowledgeHint: '',
    wordsTarget: defaultWordsTarget,
  }
}

export function generationModelError(models: ModelProfile[], selectedModelId: string | null, text: (zh: string, en: string) => string): string | null {
  if (!models.some(isGenerationModel)) {
    return text(
      '没有已配置且可用于文本生成的模型。请在设置中添加或启用一项生成模型。',
      'No configured model can generate text. Add or enable a generation model in Settings.',
    )
  }
  return availableGenerationModelId(models, selectedModelId)
    ? null
    : text(
      '所选创作模型已不可用。请选择一项可用于文本生成的模型后再试。',
      'The selected writing model is no longer available. Select a compatible generation model and try again.',
    )
}

export interface ChapterWriteLaunch {
  session: ProjectSessionContext
  form: ChapterWriteForm
  /** 作者选的本次模型；为空时取默认生成模型。 */
  generationModelId: string | null
  /** 设定里的每章字数，表单字数无效时回退到它。 */
  wordsPerChapter: number | undefined
  /** 一致性预检提醒「仅本次忽略」后重新开始。 */
  ignoreFindingsOnce: boolean
  locale: Locale
}

/** message 都是按文案语言写好、可以直接给作者看的句子。 */
export type ChapterWriteOutcome =
  /** 项目已切换，什么也不做。 */
  | { kind: 'stale' }
  /** 读不出权威定稿序列，不能确定下一章。 */
  | { kind: 'authority-error'; message: string }
  /** 模型、章号、前置条件或资源冲突不满足，写明原因。 */
  | { kind: 'blocked'; message: string }
  /** 上一章还在整理，稍后就能写，不是出错。 */
  | { kind: 'pending'; message: string }
  /** 一致性预检发现线索，等作者处理；exemptions 一并返回供撤销。 */
  | { kind: 'preflight'; preflight: ConsistencyPreflightResult }
  | { kind: 'started' }

/**
 * 启动单章写作工作流，写作弹层走这里。
 */
export async function launchChapterWrite({
  session, form, generationModelId, wordsPerChapter, ignoreFindingsOnce, locale,
}: ChapterWriteLaunch): Promise<ChapterWriteOutcome> {
  const text = useLocaleStore.getState().text
  const addLog = useWorkflowStore.getState().addLog
  const projectPath = session.projectPath
  const modelError = generationModelError(useLLMStore.getState().models, generationModelId, text)
  if (modelError) {
    addLog('error', modelError)
    return { kind: 'blocked', message: modelError }
  }
  const unavailableModel = text(
    '所选创作模型已不可用。请选择一项可用于文本生成的模型后再试。',
    'The selected writing model is no longer available. Select a compatible generation model and try again.',
  )

  const targetChapter = Number(form.chapterNumber) || 1
  let chapters: WritableChapters
  try {
    chapters = await readWritableChapters(session, locale)
  } catch (error) {
    if (!isProjectSessionCurrent(session)) return { kind: 'stale' }
    return { kind: 'authority-error', message: failureText(currentInterfaceLocale(), reasonOf(error)) }
  }
  if (!isProjectSessionCurrent(session)) return { kind: 'stale' }
  if (!chapters.writable.includes(targetChapter)) {
    return { kind: 'blocked', message: text(
      `第 ${targetChapter} 章现在还不能写。现在可以写第 ${chapters.writable.join('、')} 章，从蓝图进入。`,
      `Chapter ${targetChapter} cannot be written yet. You can write ${chapters.writable.length === 1 ? 'Chapter' : 'Chapters'} ${chapters.writable.join(', ')} now; ${chapters.writable.length === 1 ? 'open its blueprint' : 'open a blueprint for one of them'}.`,
    ) }
  }

  // 前置校验：章节蓝图是否已生成，以及（若篇章>1）前一章是否已定稿
  const guard = await guardChapterWriting(targetChapter, projectPath, session)
  if (!isProjectSessionCurrent(session)) return { kind: 'stale' }
  if (!availableGenerationModelId(useLLMStore.getState().models, generationModelId)) {
    return { kind: 'blocked', message: unavailableModel }
  }
  if (!guard.ok) {
    return { kind: guard.pending ? 'pending' : 'blocked', message: guard.message || text('前置条件未满足', 'Prerequisites are not met.') }
  }

  if (!ignoreFindingsOnce) {
    try {
      const persisted = await ipc.invokeWithProjectSession(session, 'db:blueprint-get', targetChapter, projectPath)
      const preflight = await readConsistencyPreflight(session, [{
        chapterNumber: targetChapter,
        title: form.title,
        role: form.role,
        purpose: form.purpose,
        keyEvents: form.keyEvents,
        characters: form.characters.split(/[、,，]/u).map(value => value.trim()).filter(Boolean),
        suspenseHook: persisted?.suspenseHook ?? '',
        userGuidance: form.userGuidance,
        notes: persisted?.notes ?? '',
      }])
      if (!isProjectSessionCurrent(session)) return { kind: 'stale' }
      if (preflight.findings.length > 0) return { kind: 'preflight', preflight }
    } catch {
      if (!isProjectSessionCurrent(session)) return { kind: 'stale' }
      addLog('info', text(
        '一致性证据暂时不可用；本次创作仍会继续。',
        'Continuity evidence is temporarily unavailable; writing will continue.',
      ))
    }
  }

  const wordsTarget = normalizeChapterWordsTarget(form.wordsTarget, wordsPerChapter)
  const frozenGenerationModelId = availableGenerationModelId(useLLMStore.getState().models, generationModelId)
  if (!frozenGenerationModelId) return { kind: 'blocked', message: unavailableModel }

  const workflow = createChapterWorkflow(createChapterInfoFromDialogInput({
    projectPath,
    chapterNumber: form.chapterNumber,
    title: form.title,
    role: form.role,
    purpose: form.purpose,
    keyEvents: form.keyEvents,
    characters: form.characters,
    userGuidance: form.userGuidance,
    knowledgeQueryHint: form.knowledgeHint,
    wordsTarget,
    defaultWordsTarget: wordsPerChapter ?? DEFAULT_CHAPTER_WORDS_TARGET,
  }), session, { generationModelId: frozenGenerationModelId })

  if (!isProjectSessionCurrent(session)) return { kind: 'stale' }
  const resourceConflict = useWorkflowStore.getState().getResourceConflict(workflow)
  if (resourceConflict) {
    return { kind: 'blocked', message: workflowResourceConflictMessage(locale, resourceConflict.title) }
  }
  void useWorkflowStore.getState().startWorkflow(workflow, false)
  return { kind: 'started' }
}
