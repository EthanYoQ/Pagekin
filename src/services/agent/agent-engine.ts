import {
  toolRegistry,
  type AgentExecutionContext,
  type ToolResult,
  type ToolArtifact,
  createToolArtifact,
} from './tool-registry'
import { createAgentExecutionContext } from './tools/project-context'
import { writingLanguageText, type WritingLanguage } from '../../shared/writing-language'
import type { FileWriteCommitState } from '../../shared/ipc-channels'
import { parseAgentResponseProtocol, cleanAgentProtocolVisibleText } from '../../shared/agent-response-protocol'
import type { AgentGenerationRound, AgentToolAction } from '../../shared/agent-generation'
import { providerContextFailureText } from '../generation/prompt-budget-failure'

const MAX_TOOL_ROUNDS = 8

const TOOL_TIMEOUT_MS = 30_000

const TOOL_RESULT_MAX_CHARS = 3000

export interface ToolCallInfo {
  id: string
  toolName: string
  arguments: Record<string, unknown>
  status: 'pending' | 'running' | 'completed' | 'failed' | 'result_unknown' | 'waiting_confirm'
  result?: string
  error?: string
  commitState?: FileWriteCommitState
  source?: string
  projectSession?: AgentExecutionContext['projectSession']
}

export interface ConfigImpactBlueprintProposal {
  readonly name: 'propose_chapter_blueprint'
  readonly arguments: Record<string, unknown>
}

export interface ToolConfirmationDecision {
  readonly confirmed: boolean
  readonly blueprintProposals?: readonly ConfigImpactBlueprintProposal[]
}

export interface AgentEngineCallbacks {
  onTextChunk: (chunk: string) => void
  onToolCallStart: (toolCall: ToolCallInfo) => void
  onToolCallComplete: (toolCall: ToolCallInfo) => void
  onToolCallConfirmRequired: (toolCall: ToolCallInfo) => Promise<boolean | ToolConfirmationDecision>
  onDone: (fullText: string, toolCalls: ToolCallInfo[], artifacts: ToolArtifact[]) => void
  onError: (error: string) => void
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type LLMGenerateFn = (
  messages: LLMMessage[],
  modelId: string,
) => Promise<string | AgentGenerationRound>

export function cleanAgentVisibleText(text: string): string {
  return cleanAgentProtocolVisibleText(text, toolRegistry.listAll().map(tool => tool.name))
}

export async function runAgentLoop(
  systemPrompt: string,
  historyMessages: LLMMessage[],
  userMessage: string,
  modelId: string | undefined,
  generateFn: LLMGenerateFn,
  callbacks: AgentEngineCallbacks,
  abortSignal?: AbortSignal,
  providedExecutionContext?: AgentExecutionContext,
): Promise<void> {
  if (providedExecutionContext?.agentGeneration) {
    return runHostedAgentLoop(generateFn, callbacks, providedExecutionContext, abortSignal)
  }
  const allToolCalls: ToolCallInfo[] = []
  const allArtifacts: ToolArtifact[] = []
  const executionContext = providedExecutionContext ?? createAgentExecutionContext(modelId)
  const modelText = (zhCN: string, enUS: string) => (
    writingLanguageText(executionContext.writingLanguage, zhCN, enUS)
  )
  const uiText = (zhCN: string, enUS: string) => (
    executionContext.uiLocale === 'en-US' ? enUS : zhCN
  )

  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    ...historyMessages,
    { role: 'user', content: userMessage },
  ]

  let rounds = 0
  let fullAssistantText = ''

  while (rounds < MAX_TOOL_ROUNDS) {
    if (abortSignal?.aborted) {
      callbacks.onDone(fullAssistantText + uiText('\n\n_（已停止生成）_', '\n\n_(Generation stopped)_'), allToolCalls, allArtifacts)
      return
    }

    rounds++

    let llmResponse: string
    try {
      const generated = await generateFn(messages, modelId ?? '')
      if (typeof generated !== 'string') throw new Error('GENERATION_AGENT_HOST_REQUIRED')
      llmResponse = generated
    } catch {
      if (abortSignal?.aborted) {
        callbacks.onDone(fullAssistantText + uiText('\n\n_（已停止生成）_', '\n\n_(Generation stopped)_'), allToolCalls, allArtifacts)
        return
      }
      callbacks.onError(uiText('AI 请求失败，请重试。', 'The AI request failed. Please try again.'))
      return
    }

    if (abortSignal?.aborted) {
      callbacks.onDone(fullAssistantText + uiText('\n\n_（已停止生成）_', '\n\n_(Generation stopped)_'), allToolCalls, allArtifacts)
      return
    }

    const { textParts, toolCalls } = parseToolCalls(llmResponse)

    const textContent = cleanAgentVisibleText(textParts.join(''))
    if (textContent) {
      callbacks.onTextChunk(textContent)
      fullAssistantText += textContent
    }

    if (toolCalls.length === 0) {
      callbacks.onDone(fullAssistantText, allToolCalls, allArtifacts)
      return
    }

    messages.push({ role: 'assistant', content: llmResponse })

    const observationParts: string[] = []
    const roundToolCalls = [...toolCalls]
    let resultUnknown = false

    for (let toolIndex = 0; toolIndex < roundToolCalls.length; toolIndex++) {
      if (abortSignal?.aborted) break
      const tc = roundToolCalls[toolIndex]
      const toolCallInfo: ToolCallInfo = {
        id: crypto.randomUUID(),
        toolName: tc.name,
        arguments: tc.arguments,
        status: 'pending',
        projectSession: executionContext.projectSession,
      }
      allToolCalls.push(toolCallInfo)

      const tool = toolRegistry.get(tc.name)
      if (!tool) {
        toolCallInfo.status = 'failed'
        toolCallInfo.error = uiText(`未知工具：${tc.name}`, `Unknown tool: ${tc.name}`)
        callbacks.onToolCallComplete(toolCallInfo)
        observationParts.push(`<tool_result name="${tc.name}" error="true">\n${modelText(
          `未知工具：${tc.name}。可用工具：${toolRegistry.listAll().map(t => t.name).join(', ')}`,
          `Unknown tool: ${tc.name}. Available tools: ${toolRegistry.listAll().map(t => t.name).join(', ')}`,
        )}\n</tool_result>`)
        continue
      }

      toolCallInfo.source = tool.source

      let confirmationDecision: ToolConfirmationDecision = { confirmed: true }
      if (tool.requiresConfirmation) {
        toolCallInfo.status = 'waiting_confirm'
        callbacks.onToolCallStart(toolCallInfo)

        const response = await callbacks.onToolCallConfirmRequired(toolCallInfo)
        confirmationDecision = typeof response === 'boolean' ? { confirmed: response } : response
        if (!confirmationDecision.confirmed) {
          toolCallInfo.status = 'failed'
          if (!tool.isReadOnly) toolCallInfo.commitState = 'not_committed'
          toolCallInfo.error = uiText('用户拒绝执行', 'The user declined this action')
          callbacks.onToolCallComplete(toolCallInfo)
          observationParts.push(`<tool_result name="${tc.name}" error="true">\n${modelText('用户拒绝了此操作', 'The user declined this action')}\n</tool_result>`)
          continue
        }
        toolCallInfo.status = 'running'
      } else {
        toolCallInfo.status = 'running'
        callbacks.onToolCallStart(toolCallInfo)
      }

      let sideEffectStarted = false
      try {
        const result = await executeToolWithTimeout(
          tool.execute,
          tc.arguments,
          Object.freeze({
            ...executionContext,
            markSideEffectStarted: () => { sideEffectStarted = true },
          }),
          TOOL_TIMEOUT_MS,
          executionContext.writingLanguage,
          tool.isReadOnly,
          () => sideEffectStarted,
          abortSignal,
        )

        const truncatedContent = truncateResult(
          tc.name,
          result,
          TOOL_RESULT_MAX_CHARS,
          executionContext.writingLanguage,
          MAX_TOOL_ROUNDS - rounds,
        )

        toolCallInfo.commitState = result.commitState
        if (!tool.isReadOnly && result.commitState === 'unknown') {
          toolCallInfo.status = 'result_unknown'
          toolCallInfo.error = uiText(
            '操作可能已提交，但回执未返回；结果待确认，本轮不会自动重试。',
            'The operation may have committed, but no receipt returned. Its result is unknown and this run will not retry it automatically.',
          )
          callbacks.onToolCallComplete(toolCallInfo)
          resultUnknown = true
          break
        }

        toolCallInfo.status = result.success ? 'completed' : 'failed'
        if (result.success) {
          toolCallInfo.result = truncatedContent
        } else {
          toolCallInfo.error = uiText('工具执行失败，请重试。', 'Tool execution failed. Please try again.')
        }
        if (result.artifacts) allArtifacts.push(...result.artifacts)

        callbacks.onToolCallComplete(toolCallInfo)

        if (result.success) {
          observationParts.push(`<tool_result name="${tc.name}">\n${truncatedContent}\n</tool_result>`)
          if (tc.name === 'propose_novel_config' && confirmationDecision.blueprintProposals?.length) {
            roundToolCalls.splice(toolIndex + 1, 0, ...confirmationDecision.blueprintProposals)
          }
        } else {
          observationParts.push(`<tool_result name="${tc.name}" error="true">\n${modelText('工具执行失败。', 'Tool execution failed.')}\n</tool_result>`)
        }
      } catch (error) {
        const unknownWriteResult = !tool.isReadOnly && sideEffectStarted
        if (!tool.isReadOnly) {
          toolCallInfo.commitState = unknownWriteResult ? 'unknown' : 'not_committed'
        }
        toolCallInfo.status = unknownWriteResult ? 'result_unknown' : 'failed'
        toolCallInfo.error = unknownWriteResult
          ? uiText(
              '操作可能已提交，但回执未返回；结果待确认，本轮不会自动重试。',
              'The operation may have committed, but no receipt returned. Its result is unknown and this run will not retry it automatically.',
            )
          : error instanceof ToolExecutionTimeoutError
          ? uiText('工具停止等待：执行超时，操作已取消。', 'Tool wait timed out; the operation was cancelled.')
          : abortSignal?.aborted
            ? uiText('工具已在提交前取消。', 'The tool was cancelled before commit.')
            : uiText('工具执行失败，请重试。', 'Tool execution failed. Please try again.')
        callbacks.onToolCallComplete(toolCallInfo)
        if (unknownWriteResult) {
          resultUnknown = true
          break
        } else {
          observationParts.push(`<tool_result name="${tc.name}" error="true">\n${modelText('工具执行失败。', 'Tool execution failed.')}\n</tool_result>`)
        }
      }
    }

    if (resultUnknown) {
      callbacks.onDone(fullAssistantText + uiText(
        '\n\n_（写入结果待确认；为避免重复写入，本轮已停止。）_',
        '\n\n_(The write result is unknown. This run stopped to avoid a duplicate write.)_',
      ), allToolCalls, allArtifacts)
      return
    }

    const observation = `${modelText(
      '[以下是工具执行结果，请根据结果继续回答用户的问题]',
      '[The following are tool results. Continue answering the user based on them.]',
    )}\n\n${observationParts.join('\n\n')}\n\n${modelText(
      '[请根据上面的工具结果，继续回答用户的原始问题。如果需要更多信息可以继续调用工具。]',
      '[Continue answering the original request using the tool results above. Call another tool only if more information is needed.]',
    )}`
    messages.push({ role: 'user', content: observation })
  }

  if (rounds >= MAX_TOOL_ROUNDS) {
    fullAssistantText += uiText(
      '\n\n已达到最大工具调用次数限制，自动停止。',
      '\n\nThe maximum number of tool calls was reached, so generation stopped.',
    )
  }

  callbacks.onDone(fullAssistantText, allToolCalls, allArtifacts)
}

async function runHostedAgentLoop(generate: LLMGenerateFn, callbacks: AgentEngineCallbacks,
  context: AgentExecutionContext, signal?: AbortSignal): Promise<void> {
  const host = context.agentGeneration!
  const ui = (zh: string, en: string) => context.uiLocale === 'en-US' ? en : zh
  const model = (zh: string, en: string) => writingLanguageText(context.writingLanguage, zh, en)
  const calls: ToolCallInfo[] = [], artifacts: ToolArtifact[] = []
  let visible = ''
  const done = (unknown = false) => callbacks.onDone(visible + (unknown ? ui(
    '\n\n_（写入结果待确认；为避免重复写入，本轮已停止。）_',
    '\n\n_(The write result is unknown. This run stopped to avoid a duplicate write.)_',
  ) : signal?.aborted ? ui('\n\n_（已停止生成）_', '\n\n_(Generation stopped)_') : ''), calls, artifacts)
  const restoreWorkflow = (action: AgentToolAction) => {
    const registration = action.workflow
    if (!registration || registration.state !== 'started' || !context.projectSession) return
    if (artifacts.some(artifact => artifact.type === 'workflow_started' && artifact.runId === registration.registrationId)) return
    artifacts.push(createToolArtifact({ type: 'workflow_started', name: registration.workflow,
      projectPath: context.projectSession.projectPath, projectSession: context.projectSession,
      runId: registration.registrationId, status: 'waiting' }))
  }
  try {
    for (let roundIndex = 0; roundIndex < MAX_TOOL_ROUNDS; roundIndex++) {
      if (signal?.aborted) { done(); return }
      const round = await generate([], context.selectedModelId ?? '')
      if (typeof round === 'string' || round.index !== roundIndex) throw new Error('GENERATION_AGENT_ROUND_MISMATCH')
      if (signal?.aborted) { done(); return }
      if (round.visibleText) { visible += round.visibleText; callbacks.onTextChunk(round.visibleText) }
      if (round.status !== 'completed') throw new Error('GENERATION_AGENT_ROUND_INCOMPLETE')
      if (!round.actions.length) { done(); return }
      const queue = [...round.actions]
      const refreshAuthorActions = async (index: number) => {
        const refreshed = await host.readRound(round.index)
        const known = new Set(queue.map(entry => entry.ref.toolCallId))
        queue.splice(index + 1, 0, ...refreshed.actions.filter(entry => !known.has(entry.ref.toolCallId)))
      }
      for (let index = 0; index < queue.length; index++) {
        if (signal?.aborted) { done(); return }
        let action = queue[index]
        const tool = toolRegistry.get(action.name)
        const info: ToolCallInfo = { id: action.ref.toolCallId, toolName: action.name, arguments: action.arguments,
          status: 'pending', source: tool?.source, projectSession: context.projectSession }
        calls.push(info)
        if (['completed', 'failed', 'declined'].includes(action.status)) {
          info.status = action.status === 'completed' ? 'completed' : 'failed'
          if (action.status === 'completed') info.result = action.observation
          else info.error = action.status === 'declined' ? ui('用户拒绝执行', 'The user declined this action') : ui('工具执行失败，请重试。', 'Tool execution failed. Please try again.')
          callbacks.onToolCallStart(info); callbacks.onToolCallComplete(info); restoreWorkflow(action)
          continue
        }
        if (action.status === 'unknown' || action.status === 'running') {
          info.status = 'result_unknown'; info.commitState = 'unknown'
          callbacks.onToolCallStart(info); callbacks.onToolCallComplete(info); done(true); return
        }
        if (tool) host.assertTool(tool)
        let decision: ToolConfirmationDecision = { confirmed: true }
        info.status = tool?.requiresConfirmation ? 'waiting_confirm' : 'running'
        callbacks.onToolCallStart(info)
        if (tool?.requiresConfirmation) {
          const response = await callbacks.onToolCallConfirmRequired(info)
          decision = typeof response === 'boolean' ? { confirmed: response } : response
        }
        if (signal?.aborted) { done(); return }
        const claim = await host.claimTool(action.ref, decision.confirmed, decision.blueprintProposals)
        action = claim.action
        if (!claim.execute) {
          info.status = action.status === 'completed' ? 'completed' : ['running', 'unknown'].includes(action.status) ? 'result_unknown' : 'failed'
          info.result = action.observation
          if (action.status === 'declined') { info.error = ui('用户拒绝执行', 'The user declined this action'); info.commitState = 'not_committed' }
          callbacks.onToolCallComplete(info); restoreWorkflow(action)
          if (info.status === 'result_unknown') { done(true); return }
          if (action.name === 'propose_novel_config' && info.status === 'completed') await refreshAuthorActions(index)
          continue
        }
        info.status = 'running'
        let sideEffectStarted = false, finishAttempted = false
        try {
          if (!tool) {
            const observation = model(`未知工具：${action.name}`, `Unknown tool: ${action.name}`)
            finishAttempted = true
            await host.finishTool({ ref: action.ref, status: 'failed', observation })
            info.status = 'failed'; info.error = ui(`未知工具：${action.name}`, `Unknown tool: ${action.name}`)
          } else {
            const result = await executeToolWithTimeout(tool.execute, action.arguments, Object.freeze({
              ...context, agentToolAction: action.ref, markSideEffectStarted: () => { sideEffectStarted = true },
            }), TOOL_TIMEOUT_MS, context.writingLanguage, tool.isReadOnly, () => sideEffectStarted, signal)
            const unknown = !tool.isReadOnly && result.commitState === 'unknown'
            const observation = result.success ? truncateResult(action.name, result, TOOL_RESULT_MAX_CHARS, context.writingLanguage, MAX_TOOL_ROUNDS - 1 - roundIndex)
              : model('工具执行失败。', 'Tool execution failed.')
            finishAttempted = true
            action = await host.finishTool({ ref: action.ref, status: unknown ? 'unknown' : result.success ? 'completed' : 'failed', observation })
            info.commitState = result.commitState
            info.status = unknown ? 'result_unknown' : result.success ? 'completed' : 'failed'
            if (result.success) info.result = observation
            else info.error = ui('工具执行失败，请重试。', 'Tool execution failed. Please try again.')
            if (result.artifacts) artifacts.push(...result.artifacts)
            restoreWorkflow(action)
          }
        } catch (error) {
          const unknown = finishAttempted || !!tool && !tool.isReadOnly && sideEffectStarted
          info.status = unknown ? 'result_unknown' : 'failed'
          if (unknown || tool && !tool.isReadOnly) info.commitState = unknown ? 'unknown' : 'not_committed'
          info.error = unknown ? ui('操作结果待确认，本轮不会自动重试。', 'The result is unknown; this run will not retry automatically.')
            : error instanceof ToolExecutionTimeoutError ? ui('工具停止等待：执行超时，操作已取消。', 'Tool wait timed out; the operation was cancelled.')
              : signal?.aborted ? ui('工具已在提交前取消。', 'The tool was cancelled before commit.') : ui('工具执行失败，请重试。', 'Tool execution failed. Please try again.')
          if (!finishAttempted) {
            try { await host.finishTool({ ref: action.ref, status: unknown ? 'unknown' : 'failed', observation: model('工具执行失败。', 'Tool execution failed.') }) }
            catch { info.status = 'result_unknown' }
          }
        }
        callbacks.onToolCallComplete(info)
        if (info.status === 'result_unknown') { done(true); return }
        if (action.name === 'propose_novel_config' && info.status === 'completed') {
          await refreshAuthorActions(index)
        }
      }
    }
    visible += ui('\n\n已达到最大工具调用次数限制，自动停止。', '\n\nThe maximum number of tool calls was reached, so generation stopped.')
    done()
  } catch (error) {
    const providerRejection = providerContextFailureText(error, context.interfaceLocale)
    if (signal?.aborted) done()
    else if (visible) callbacks.onDone(visible + ui('\n\n生成未完成，原候选已保留。', '\n\nGeneration did not finish; the original candidate was retained.')
      + (providerRejection ? `\n\n${providerRejection}` : ''), calls, artifacts)
    else callbacks.onError(providerRejection ?? ui('AI 请求失败，请重试。', 'The AI request failed. Please try again.'))
  }
}

export function parseToolCalls(text: string) {
  const { textParts, toolCalls } = parseAgentResponseProtocol(text, toolRegistry.listAll().map(tool => tool.name))
  return { textParts, toolCalls }
}

async function executeToolWithTimeout(
  executeFn: (
    args: Record<string, unknown>,
    context?: AgentExecutionContext,
  ) => Promise<ToolResult>,
  args: Record<string, unknown>,
  context: AgentExecutionContext,
  timeoutMs: number,
  writingLanguage: WritingLanguage,
  isReadOnly: boolean,
  hasSideEffectStarted: () => boolean,
  outerSignal?: AbortSignal,
): Promise<ToolResult> {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(outerSignal?.reason)
  if (outerSignal?.aborted) forwardAbort()
  else outerSignal?.addEventListener('abort', forwardAbort, { once: true })
  const toolContext = Object.freeze({ ...context, abortSignal: controller.signal })
  const execution = executeFn(args, toolContext)

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      execution,
      new Promise<ToolResult>((_, reject) => {
        timer = setTimeout(() => {
          if (isReadOnly || !hasSideEffectStarted()) controller.abort()
          reject(new ToolExecutionTimeoutError(writingLanguageText(
            writingLanguage,
            `工具执行超时（${timeoutMs / 1000}s）`,
            `Tool execution timed out (${timeoutMs / 1000}s)`,
          )))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    outerSignal?.removeEventListener('abort', forwardAbort)
  }
}

class ToolExecutionTimeoutError extends Error {}

function truncateResult(
  toolName: string,
  result: ToolResult,
  maxChars: number,
  writingLanguage: WritingLanguage,
  roundsLeft: number,
): string {
  const { content, resultOffset } = result
  if (content.length <= maxChars) return content
  const lastShown = content.charCodeAt(maxChars - 1)
  const shown = lastShown >= 0xD800 && lastShown <= 0xDBFF ? maxChars - 1 : maxChars
  if (resultOffset === undefined) {
    return content.slice(0, shown) + writingLanguageText(
      writingLanguage,
      `\n\n…（内容已截断，完整内容共 ${content.length} 字符。可使用 read_file 工具获取完整文件内容）`,
      `\n\n... (Result truncated. The complete content is ${content.length} characters; use read_file to retrieve it.)`,
    )
  }
  const end = resultOffset + shown
  const total = resultOffset + content.length
  if (roundsLeft < 2) {
    return content.slice(0, shown) + writingLanguageText(
      writingLanguage,
      `\n\n…（内容已截断：本段是第 ${resultOffset} 至 ${end} 字符，完整内容共 ${total} 字符。本轮工具调用次数已用完，请根据已读内容回答，并告诉作者第 ${end} 字符之后尚未读到；之后可调用 ${toolName} 并设 offset=${end} 继续）`,
      `\n\n... (Result truncated: this part covers characters ${resultOffset} to ${end} of ${total}. No tool rounds are left in this turn. Answer from what you have read and tell the author that the content after character ${end} was not read; it can be continued later by calling ${toolName} with offset=${end}.)`,
    )
  }
  return content.slice(0, shown) + writingLanguageText(
    writingLanguage,
    `\n\n…（内容已截断：本段是第 ${resultOffset} 至 ${end} 字符，完整内容共 ${total} 字符。用相同参数再次调用 ${toolName} 并设 offset=${end} 读取下一段）`,
    `\n\n... (Result truncated: this part covers characters ${resultOffset} to ${end} of ${total}. Call ${toolName} again with the same arguments and offset=${end} to read the next part.)`,
  )
}
