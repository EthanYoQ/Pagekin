import type { FileWriteCommitState, ProjectSessionContext } from '../../shared/ipc-channels'
import type { WritingLanguage } from '../../shared/writing-language'
import type { WorkflowStatus } from '../../stores/workflow-store'

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, {
    type: string
    description: string
    descriptionEn?: string
    enum?: string[]
    default?: unknown
  }>
  required?: string[]
}

interface ToolArtifactBase {
  readonly projectPath: string
  readonly projectSession: ProjectSessionContext
  readonly name: string
}

export type ToolArtifact =
  | (ToolArtifactBase & {
    readonly type: 'file_created' | 'file_modified' | 'tab_opened'
    readonly path?: string
    readonly runId?: never
    readonly status?: never
  })
  | (ToolArtifactBase & {
    readonly type: 'workflow_started'
    readonly runId: string
    readonly status: WorkflowStatus
    readonly path?: never
  })

export function createToolArtifact<T extends ToolArtifact>(artifact: T): T {
  return Object.freeze({
    ...artifact,
    projectSession: Object.freeze({ ...artifact.projectSession }),
  }) as unknown as T
}

export interface ToolResult {
  success: boolean
  content: string
  artifacts?: ToolArtifact[]
  error?: string
  commitState?: FileWriteCommitState
  resultOffset?: number
}

export interface AgentExecutionContext {
  readonly agentToolAction?: import('../../shared/agent-generation').AgentToolActionRef
  readonly agentGeneration?: import('./agent-generation-client').AgentGenerationClient
  readonly projectSession: ProjectSessionContext | null
  readonly uiLocale: import('../../i18n/types').Locale
  readonly interfaceLocale: import('../../i18n/types').ErrorDisplayLocale
  readonly writingLanguage: WritingLanguage
  readonly selectedModelId: string | null
  readonly abortSignal?: AbortSignal
  readonly markSideEffectStarted?: () => void
}

export type ToolSource = 'builtin' | 'mcp' | 'skill'

export interface AgentTool {
  name: string
  description: string
  descriptionEn?: string
  source: ToolSource
  inputSchema: ToolInputSchema
  requiresConfirmation: boolean
  isReadOnly: boolean
  execute: (
    args: Record<string, unknown>,
    context?: AgentExecutionContext,
  ) => Promise<ToolResult>
  userFacingName?: string
}

class ToolRegistryImpl {
  private tools: Map<string, AgentTool> = new Map()

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] Tool "${tool.name}" 已注册，将被覆盖`)
    }
    this.tools.set(tool.name, tool)
  }

  registerAll(tools: AgentTool[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  unregisterBySource(source: ToolSource): number {
    let count = 0
    for (const [name, tool] of this.tools) {
      if (tool.source === source) {
        this.tools.delete(name)
        count++
      }
    }
    return count
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name)
  }

  listAll(): AgentTool[] {
    return Array.from(this.tools.values())
  }

  listBySource(source: ToolSource): AgentTool[] {
    return this.listAll().filter(t => t.source === source)
  }

  get size(): number {
    return this.tools.size
  }

  generateToolPrompt(
    writingLanguage: WritingLanguage = 'zh-CN',
    includeTool: (tool: AgentTool) => boolean = () => true,
  ): string {
    const tools = this.listAll().filter(includeTool)
    if (tools.length === 0) return ''

    const english = writingLanguage === 'en-US'
    let prompt = english ? `## Tool system

Use registered application tools to read project data or request an operation.

### Call format

Use exactly this XML format:

<tool_call>
{"name": "tool_name", "arguments": {"argument_name": "value"}}
</tool_call>

### Immutable rules

1. Inside <tool_call>, emit exactly one JSON object; do not use <name> or <arguments> child tags.
2. Put at most one <tool_call> block in each response.
3. After a tool runs, the application returns <tool_result>.
4. Continue after <tool_result> and answer the user from the returned data.
5. Call another tool in the next turn only when more data is required.
6. Never quote or reveal tool-call markup in story prose.
7. Read-only tools run directly. Write tools require user confirmation.

### Available tools

` : `## 工具系统

你可以通过调用工具来获取项目数据或执行操作。

### 调用格式

使用以下 XML 格式调用工具：

<tool_call>
{"name": "工具名称", "arguments": {"参数名": "参数值"}}
</tool_call>

### 重要规则

1. <tool_call> 内必须只包含一个 JSON 对象；禁止使用 <name> 或 <arguments> 子标签。
2. **每次回复最多放一个** <tool_call> 标签。
3. 调用工具后，系统会自动执行并返回 <tool_result> 结果。
4. **收到 <tool_result> 后你必须继续推理**，根据工具返回的数据回答用户问题。不要就此停止。
5. 如果一个工具的结果不够，你可以在下一轮继续调用另一个工具。
6. 不要在正文中引用或复述 <tool_call> 标签的内容。
7. 只读工具自动执行。写入型工具需要用户确认。

### 示例交互

用户：帮我分析第一章
助手：好的，我先获取第一章的内容。
<tool_call>
{"name": "read_drafts", "arguments": {"chapter_number": 1}}
</tool_call>

（系统返回 tool_result 后，助手根据结果继续分析）

### 可用工具列表

`
    for (const tool of tools) {
      const displayName = english ? tool.name : (tool.userFacingName ?? tool.name)
      const sourceTag = tool.source === 'mcp' ? ' [MCP]' : tool.source === 'skill' ? ' [Skill]' : ''
      const confirmTag = tool.requiresConfirmation
        ? (english ? ' [confirmation required]' : ' [需确认]')
        : ''

      prompt += `#### ${displayName}${sourceTag}${confirmTag}\n`
      const toolDescription = english
        ? (tool.descriptionEn ?? (tool.source === 'builtin' ? '' : tool.description))
        : tool.description
      prompt += `${toolDescription}\n`

      const { properties, required = [] } = tool.inputSchema
      if (Object.keys(properties).length > 0) {
        prompt += english ? 'Arguments:\n' : '参数：\n'
        for (const [key, schema] of Object.entries(properties)) {
          const isRequired = required.includes(key)
          const reqTag = isRequired ? (english ? 'required' : '必填') : (english ? 'optional' : '可选')
          let paramDesc = `- ${key} (${schema.type}, ${reqTag})`
          const description = english
            ? (schema.descriptionEn ?? (tool.source === 'builtin' ? '' : schema.description))
            : schema.description
          if (description) paramDesc += `: ${description}`
          if (schema.enum) {
            paramDesc += english
              ? ` [values: ${schema.enum.join(', ')}]`
              : ` [可选值: ${schema.enum.join(', ')}]`
          }
          if (schema.default !== undefined) {
            paramDesc += english
              ? ` (default: ${JSON.stringify(schema.default)})`
              : ` (默认: ${JSON.stringify(schema.default)})`
          }
          prompt += paramDesc + '\n'
        }
      }
      prompt += '\n'
    }

    return prompt
  }

  clear(): void {
    this.tools.clear()
  }
}

export const toolRegistry = new ToolRegistryImpl()

export function buildAgentTool(
  def: Omit<AgentTool, 'isReadOnly'> & { isReadOnly?: boolean }
): AgentTool {
  return {
    isReadOnly: !def.requiresConfirmation,
    ...def,
  }
}
