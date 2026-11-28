import { expect, it } from 'vitest'

import { failureText } from '../../i18n/app-errors'
import { shown } from '../../i18n/__tests__/shown-locale'
import { failureCode, note } from '../../shared/failure'
import { failureOr } from '../failure-reason'

const SAVE = note('草稿保存失败', 'Could not save the draft')

it('原因说不清时保留这一处的说明', () => {
  const zh = shown('zh-CN'); const en = shown('en-US')
  const unregistered = failureCode('SQLITE_FULL')!
  expect(failureText(zh, failureOr(SAVE, { code: unregistered }))).toBe('草稿保存失败')
  expect(failureText(en, failureOr(SAVE, { code: unregistered }))).toBe('Could not save the draft')
  expect(failureText(zh, failureOr(SAVE, { code: failureCode('PROJECT_NOT_OPEN')! }))).toBe('请先打开项目。')
  expect(failureText(zh, failureOr(SAVE, undefined))).toBe('草稿保存失败')
})
