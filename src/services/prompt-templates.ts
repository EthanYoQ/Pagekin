import type { ProjectSessionContext } from '../shared/ipc-channels'
import { resolveWritingLanguage, type WritingLanguage } from '../shared/writing-language'
import { getActiveProjectSessionContext } from '../shared/project-session-context'
import { PromptCatalog, ipcPromptPersistence } from './prompt-catalog'
import { BUILTIN_PROMPTS, getBuiltinPromptTemplate, type PromptTemplate } from './builtin-prompt-templates'
export * from './builtin-prompt-templates'

export const promptCatalog = new PromptCatalog(
  BUILTIN_PROMPTS,
  ipcPromptPersistence,
  getActiveProjectSessionContext,
)

export function clearProjectCustomPrompts(): void {
  promptCatalog.clearProject()
}

export async function loadCustomPrompts(writingLanguage: WritingLanguage = 'zh-CN'): Promise<void> {
  await promptCatalog.list(undefined, writingLanguage)
}

export async function loadProjectCustomPrompts(
  projectSession: ProjectSessionContext,
  writingLanguage: WritingLanguage = 'zh-CN',
): Promise<boolean> {
  return promptCatalog.loadProject(projectSession, writingLanguage)
}

export function getPromptTemplate(
  key: string,
  projectSession?: ProjectSessionContext,
  writingLanguage: WritingLanguage = 'zh-CN',
): PromptTemplate | undefined {
  const resolved = promptCatalog.peek(key, projectSession, resolveWritingLanguage(writingLanguage))
  if (!resolved || resolved.source === 'builtin') return getBuiltinPromptTemplate(key, writingLanguage)
  return resolved.template
}

export async function resolvePromptTemplate(
  key: string,
  projectSession: ProjectSessionContext | undefined,
  writingLanguage: WritingLanguage,
): Promise<PromptTemplate | undefined> {
  const language = resolveWritingLanguage(writingLanguage)
  const resolved = await promptCatalog.resolve(key, projectSession, language)
  if (!resolved) return undefined
  return resolved.source === 'builtin'
    ? getBuiltinPromptTemplate(key, writingLanguage)
    : resolved.template
}

export function getPromptSource(
  key: string,
  projectSession?: ProjectSessionContext,
  writingLanguage: WritingLanguage = 'zh-CN',
): 'builtin' | 'global' | 'project' {
  return promptCatalog.peek(key, projectSession, resolveWritingLanguage(writingLanguage))?.source ?? 'builtin'
}

export function getAllPromptTemplates(
  projectSession?: ProjectSessionContext,
  writingLanguage: WritingLanguage = 'zh-CN',
): PromptTemplate[] {
  return BUILTIN_PROMPTS.map((template) => (
    getPromptTemplate(template.key, projectSession, writingLanguage) ?? template
  ))
}

export async function saveCustomPrompt(template: PromptTemplate): Promise<boolean> {
  return promptCatalog.commit({ action: 'save', scope: 'global', template })
}

export async function saveProjectCustomPrompt(
  projectSession: ProjectSessionContext,
  template: PromptTemplate,
): Promise<boolean> {
  return promptCatalog.commit({ action: 'save', scope: 'project', projectSession, template })
}

export async function deleteCustomPrompt(
  key: string,
  writingLanguage: WritingLanguage = 'zh-CN',
): Promise<boolean> {
  return promptCatalog.commit({ action: 'delete', scope: 'global', key, writingLanguage })
}

export async function deleteProjectCustomPrompt(
  projectSession: ProjectSessionContext,
  key: string,
  writingLanguage: WritingLanguage = 'zh-CN',
): Promise<boolean> {
  return promptCatalog.commit({ action: 'delete', scope: 'project', projectSession, key, writingLanguage })
}

export { appendRequiredPromptContext, renderPromptTaskGuidance, renderPrompt } from '../shared/render-prompt'
