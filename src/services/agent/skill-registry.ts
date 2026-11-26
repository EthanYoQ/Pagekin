import { getBuiltinWritingSkills } from '../../shared/builtin-writing-skills'
import { CANONICAL_PROJECT_DIRECTORY } from '../../shared/project-format'

import { ipc } from '../ipc-client'
import { ignoreFailure } from '../../shared/ignore-failure'
import { useProjectStore } from '../../stores/project-store'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from '../../shared/project-session-context'
import { toolRegistry, type AgentExecutionContext, type AgentTool } from './tool-registry'
import type { WritingLanguage } from '../../shared/writing-language'
import {
  inspectInstalledWritingSkill,
  inspectWritingSkillMarkdown,
  type InstalledWritingSkillBundle,
  type WritingSkillInspection,
  type WritingSkillSource,
} from '../../shared/writing-skills'

export type SkillSource = WritingSkillSource

export interface SkillMetadata {
  name: string
  displayName?: string
  description: string
  whenToUse?: string
  version?: string
  allowedTools?: string[]
  argumentHint?: string
  userInvocable?: boolean
}

export interface LoadedSkill {
  metadata: SkillMetadata
  content: string
  source: SkillSource
  baseDir: string
  filePath: string
  projectSession?: ProjectSessionContext
  skillId: string
  writingSkill: WritingSkillInspection
  localizedContent?: Partial<Record<WritingLanguage, string>>
}

function isMissingProjectSkillDirectory(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined
  if (code === 'ENOENT' || code === 'SECURE_FS_NOT_FOUND') return true
  const message = error instanceof Error ? error.message : ''
  return /(?:^|:\s)(?:SECURE_FS_NOT_FOUND|PROJECT_FILE_NOT_FOUND$|ENOENT: no such file or directory(?:,|$))/.test(message)
}

class SkillRegistryImpl {
  private skills: Map<string, LoadedSkill> = new Map()
  private loadTail: Promise<void> = Promise.resolve()

  register(skill: LoadedSkill): void {
    this.skills.set(skill.skillId, skill)
  }

  get(name: string): LoadedSkill | undefined {
    return this.listAll().find(skill => skill.metadata.name === name)
  }

  getById(skillId: string): LoadedSkill | undefined {
    return this.skills.get(skillId)
  }

  listAll(): LoadedSkill[] {
    return Array.from(this.skills.values())
  }

  listBySource(source: SkillSource): LoadedSkill[] {
    return this.listAll().filter(s => s.source === source)
  }

  get size(): number {
    return this.skills.size
  }

  clear(): void {
    this.skills.clear()
  }

  private async loadUserSkills(target: Map<string, LoadedSkill>): Promise<number> {
    let count = 0
    await ignoreFailure('user skills unavailable', async () => {
      const entries = await ipc.invoke('skills:list-user')
      for (const entry of entries) {
        const skill = parseSkillMd(entry.content, entry.name, 'user', entry.baseDir, entry.filePath, undefined, entry.bundle)
        if (!skill) continue
        target.set(skill.skillId, skill)
        count++
      }
    })
    return count
  }

  private async loadProjectSkills(
    dir: string,
    projectPath: string,
    projectSession: ProjectSessionContext,
    target: Map<string, LoadedSkill>,
  ): Promise<number> {
    let count = 0
    const exists = await ipc.invokeWithProjectSession(
      projectSession,
      'fs:check-exists',
      dir,
      projectPath,
    )
    if (
      !sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )
    ) return count
    if (!exists) return count

    let entries
    try {
      entries = await ipc.invokeWithProjectSession(
        projectSession,
        'fs:list-dir',
        dir,
        projectPath,
      )
    } catch (error) {
      if (isMissingProjectSkillDirectory(error)) return count
      throw error
    }
    if (
      !sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )
    ) return count
    for (const entry of entries) {
      if (
        !sameProjectSessionContext(
          projectSession,
          projectSessionContextFromProject(useProjectStore.getState().currentProject),
        )
      ) return count
      if (!entry.isDir) continue

      const skillFile = `${entry.path}/SKILL.md`
      const outcome = await ignoreFailure(`project skill unavailable: ${skillFile}`, async () => {
        const result = await ipc.invokeWithProjectSession(
          projectSession,
          'fs:read-file',
          skillFile,
          projectPath,
        )
        if (
          !sameProjectSessionContext(
            projectSession,
            projectSessionContextFromProject(useProjectStore.getState().currentProject),
          )
        ) return 'project-changed'
        if (!result.success) return

        const skill = parseSkillMd(
          result.content,
          entry.name,
          'project',
          entry.path,
          skillFile,
          projectSession,
        )
        if (skill) {
          target.set(skill.skillId, skill)
          count++
        }
      })
      if (outcome === 'project-changed') return count
    }
    return count
  }

  loadAll(): Promise<void> {
    const load = this.loadTail.then(() => this.loadAllAtomic())
    this.loadTail = load.catch(() => undefined)
    return load
  }

  private async loadAllAtomic(): Promise<void> {
    const projectSession = projectSessionContextFromProject(
      useProjectStore.getState().currentProject,
    )
    const staged = new Map<string, LoadedSkill>()

    registerBuiltinSkills({ register: skill => staged.set(skill.skillId, skill) })

    const userCount = await this.loadUserSkills(staged)
    if (userCount > 0) {
      console.log(`[Skills] 加载了 ${userCount} 个用户 Skill`)
    }

    if (
      ipc.isElectron
      && projectSession
      && sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )
    ) {
      const projectSkillsDir = `${projectSession.projectPath}/${CANONICAL_PROJECT_DIRECTORY}/skills`
      const projectCount = await this.loadProjectSkills(
        projectSkillsDir,
        projectSession.projectPath,
        projectSession,
        staged,
      )
      if (projectCount > 0) {
        console.log(`[Skills] 加载了 ${projectCount} 个项目 Skill`)
      }
    }

    this.skills = staged
    this.registerToToolRegistry()

    console.log(`[Skills] 共加载 ${this.size} 个 Skill`)
  }

  private registerToToolRegistry(): void {
    toolRegistry.unregisterBySource('skill')

    for (const skill of this.listAll()) {
      if (skill.source !== 'builtin') continue
      const agentTool: AgentTool = {
        name: `skill__${skill.metadata.name}`,
        description: skill.metadata.description + (skill.metadata.whenToUse ? ` — ${skill.metadata.whenToUse}` : ''),
        descriptionEn: skill.writingSkill.metadata.description,
        source: 'skill',
        inputSchema: {
          type: 'object',
          properties: {
            args: {
              type: 'string',
              description: skill.metadata.argumentHint ?? '可选的参数',
              descriptionEn: 'Optional arguments',
            },
          },
        },
        requiresConfirmation: false,
        isReadOnly: true,
        userFacingName: skill.metadata.displayName ?? skill.metadata.name,
        execute: async (toolArgs, context?: AgentExecutionContext) => {
          if (
            skill.projectSession
            && !sameProjectSessionContext(skill.projectSession, context?.projectSession)
          ) {
            return {
              success: false,
              content: '',
              error: '项目 Skill 的加载会话已失效，请重新加载当前项目 Skill',
            }
          }
          const userArgs = (toolArgs.args as string) ?? ''
          const writingLanguage = context?.writingLanguage ?? 'zh-CN'
          let content = skill.localizedContent?.[writingLanguage] ?? skill.content
          if (userArgs) {
            content = content.replace(/\$\{args\}/g, userArgs)
            content = content.replace(/\$1/g, userArgs)
          }
          content = content.replace(/\$\{SKILL_DIR\}/g, skill.baseDir)

          return {
            success: true,
            content: `[Skill: ${writingLanguage === 'en-US'
              ? (skill.writingSkill.metadata.displayName ?? skill.metadata.name)
              : (skill.metadata.displayName ?? skill.metadata.name)}]\n\n${content}`,
          }
        },
      }
      toolRegistry.register(agentTool)
    }
  }
}

export const skillRegistry = new SkillRegistryImpl()

export function parseSkillMd(
  raw: string,
  fallbackName: string,
  source: SkillSource,
  baseDir: string,
  filePath: string,
  projectSession?: ProjectSessionContext,
  bundle: InstalledWritingSkillBundle = { status: 'none' },
): LoadedSkill | null {
  const writingSkill = inspectInstalledWritingSkill(raw, bundle, fallbackName)
  const inspectedName = writingSkill.metadata.name === 'unnamed-writing-skill'
    ? fallbackName
    : writingSkill.metadata.name
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(inspectedName)) return null
  const metadata: SkillMetadata = {
    name: inspectedName,
    displayName: writingSkill.metadata.displayName,
    description: writingSkill.metadata.description || `Skill: ${fallbackName}`,
    version: writingSkill.metadata.version,
    userInvocable: true,
  }

  return {
    metadata,
    content: writingSkill.content,
    source,
    baseDir,
    filePath,
    projectSession,
    skillId: `${source}:${metadata.name}`,
    writingSkill,
  }
}

function registerBuiltinSkills(registry: Pick<SkillRegistryImpl, 'register'>): void {
  const builtins = getBuiltinWritingSkills()

  for (const { metadata, content, writingSkill, localizedContent } of builtins) {
    const inspected = writingSkill ?? inspectWritingSkillMarkdown(`---\nname: ${metadata.name}\ndescription: ${metadata.description}\n---\n${content}`)
    registry.register({
      metadata,
      content,
      source: 'builtin',
      baseDir: '',
      filePath: `builtin://${metadata.name}`,
      skillId: `builtin:${metadata.name}`,
      writingSkill: inspected,
      localizedContent,
    })
  }
}
