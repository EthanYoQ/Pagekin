import { describe, expect, it, vi } from 'vitest'

import { displayedErrorMessage, errorCodeOf, isRegisteredErrorCode } from '../../../i18n/app-errors'
import { copyLocale, translate } from '../../../i18n/core'
import type { ErrorDisplayLocale } from '../../../i18n/types'
import { shown } from '../../../i18n/__tests__/shown-locale'
import type { GenerationAttemptReceipt, GenerationOutcome, GenerationSession } from '../../generation/generation-harness'
import type { WorkflowContext } from '../../../stores/workflow-store'
import { keepReceiptFailuresOnCancel } from '../commands/base-command'
import { workflowMainProcessError } from '../workflow-project-session'

/** master 上 workflowMainProcessError 的原样实现，作对照。 */
function masterWorkflowMainProcessError(interfaceLocale: ErrorDisplayLocale, error: unknown, zhCNSummary: string, enUSSummary: string): Error {
  const english = copyLocale(interfaceLocale) === 'en-US'
  const summary = english ? enUSSummary : zhCNSummary
  if (typeof error !== 'string') return new Error(summary)
  const code = errorCodeOf(error)
  const reasonShown = displayedErrorMessage(interfaceLocale, error, summary)
  const reason = reasonShown === summary || (english && !isRegisteredErrorCode(error)) ? undefined : reasonShown
  const failure = new Error(reason ? `${summary}${english ? ' ' : '：'}${reason}` : summary)
  return code ? Object.assign(failure, { code }) : failure
}

const LOCALES = ['zh-CN', 'en-US', 'ja-JP'] as const
const MAIN_PROCESS_REASONS = [
  undefined, '', '  ', 'PROJECT_NOT_OPEN', 'LEGACY_VECTOR_MIGRATION_BLOCKED', 'ProjectSessionStaleError: PROJECT_SESSION_STALE',
  "Error invoking remote method 'kb:clear': Error: PROJECT_NOT_OPEN", 'WORKFLOW_UNREGISTERED_TEST_CODE',
  'PortableProjectArchiveError: PORTABLE_ARCHIVE_INVALID', 'Error: 项目数据库未打开', 'connect ECONNREFUSED 127.0.0.1:7890',
  '定稿事务未提交', 'Error: 定稿事务未提交', 'The finalization transaction was not committed.',
]

const sameAsMaster = (zh: string, en: string, reasons: readonly unknown[]) => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const locale of LOCALES) {
    for (const reason of reasons) {
      const master = masterWorkflowMainProcessError(shown(locale), reason, zh, en)
      const migrated = workflowMainProcessError(shown(locale), reason, zh as never, en as never)
      expect({ message: migrated.message, code: migrated.code }, `${locale} ${String(reason)}`)
        .toEqual({ message: master.message, code: (master as { code?: string }).code })
    }
  }
}

describe('三条已证伪路径的产生点（#844）', () => {
  it('workflowMainProcessError 造的错误 error.code 和说明文字与 master 相同', () => {
    sameAsMaster('定稿事务未提交', 'The finalization transaction was not committed.', MAIN_PROCESS_REASONS)
  })

  it('知识库操作失败的 toast 与 master 相同', () => {
    const results: Array<{ error?: string; errorCode?: string }> = [
      { error: 'EMBEDDING_SPACE_REGISTRY_INVALID' },
      { errorCode: 'LEGACY_VECTOR_MIGRATION_BLOCKED', error: '旧版知识库数据需要先修复后才能继续。请修正项目中的 vectors.json，然后重试。' },
      { error: 'EMBEDDING_SPACE_VERIFY_FAILED' },
      { error: '知识库写入失败：磁盘已满' },
      {},
    ]
    const reasons = results.map(result => result.errorCode ?? result.error)
    for (const [zh, en] of [
      ['重建检索失败', 'Could not rebuild search.'],
      ['保存失败', 'Save failed.'],
      ['更新检索失败', 'Could not update search.'],
      ['清空知识库失败', 'Could not clear the knowledge base.'],
    ] as const) sameAsMaster(zh, en, reasons)
  })

  it('作者取消后带收据失败码的结果仍抛出带原码的失败', async () => {
    const codes = ['GENERATION_PROVIDER_FAILED', 'NETWORK_ERROR', 'ROOT_BUDGET_EXHAUSTED', 'GENERATION_STORAGE_FAILED', 'GENERATION_CONTEXT_LENGTH_EXCEEDED'] as const
    const contexts = [
      { uiLocale: 'zh-CN', interfaceLocale: 'zh-CN', fallback: 'AI 未正常完成生成，结果未被保存。' },
      { uiLocale: 'en-US', interfaceLocale: 'en-US', fallback: 'AI generation did not complete normally, so the result was not saved.' },
      { uiLocale: 'en-US', interfaceLocale: 'ja-JP', fallback: 'AI generation did not complete normally, so the result was not saved.' },
    ] as const
    for (const { uiLocale, interfaceLocale, fallback } of contexts) {
      for (const failureCode of codes) {
        const outcome = { status: 'incomplete', content: '写到一半', finishReason: 'error', receipt: { failureCode } as GenerationAttemptReceipt } as GenerationOutcome
        const session: GenerationSession = { budget: { maxAttempts: 1, maxRequestedOutputTokens: 1, maxRequestedOutputTokensPerAttempt: 1, deadlineAt: 0 }, complete: async () => outcome }
        const context = { cancelled: true, uiLocale, interfaceLocale: shown(interfaceLocale) } as WorkflowContext
        const thrown = await keepReceiptFailuresOnCancel(session, context).complete({} as never).then(() => new Error('did not throw'), (error: unknown) => error as Error) as Error & { code?: unknown }
        const expected = failureCode === 'NETWORK_ERROR' ? translate(shown(interfaceLocale), 'error.generationNetworkFailed') : fallback
        expect({ message: thrown.message, code: thrown.code }, `${interfaceLocale} ${failureCode}`).toEqual({ message: expected, code: failureCode })
      }
    }
  })
})
