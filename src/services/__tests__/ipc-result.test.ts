import { afterEach, expect, it, vi } from 'vitest'
import { requireIpcSuccess } from '../ipc-result'
import { useLocaleStore } from '../../stores/locale-store'
import { displayedErrorMessage } from '../../i18n/app-errors'
import { translate } from '../../i18n/core'
import { shown } from '../../i18n/__tests__/shown-locale'

const original = useLocaleStore.getState()
afterEach(() => useLocaleStore.setState(original, true))

it('explains a registered main-process code in the English interface (#474)', () => {
  useLocaleStore.setState({ locale: 'en-US' })
  expect(() => requireIpcSuccess({ success: false, error: 'Error: GENERATION_PROJECT_SESSION_STALE' }, '保存草稿'))
    .toThrow(/switched or reopened/iu)
})

it('falls back to English, not the Chinese action label, when the main process gives no reason (#474)', () => {
  useLocaleStore.setState({ locale: 'en-US' })
  expect(() => requireIpcSuccess({ success: false }, '保存草稿')).toThrow(/^The operation failed\.$/u)
  useLocaleStore.setState({ locale: 'zh-CN' })
  expect(() => requireIpcSuccess({ success: false }, '保存草稿')).toThrow(/^保存草稿失败$/u)
})

it('explains a registered main-process code in Japanese and keeps the inline fallback in English under a Japanese interface (#722)', () => {
  useLocaleStore.setState({ interfaceLocale: 'ja-JP', locale: 'en-US' })
  expect(() => requireIpcSuccess({ success: false, error: 'Error: GENERATION_PROJECT_SESSION_STALE' }, '保存草稿'))
    .toThrow(/作品が切り替えられた/u)
  expect(() => requireIpcSuccess({ success: false }, '保存草稿')).toThrow(/^The operation failed\.$/u)
})

it('keeps a registered main-process code on the thrown error so a frozen caller can explain it in its own language (#722)', () => {
  useLocaleStore.setState({ interfaceLocale: 'zh-CN', locale: 'zh-CN' })
  let thrown: unknown
  try {
    requireIpcSuccess({ success: false, error: 'Error: PROJECT_NOT_OPEN' }, '导出')
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toBe(translate('zh-CN', 'error.projectNotOpen'))
  expect(displayedErrorMessage(shown('ja-JP'), thrown)).toBe(translate('ja-JP', 'error.projectNotOpen'))
})

it('requireIpcSuccess 遇到没有码的主进程原文时不显示原文', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const locale of ['zh-CN', 'en-US'] as const) {
    useLocaleStore.setState({ interfaceLocale: locale, locale })
    for (const error of ['Error: 项目数据库未打开', 'connect ECONNREFUSED 127.0.0.1:7890', 'WORKFLOW_UNREGISTERED_TEST_CODE']) {
      let thrown: unknown
      try { requireIpcSuccess({ success: false, error }, '保存草稿', '兜底说明') } catch (caught) { thrown = caught }
      expect((thrown as Error).message, `${locale} ${error}`).toBe('兜底说明')
    }
  }
  expect(warn.mock.calls.flat().map(String).join(' ')).toContain('connect ECONNREFUSED 127.0.0.1:7890')
  warn.mockRestore()
})
