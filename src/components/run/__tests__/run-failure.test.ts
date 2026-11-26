import { expect, it } from 'vitest'
import { runFailure } from '../run-failure'
import { PLOT_OUTLINE_RESUME_ERROR_CODE, PLOT_OUTLINE_SOURCE_CHANGED_ERROR_CODE } from '../../../services/workflows/commands/architecture.command'
import type { WorkflowRun } from '../../../stores/workflow-store'
import { shown } from '../../../i18n/__tests__/shown-locale'
import { note, type Failure } from '../../../shared/failure'

const failedOutline = (errorCode: string, error: string) => ({
  id: '运行', title: '生成故事架构', type: 'generate_architecture', status: 'failed', uiLocale: 'zh-CN', writingLanguage: 'zh-CN',
  projectPath: 'C:/projects/失乐园', projectSession: null, currentStepIndex: 0, error, errorCode,
  steps: [{ id: 'synopsis', name: '情节大纲', description: '', status: 'failed', logs: [], error, errorCode }],
}) as unknown as WorkflowRun

it('来源在途中变了的大纲失败：给出去架构页重新生成的入口，不提供必然被拒的断点续写', () => {
  const failure = runFailure(failedOutline(PLOT_OUTLINE_SOURCE_CHANGED_ERROR_CODE, '生成途中模型设置被修改……'), shown('zh-CN'))
  expect(failure.presentation.reason).toBe('生成途中模型设置被修改……')
  expect(failure.canRestartOutline).toBe(true)
  expect(failure.canResumeOutline).toBe(false)
})

it('输出长度中断的大纲失败仍走断点续写', () => {
  const failure = runFailure(failedOutline(PLOT_OUTLINE_RESUME_ERROR_CODE, '输出被截断'), shown('zh-CN'))
  expect(failure.canResumeOutline).toBe(true)
  expect(failure.canRestartOutline).toBe(false)
})

const withFailure = (failure: Failure, extra: Partial<WorkflowRun> = {}) => ({
  ...failedOutline('', ''), error: '', errorCode: undefined, failure, ...extra,
  steps: [{ id: 'synopsis', name: '情节大纲', description: '', status: 'failed', logs: [], error: '', failure, ...extra.steps?.[0] }],
}) as unknown as WorkflowRun

it('failure 带的续写去向出对应的按钮', () => {
  const resume = runFailure(withFailure({ note: note('大纲没有写完。', 'The outline is incomplete.'), recovery: 'resume-plot-outline' }), shown('zh-CN'))
  expect([resume.canResumeOutline, resume.canRestartOutline]).toEqual([true, false])
  const restart = runFailure(withFailure({ code: 'GENERATION_SOURCE_CHANGED', note: note('来源变了。', 'The source changed.'), recovery: 'restart-plot-outline' }), shown('zh-CN'))
  expect([restart.canResumeOutline, restart.canRestartOutline]).toEqual([false, true])
})

it('审稿失败带产生点写的说明时，诊断的兜底说明不盖掉它', () => {
  const failure: Failure = { code: 'GENERATION_CONTEXT_LENGTH_EXCEEDED', note: note('这一章太长，审稿放不下。', 'This chapter is too long to review.') }
  const run = withFailure(failure, { error: '这一章太长，审稿放不下。', steps: [{ generationActivity: { operation: 'review-chapter', diagnostics: { endReason: 'failed' } } }] } as never)
  expect(runFailure(run, shown('zh-CN')).presentation.reason).toBe('这一章太长，审稿放不下。')
})
