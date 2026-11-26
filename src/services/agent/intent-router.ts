import { skillRegistry, type LoadedSkill } from './skill-registry'
import type { Locale } from '../../i18n/types'

export interface SlashCommand {
  name: string
  displayName: string
  description: string
  source: 'builtin_command' | 'skill'
  skill?: LoadedSkill
}

export interface MentionTarget {
  type: 'chapter' | 'character' | 'architecture' | 'blueprint' | 'knowledge' | 'file'
  displayName: string
  value: string
}

export interface ParsedMention {
  target: MentionTarget
  start: number
  end: number
}

function builtinCommands(locale: Locale): SlashCommand[] {
  const text = (zhCN: string, enUS: string) => locale === 'en-US' ? enUS : zhCN
  return [
    {
      name: 'clear',
      displayName: text('清空对话', 'Clear conversation'),
      description: text('清空当前对话历史', 'Clear the current conversation history'),
      source: 'builtin_command',
    },
    {
      name: 'new',
      displayName: text('新对话', 'New conversation'),
      description: text('开始一个新的对话', 'Start a new conversation'),
      source: 'builtin_command',
    },
    {
      name: 'help',
      displayName: text('帮助', 'Help'),
      description: text('显示可用的命令和功能列表', 'Show available commands and features'),
      source: 'builtin_command',
    },
    {
      name: 'status',
      displayName: text('项目状态', 'Project status'),
      description: text('查看当前项目的状态和进度', 'View the current project status and progress'),
      source: 'builtin_command',
    },
  ]
}

export function getAllSlashCommands(locale: Locale = 'zh-CN'): SlashCommand[] {
  const commands = builtinCommands(locale)

  for (const skill of skillRegistry.listAll()) {
    if (skill.metadata.userInvocable !== false) {
      commands.push({
        name: skill.metadata.name,
        displayName: locale === 'en-US'
          ? (skill.writingSkill.metadata.displayName ?? skill.metadata.name)
          : (skill.metadata.displayName ?? skill.metadata.name),
        description: locale === 'en-US'
          ? skill.writingSkill.metadata.description
          : skill.metadata.description,
        source: 'skill',
        skill,
      })
    }
  }

  return commands
}

export function searchSlashCommands(query: string, locale: Locale = 'zh-CN'): SlashCommand[] {
  const q = query.toLowerCase()
  return getAllSlashCommands(locale).filter(cmd =>
    cmd.name.toLowerCase().includes(q) ||
    cmd.displayName.toLowerCase().includes(q) ||
    cmd.description.toLowerCase().includes(q)
  )
}

export function isSlashCommand(input: string): boolean {
  return input.trimStart().startsWith('/')
}

export function parseSlashCommand(input: string, locale: Locale = 'zh-CN'): {
  command: SlashCommand | null
  args: string
} {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith('/')) {
    return { command: null, args: '' }
  }

  const withoutSlash = trimmed.slice(1)
  const spaceIndex = withoutSlash.indexOf(' ')
  const cmdName = spaceIndex > -1 ? withoutSlash.slice(0, spaceIndex) : withoutSlash
  const args = spaceIndex > -1 ? withoutSlash.slice(spaceIndex + 1).trim() : ''

  const command = getAllSlashCommands(locale).find(c => c.name === cmdName) ?? null

  return { command, args }
}

export function getAllMentionTargets(locale: Locale = 'zh-CN'): MentionTarget[] {
  const text = (zhCN: string, enUS: string) => locale === 'en-US' ? enUS : zhCN
  return [
    { type: 'architecture', displayName: text('故事架构', 'Story architecture'), value: 'architecture' },
    { type: 'character', displayName: text('角色卡', 'Character cards'), value: 'characters' },
    { type: 'blueprint', displayName: text('章节蓝图', 'Chapter blueprints'), value: 'blueprints' },
    { type: 'knowledge', displayName: text('知识库', 'Knowledge base'), value: 'knowledge' },
    { type: 'chapter', displayName: text('当前章节', 'Current chapter'), value: 'current_chapter' },
    { type: 'file', displayName: text('项目文件', 'Project file'), value: 'file' },
  ]
}

export function searchMentionTargets(query: string, locale: Locale = 'zh-CN'): MentionTarget[] {
  const q = query.toLowerCase()
  return getAllMentionTargets(locale).filter(t =>
    t.displayName.toLowerCase().includes(q) ||
    t.value.toLowerCase().includes(q)
  )
}

export function parseMentions(input: string, locale: Locale = 'zh-CN'): ParsedMention[] {
  const mentions: ParsedMention[] = []
  const regex = /@(\S+)/g
  let match: RegExpExecArray | null = null

  while ((match = regex.exec(input)) !== null) {
    const value = match[1]
    const target = getAllMentionTargets(locale).find(t =>
      t.value === value || t.displayName === value
    )
    if (target) {
      mentions.push({
        target,
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return mentions
}

export function mentionsToToolCalls(mentions: ParsedMention[]): Array<{
  toolName: string
  args: Record<string, unknown>
}> {
  return mentions.map(m => {
    switch (m.target.type) {
      case 'architecture':
        return { toolName: 'read_architecture', args: {} }
      case 'character':
        return { toolName: 'read_characters', args: {} }
      case 'blueprint':
        return { toolName: 'read_blueprint', args: {} }
      case 'knowledge':
        return { toolName: 'search_knowledge', args: { query: '' } }
      case 'chapter':
        return { toolName: 'list_chapters', args: {} }
      case 'file':
        return { toolName: 'read_file', args: { file_path: '' } }
      default:
        return { toolName: 'read_project_state', args: {} }
    }
  })
}
