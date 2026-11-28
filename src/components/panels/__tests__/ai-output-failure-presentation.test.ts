import { describe, expect, it, vi } from 'vitest'

import { presentWorkflowFailure } from '../ai-output-failure-presentation'
import { shown } from '../../../i18n/__tests__/shown-locale'

const promptBudgetReport = (sectionName: string) => ({
  totalUtf8Bytes: 13_000,
  limitUtf8Bytes: 12_000,
  reservedOutputTokens: 8_192,
  sections: [
    { sectionName, utf8Bytes: 12_000 },
    { sectionName: 'prompt-overhead', utf8Bytes: 1_000 },
  ],
  modelId: 'model-a',
  errorCode: 'PROMPT_BUDGET_EXHAUSTED' as const,
})

describe('AI output failure presentation', () => {
  it('maps a structured content-filter code to a clear Chinese chapter-draft failure', () => {
    expect(presentWorkflowFailure('content_filter', 'provider-safe message', shown('zh-CN'), true)).toEqual({
      heading: '正文生成被内容策略拦截',
      reason: '模型的内容安全策略拦截了这次输出。',
      persistence: '本次未保存草稿或正文章节。请调整章节要求，或选择符合预期内容政策的模型后重试。',
    })
  })

  it('maps a structured content-filter code to an English explanation instead of exposing it as prose', () => {
    expect(presentWorkflowFailure('content_filter', 'provider-safe message', shown('en-US'), true)).toEqual({
      heading: 'Draft generation was blocked by the content policy',
      reason: 'The model safety policy filtered this output.',
      persistence: 'No draft or manuscript chapter was saved. Adjust the chapter request, or choose a model whose policy fits your intended permitted content, then try again.',
    })
  })

  it('keeps a legacy machine-looking error generic when no structured code was supplied', () => {
    const presentation = presentWorkflowFailure(undefined, 'finish:content_filter', shown('zh-CN'), true)

    expect(presentation.reason).toBe('finish:content_filter')
    expect(presentation.heading).not.toBe('正文生成被内容策略拦截')
  })

  it('offers Novel configuration only for a project-configuration contributor', () => {
    expect(presentWorkflowFailure(
      'prompt_budget_exhausted',
      'safe report summary',
      shown('en-US'),
      false,
      promptBudgetReport('global-guidance'),
    )).toMatchObject({
      action: 'open-novel-config',
      guidance: 'Shorten the listed project configuration fields in Novel configuration, then try again.',
    })
  })

  it('keeps a step-guidance overflow away from the unrelated Novel configuration action', () => {
    const presentation = presentWorkflowFailure(
      'prompt_budget_exhausted',
      'safe report summary',
      shown('zh-CN'),
      false,
      promptBudgetReport('step-guidance'),
    )

    expect(presentation).toMatchObject({
      guidance: '请返回该生成步骤，缩短步骤指导后重试。',
    })
    expect(presentation).not.toHaveProperty('action')
  })

  it.each([
    ['architecture', 'Shorten the related story-architecture content or reduce this generation scope, then try again.'],
    ['validated-prefix', 'Reduce this structured batch and try again; validated content will not be silently truncated.'],
    ['repair-contract', 'Reduce this task scope and try again.'],
    ['repair-candidate', 'Shorten the structured content being repaired, or split this import or generation into smaller batches, then try again.'],
  ])('provides safe non-configuration guidance for %s without an unrelated action', (sectionName, guidance) => {
    const presentation = presentWorkflowFailure(
      'prompt_budget_exhausted',
      'safe report summary',
      shown('en-US'),
      false,
      promptBudgetReport(sectionName),
    )

    expect(presentation.guidance).toBe(guidance)
    expect(presentation).not.toHaveProperty('action')
  })

  it.each(['repair-contract', 'unlisted-section'])('预算不足的建议不让作者去记结果码：%s', sectionName => {
    const zh = presentWorkflowFailure('prompt_budget_exhausted', 'safe report summary', shown('zh-CN'), false, promptBudgetReport(sectionName))
    const en = presentWorkflowFailure('prompt_budget_exhausted', 'safe report summary', shown('en-US'), false, promptBudgetReport(sectionName))
    expect(zh.guidance).toBe(sectionName === 'repair-contract' ? '请缩小本次任务范围后重试。' : '请缩小本次生成范围后重试。')
    expect(en.guidance).toBe(sectionName === 'repair-contract' ? 'Reduce this task scope and try again.' : 'Reduce this generation scope and try again.')
  })
})


it.each([
  ['UND_ERR_BODY_TIMEOUT', '读取响应流超时'],
  ['UND_ERR_SOCKET', '响应连接中断'],
  [undefined, '具体原因未知'],
] as const)('explains safe review transport diagnostics without inferring the upstream cause: %s', (causeCode, reason) => {
  const presentation = presentWorkflowFailure(undefined, 'generic provider failure', shown('zh-CN'), false, undefined, {
    operation: 'review-chapter', diagnostics: { startedAt: 0, elapsedMs: 478000, firstResponseMs: 3000, lastResponseMs: 171000,
      lastOutputMs: null, phase: 'stream', endReason: 'failed', visibleEvents: 0, reasoningEvents: 0, ...(causeCode ? { causeCode } : {}) },
  })
  expect(presentation.reason).toContain(reason)
  expect(presentation.persistence).toBe('本次未保存完整审稿报告，原稿保留。')
  expect(presentation.guidance).toContain('重新审稿会重新调用模型')
})

describe('generation error codes on the run card', () => {
  it('explains a rejected re-review instead of showing the raw IPC error', () => {
    const raw = "Error invoking remote method 'generation:begin': Error: GENERATION_DRAFT_NOT_CURRENT"
    const review = presentWorkflowFailure(undefined, raw, shown('zh-CN'), false, undefined, { operation: 'review-chapter' } as never)
    expect(review.reason).toContain('当前稿')
    expect(review.reason).not.toContain('Error invoking')
    const english = presentWorkflowFailure(undefined, raw, shown('en-US'), false)
    expect(english.reason).toContain('current draft')
    expect(english.reason).not.toContain('GENERATION_')
  })

  it('tells the author what to do when the next chapter cannot be saved', () => {
    const failure = presentWorkflowFailure(undefined, "Error invoking remote method 'generation:commit-draft': Error: GENERATION_DRAFT_DEPENDENCY_STALE", shown('zh-CN'), true)
    expect(failure.heading).toBe('工作流未完成')
    expect(failure.reason).toContain('前一章')
  })

  it('英文界面下非 GENERATION_ 前缀的登记码也按界面语言说明，不显示原码（#471）', () => {
    expect(presentWorkflowFailure(undefined, 'LEGACY_ROSTER_GENERATION_CANCELLED', shown('en-US'), false).reason)
      .toBe('Generation was cancelled.')
    expect(presentWorkflowFailure(undefined, "Error invoking remote method 'character-proposal:approve': Error: CHARACTER_PROPOSAL_SOURCE_CHANGED", shown('en-US'), false).reason)
      .toBe('The settings, blueprint, or earlier text this generation relied on changed while it ran, so the result was not saved. Generate it again.')
    expect(presentWorkflowFailure(undefined, 'NO_DEFAULT_MODEL', shown('en-US'), false).reason)
      .toBe('The model for this generation could not be found. Select or add a model in Settings, then try again.')
  })

  it('keeps an uncoded reason as written', () => {
    expect(presentWorkflowFailure(undefined, '模型服务返回 HTTP 429', shown('zh-CN'), false).reason).toBe('模型服务返回 HTTP 429')
  })
})

describe('没登记的码不显示给作者，只进日志（#859）', () => {
  const GENERIC = { 'zh-CN': '出了意外问题，暂时说不清原因。请再试一次。', 'en-US': 'Something unexpected went wrong', 'ja-JP': '予期しない問題' } as const
  it.each([
    ['工作流未完成', 'zh-CN', 'MADE_UP_RUN_CODE', undefined],
    ['IPC 包着的码', 'en-US', "Error invoking remote method 'db:save': Error: MADE_UP_WRAPPED_CODE", undefined],
    ['审稿未完成', 'ja-JP', 'MADE_UP_REVIEW_CODE', { operation: 'review-chapter' }],
  ] as const)('%s（%s）', (_name, locale, raw, activity) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reason = presentWorkflowFailure(undefined, raw, shown(locale), false, undefined, activity as never).reason
    expect(reason).not.toMatch(/MADE_UP_/u)
    expect(reason).toContain(GENERIC[locale])
    expect(warn.mock.calls.flat().join(' ')).toContain(raw.replace(/^.*Error: /u, ''))
    warn.mockRestore()
  })
})
