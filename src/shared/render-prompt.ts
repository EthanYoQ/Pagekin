import { getBuiltinPromptTemplate, getPromptVariableDescription, pruneEmptyOptionalPromptSections, type PromptTemplate } from '../services/builtin-prompt-templates'
import type { WritingLanguage } from './writing-language'

export function appendRequiredPromptContext(
  content: string,
  template: PromptTemplate,
  variables: Record<string, string>,
  writingLanguage: WritingLanguage,
): string {
  const builtinTemplate = getBuiltinPromptTemplate(template.key, writingLanguage)
  const referencedSources = [
    template.content,
    template.taskGuidance ?? '',
    builtinTemplate?.systemSuffix ?? '',
  ]
  const requiredContext = (builtinTemplate?.requiredContextVariables ?? [])
    .filter(key => !referencedSources.some(source => source.includes(`{{${key}}}`)))
    .flatMap((key) => {
      const value = variables[key]?.trim()
      if (!value || !builtinTemplate) return []
      return [`${getPromptVariableDescription(builtinTemplate, key, writingLanguage)}:\n${value}`]
    })
  if (requiredContext.length === 0) return content
  const heading = writingLanguage === 'en-US'
    ? '[Authoritative project context omitted by the custom template — must still be followed]'
    : '【自定义模板未引用但仍必须遵循的权威项目设定】'
  return `${content}\n\n${heading}\n${requiredContext.join('\n\n')}`
}

function fillVariables(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) => Object.hasOwn(variables, key) ? variables[key] : placeholder)
}

export function renderPromptTaskGuidance(
  template: Pick<PromptTemplate, 'taskGuidance'>,
  variables: Record<string, string>,
  writingLanguage: WritingLanguage,
): string {
  if (!template.taskGuidance?.trim()) return ''
  const guidance = fillVariables(template.taskGuidance, variables)
  const heading = writingLanguage === 'en-US'
    ? '[User-defined creative guidance]'
    : '【用户自定义创作指导】'
  return `${heading}\n${guidance.trim()}`
}

export function renderPrompt(
  template: PromptTemplate,
  variables: Record<string, string>,
  writingLanguage: WritingLanguage,
): string {
  let content = fillVariables(template.content, variables)

  const taskGuidance = renderPromptTaskGuidance(template, variables, writingLanguage)
  if (taskGuidance) content += `\n\n${taskGuidance}`

  const builtinTemplate = getBuiltinPromptTemplate(template.key, writingLanguage)
  const suffix = builtinTemplate?.systemSuffix
  if (suffix) {
    content = content + '\n\n' + fillVariables(suffix, variables)
  }

  return pruneEmptyOptionalPromptSections(
    appendRequiredPromptContext(content, template, variables, writingLanguage),
  )
}
