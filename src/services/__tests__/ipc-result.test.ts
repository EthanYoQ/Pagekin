import { afterEach, expect, it } from 'vitest'
import { requireIpcSuccess } from '../ipc-result'
import { useLocaleStore } from '../../stores/locale-store'
import { displayedErrorMessage } from '../../i18n/app-errors'
import { translate } from '../../i18n/core'
import { shown } from '../../i18n/__tests__/shown-locale'

const SAVE_DRAFT = ['保存草稿', 'save the draft', '草稿の保存'] as const
const original = useLocaleStore.getState()
afterEach(() => useLocaleStore.setState(original, true))

it('explains a registered main-process code in the English interface (#474)', () => {
  useLocaleStore.setState({ locale: 'en-US' })
  expect(() => requireIpcSuccess({ success: false, error: 'Error: GENERATION_PROJECT_SESSION_STALE' }, SAVE_DRAFT))
    .toThrow(/switched or reopened/iu)
})

it('说不出原因时三种界面语言都写出动作名，且按显示时的语言说明', () => {
  useLocaleStore.setState({ interfaceLocale: 'zh-CN', locale: 'zh-CN' })
  let thrown: unknown
  try {
    requireIpcSuccess({ success: false }, SAVE_DRAFT)
  } catch (error) {
    thrown = error
  }
  expect(displayedErrorMessage(shown('zh-CN'), thrown)).toBe('没能保存草稿，请再试一次。')
  expect(displayedErrorMessage(shown('en-US'), thrown)).toBe('Could not save the draft. Try again.')
  expect(displayedErrorMessage(shown('ja-JP'), thrown)).toBe('草稿の保存に失敗しました。もう一度お試しください。')
})

it('explains a registered main-process code in Japanese under a Japanese interface (#722)', () => {
  useLocaleStore.setState({ interfaceLocale: 'ja-JP', locale: 'en-US' })
  expect(() => requireIpcSuccess({ success: false, error: 'Error: GENERATION_PROJECT_SESSION_STALE' }, SAVE_DRAFT))
    .toThrow(/作品が切り替えられた/u)
})

it('keeps a registered main-process code on the thrown error so a frozen caller can explain it in its own language (#722)', () => {
  useLocaleStore.setState({ interfaceLocale: 'zh-CN', locale: 'zh-CN' })
  let thrown: unknown
  try {
    requireIpcSuccess({ success: false, error: 'Error: PROJECT_NOT_OPEN' }, ['导出', 'export', 'エクスポート'])
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toBe(translate('zh-CN', 'error.projectNotOpen'))
  expect(displayedErrorMessage(shown('ja-JP'), thrown)).toBe(translate('ja-JP', 'error.projectNotOpen'))
})

