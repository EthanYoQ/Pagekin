import { expect } from 'vitest'

import { failureText } from '../../i18n/app-errors'
import { shown } from '../../i18n/__tests__/shown-locale'
import type { Locale } from '../../i18n/types'
import { codeOf } from '../../shared/failure'
import type { WorkflowRun, WorkflowStep } from '../workflow-store'

/** 运行卡片上给作者看的那句；没有失败时是 undefined。 */
export const shownFailure = (record: Pick<WorkflowRun | WorkflowStep, 'failure'>, locale: Locale = 'zh-CN') =>
  record.failure && failureText(shown(locale), record.failure)

/** 记录（运行或步骤）记了这个状态，失败带原码。 */
export function expectEndedWith(record: WorkflowRun | WorkflowStep, status: WorkflowStep['status'], code: string): void {
  expect(record).toMatchObject({ status })
  expect(record.failure && codeOf(record.failure)).toBe(code)
}

/** 运行和第一步都记失败，失败带原码。 */
export function expectFailedWith(run: WorkflowRun, code: string): void {
  for (const record of [run, run.steps[0]!]) expectEndedWith(record, 'failed', code)
}
