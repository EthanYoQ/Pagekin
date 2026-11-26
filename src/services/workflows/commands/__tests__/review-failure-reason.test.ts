import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewChapterCommand } from '../review-chapter.command'
import { ReviewRevisionRuntimeFixture } from './review-revision-runtime.fixture'
import { workflowRuntimeDependencies, useFakeModelStream, type FakeGenerateStream } from './workflow-generation-runtime.fixture'
import { useProjectStore } from '../../../../stores/project-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useWorkflowStore, type WorkflowContext, type WorkflowRun } from '../../../../stores/workflow-store'
import { runFailure } from '../../../../components/run/run-failure'
import { shown } from '../../../../i18n/__tests__/shown-locale'
import type { GenerationAttemptReceipt } from '../../../generation/generation-harness'
import type { GenerationTransportDiagnostics } from '../../../../shared/generation-contract'

const projectPath = 'C:\\synthetic\\review-runtime'
const session = { projectId: 'review-runtime', projectPath, leaseId: 'review-epoch' }
const source = { id: 1, chapterNumber: 1, version: 1, status: 'draft' as const, content: '原稿正文。'.repeat(60) }
type Locale = 'zh-CN' | 'en-US'
type ReceiptCode = NonNullable<GenerationAttemptReceipt['failureCode']>

const CODES: ReceiptCode[] = ['GENERATION_PROVIDER_FAILED', 'NETWORK_ERROR', 'ROOT_BUDGET_EXHAUSTED', 'GENERATION_STORAGE_FAILED', 'GENERATION_CONTEXT_LENGTH_EXCEEDED']
const timing = { startedAt: 1, elapsedMs: 10, firstResponseMs: 5, lastResponseMs: 8, lastOutputMs: 8, visibleEvents: 1, reasoningEvents: 0 }
const failed = (phase: GenerationTransportDiagnostics['phase'], fields: Partial<GenerationTransportDiagnostics>): GenerationTransportDiagnostics =>
  ({ ...timing, phase, endReason: 'failed', ...fields })

/** 审稿按传输诊断给原因，与收据失败码无关。 */
const BY_DIAGNOSTICS: Array<[string, GenerationTransportDiagnostics, Record<Locale, string>]> = [
  ['读响应流超时', failed('stream', { causeCode: 'UND_ERR_BODY_TIMEOUT' }), { 'zh-CN': '读取响应流超时。上游为何停止响应尚未确认。', 'en-US': 'Reading the response stream timed out. Why the upstream stopped responding is not confirmed.' }],
  ['等响应头超时', failed('response', { causeCode: 'UND_ERR_HEADERS_TIMEOUT' }), { 'zh-CN': '等待服务响应超时。具体原因尚未确认。', 'en-US': 'Waiting for the service timed out. The underlying cause is not confirmed.' }],
  ['连接超时', failed('request', { causeCode: 'UND_ERR_CONNECT_TIMEOUT' }), { 'zh-CN': '等待服务响应超时。具体原因尚未确认。', 'en-US': 'Waiting for the service timed out. The underlying cause is not confirmed.' }],
  ['ETIMEDOUT', failed('request', { errorCode: 'ETIMEDOUT' }), { 'zh-CN': '等待服务响应超时。具体原因尚未确认。', 'en-US': 'Waiting for the service timed out. The underlying cause is not confirmed.' }],
  ['流未完整', failed('stream', { errorCode: 'STREAM_INCOMPLETE' }), { 'zh-CN': '响应流在完整报告返回前结束。具体原因尚未确认。', 'en-US': 'The response stream ended before a complete report arrived. The underlying cause is not confirmed.' }],
  ['流无效', failed('stream', { errorCode: 'STREAM_INVALID' }), { 'zh-CN': '服务响应缺少有效的生成数据。', 'en-US': 'The service response did not contain valid generation data.' }],
  ['响应体缺失', failed('response', { errorCode: 'RESPONSE_BODY_MISSING' }), { 'zh-CN': '服务响应缺少有效的生成数据。', 'en-US': 'The service response did not contain valid generation data.' }],
  ['套接字断开', failed('stream', { causeCode: 'UND_ERR_SOCKET' }), { 'zh-CN': '响应连接中断。具体原因尚未确认。', 'en-US': 'The response connection was interrupted. The underlying cause is not confirmed.' }],
  ['ECONNRESET', failed('stream', { errorCode: 'ECONNRESET' }), { 'zh-CN': '响应连接中断。具体原因尚未确认。', 'en-US': 'The response connection was interrupted. The underlying cause is not confirmed.' }],
  ['流提前关闭', failed('stream', { causeCode: 'ERR_STREAM_PREMATURE_CLOSE' }), { 'zh-CN': '响应连接中断。具体原因尚未确认。', 'en-US': 'The response connection was interrupted. The underlying cause is not confirmed.' }],
  ['代理不可达', failed('request', { errorCode: 'PROXY_UNREACHABLE' }), { 'zh-CN': '审稿请求未完成，具体原因未知。', 'en-US': 'The review request did not complete; the specific cause is unknown.' }],
  ['HTTP 502', failed('response', { httpStatus: 502 }), { 'zh-CN': '服务返回 HTTP 502，请求未完成。', 'en-US': 'The service returned HTTP 502; the request did not complete.' }],
  ['失败但无码', failed('stream', {}), { 'zh-CN': '审稿请求未完成，具体原因未知。', 'en-US': 'The review request did not complete; the specific cause is unknown.' }],
]

const GENERIC = { 'zh-CN': 'AI 未正常完成生成，结果未被保存。', 'en-US': 'AI generation did not complete normally, so the result was not saved.' }
/** 诊断没记失败时：NETWORK_ERROR 给网络说明，其余码给通用说明。 */
const NOT_FAILED: Array<[string, GenerationTransportDiagnostics | undefined, Record<Locale, string>]> = [
  ['流已结束', { ...timing, phase: 'stream', endReason: 'completed' }, { 'zh-CN': '与模型服务的连接中途断了。请检查网络或「网络代理」设置后重试。', 'en-US': 'The connection to the model service broke off midway. Check your network or the Network proxy settings, then try again.' }],
  ['请求阶段未结束', { ...timing, phase: 'request' }, { 'zh-CN': '没连上模型服务。请检查网络或「网络代理」设置后重试。', 'en-US': 'Could not reach the model service. Check your network or the Network proxy settings, then try again.' }],
  ['没有诊断', undefined, { 'zh-CN': '没连上模型服务，或回复中途断了。请检查网络或代理后重试。', 'en-US': 'Could not reach the model service, or the reply broke off midway. Check your network or proxy, then try again.' }],
]

const CASES = CODES.flatMap(code => (['zh-CN', 'en-US'] as const).flatMap(locale => [
  ...BY_DIAGNOSTICS.map(([name, diagnostics, text]) => [code, name, locale, diagnostics, text[locale]] as const),
  ...NOT_FAILED.map(([name, diagnostics, network]) => [code, name, locale, diagnostics, code === 'NETWORK_ERROR' ? network[locale] : GENERIC[locale]] as const),
]))

beforeEach(() => {
  useProjectStore.setState({ currentProject: { id: session.projectId, path: projectPath, name: 'Synthetic', sessionLease: session.leaseId,
    novelConfig: { wordsPerChapter: 300, globalGuidance: '冻结项目指导', writingLanguage: 'zh-CN' } } as never })
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, currentRun: null, waitingForConfirm: false, waitingAfterStepIndex: -1 })
  useLLMStore.setState({ defaultModelId: 'model-a' })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useProjectStore.setState({ currentProject: null }) })

async function reviewFailureReason(code: ReceiptCode, diagnostics: GenerationTransportDiagnostics | undefined, locale: Locale, cancelled = false) {
  const fixture = new ReviewRevisionRuntimeFixture(async channel => {
    if (channel === 'db:draft-get-full') return source
    if (channel === 'db:draft-get-meta') return { ...source, source: 'write' }
    if (channel === 'db:continuity-list-before') return []
    if (channel === 'generation:read-context') return {}
    throw new Error(`unexpected IPC: ${channel}`)
  })
  fixture.receiptFailure = { failureCode: code, ...(diagnostics ? { diagnostics } : {}) }
  const context: WorkflowContext = { runId: 'consumer-action', projectPath, projectSession: session,
    writingLanguage: 'zh-CN', uiLocale: locale, interfaceLocale: shown(locale), data: {}, cancelled: false }
  useFakeModelStream.setState({ generateStream: vi.fn<FakeGenerateStream>(async (_messages, callbacks) => {
    context.cancelled = cancelled
    callbacks.onDone?.('', undefined, 'error')
    return 'synthetic-request'
  }) })
  vi.stubGlobal('window', { aiNovelAPI: { on: vi.fn(() => () => {}), once: vi.fn(), invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
    if (channel === 'fs:check-exists') return false
    if (channel === 'skills:list-user') return []
    return fixture.invoke(channel, ...args)
  }) } })
  useLocaleStore.setState({ interfaceLocale: locale, locale })
  const selected = { draftPath: 'ai-novel://draft/1', draftContent: source.content, chapterNumber: 1,
    sourceDraft: { id: 1, chapterNumber: 1, version: 1, status: 'draft' as const, contentRevision: 1 } }
  fixture.selected = selected
  const command = new ReviewChapterCommand({ ...selected, reviewFocus: '作者指定的审稿重点' }, fixture.wrap(workflowRuntimeDependencies))
  const callbacks = { log: vi.fn(), appendText: vi.fn(), replaceText: vi.fn(), setProgress: vi.fn() }
  const thrown = await command.execute({ step: {}, context, callbacks } as never).then(() => new Error('审稿意外成功'), (error: unknown) => error)
  const runId = await useWorkflowStore.getState().startWorkflow({
    type: 'chapter_creation', title: '第 1 章', projectPath, projectSession: session,
    steps: [{ name: '审稿', description: '审稿', executor: async () => { throw thrown } }],
  })
  const run = useWorkflowStore.getState().history.find(item => item.id === runId)!
  const reviewed: WorkflowRun = { ...run, uiLocale: locale, steps: run.steps.map(step => ({ ...step, generationActivity: { operation: 'review-chapter', diagnostics } })) }
  return runFailure(reviewed, shown(locale)).presentation.reason
}

describe('审稿运行因模型连接失败时的失败提示与 master 逐字相同', () => {
  it.each(CASES)('%s，%s，%s', async (code, _name, locale, diagnostics, expected) => {
    expect(await reviewFailureReason(code, diagnostics, locale)).toBe(expected)
  })

  it.each(CODES)('作者取消后收据带 %s 时同样相同', async code => {
    for (const [diagnostics, expected] of [[BY_DIAGNOSTICS[0][1], BY_DIAGNOSTICS[0][2]['zh-CN']], [undefined, code === 'NETWORK_ERROR' ? NOT_FAILED[2][2]['zh-CN'] : GENERIC['zh-CN']]] as const) {
      expect(await reviewFailureReason(code, diagnostics, 'zh-CN', true)).toBe(expected)
    }
  })
})
