import { describe, expect, it } from 'vitest'

import { caughtFailure, displayedErrorMessage, resultFailure } from '../../../i18n/app-errors'
import { translate } from '../../../i18n/core'
import { shown } from '../../../i18n/__tests__/shown-locale'
import type { ErrorDisplayLocale } from '../../../i18n/types'
import { workflowMainProcessError } from '../../../services/workflows/workflow-project-session'
import { note } from '../../../shared/failure'
import { blueprintFailureToast } from '../blueprint-failure-toast'

/** master 的拼法：概述、空一行、按界面语言显示的原因。 */
function legacySaveFailureToast(locale: ErrorDisplayLocale, error: unknown): string {
  const message = displayedErrorMessage(locale, error)
  return locale === 'zh-CN' ? `保存失败\n\n${message}` : `Could not save the blueprint.\n\n${message}`
}

const locales = [shown('zh-CN'), shown('en-US'), shown('ja-JP')]
const saveErrors = (locale: ErrorDisplayLocale) => ({
  registeredCode: workflowMainProcessError(locale, { code: 'PROJECT_NOT_OPEN' }, '保存章节蓝图失败', 'Could not save the chapter blueprint.'),
  mainProcessChinese: workflowMainProcessError(locale, resultFailure({ error: '磁盘空间不足' }), '保存章节蓝图失败', 'Could not save the chapter blueprint.'),
  unregisteredCode: workflowMainProcessError(locale, resultFailure({ error: 'BLUEPRINT_TEST_UNREGISTERED' }), '保存章节蓝图失败', 'Could not save the chapter blueprint.'),
  noReason: workflowMainProcessError(locale, undefined, '保存章节蓝图失败', 'Could not save the chapter blueprint.'),
  codeOnlyError: new Error('PROJECT_NOT_OPEN'),
})

describe('blueprint failure toast', () => {
  it.each(locales)('蓝图保存失败的 toast 与 master 逐字相同（%s）', locale => {
    for (const [name, error] of Object.entries(saveErrors(locale))) {
      expect(blueprintFailureToast(locale, note('保存失败', 'Could not save the blueprint.'), caughtFailure(error)), name)
        .toBe(legacySaveFailureToast(locale, error))
    }
  })

  it('概述和原因之间空一行，原因内部仍按句子接', () => {
    const zh = shown('zh-CN')
    const error = workflowMainProcessError(zh, { code: 'PROJECT_NOT_OPEN' }, '保存章节蓝图失败', 'Could not save the chapter blueprint.')
    expect(blueprintFailureToast(zh, note('保存失败', 'Could not save the blueprint.'), caughtFailure(error)))
      .toBe(`保存失败\n\n保存章节蓝图失败：${translate(zh, 'error.projectNotOpen')}`)
    expect(blueprintFailureToast(shown('en-US'), note('删除失败', 'Could not delete the chapter blueprint.'), caughtFailure('PROJECT_NOT_OPEN')))
      .toBe(`Could not delete the chapter blueprint.\n\n${translate(shown('en-US'), 'error.projectNotOpen')}`)
  })

  it.each(locales)('主进程回的异常原文不进 toast（%s）', locale => {
    const summary = note('清空失败', 'Could not clear the chapter blueprints.')
    const alone = blueprintFailureToast(locale, summary, undefined)
    expect(blueprintFailureToast(locale, summary, caughtFailure('SqliteError: database is locked'))).toBe(alone)
    expect(blueprintFailureToast(locale, summary, caughtFailure(new Error('数据库正忙')))).toBe(alone)
  })
})
