import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { appErrorMessage, displayedErrorMessage } from '../app-errors'
import { translate } from '../core'
import { shown } from './shown-locale'

const RAW = 'TypeError: Cannot read properties of undefined (reading \'chapters\')'
const BARE = 'Cannot read properties of undefined (reading \'chapters\')'

let warn: MockInstance<typeof console.warn>
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

const logged = () => warn.mock.calls.flat().map(value => typeof value === 'object' && value !== null ? String((value as { message?: unknown }).message) : String(value)).join('\n')

describe('没标记的错误显示通用说明，原文只进日志', () => {
  it.each([
    ['Error', () => new Error(RAW)],
    ['字符串', () => RAW],
    ['带 message 的普通对象', () => ({ message: RAW })],
  ])('%s', (_kind, make) => {
    for (const locale of ['zh-CN', 'en-US', 'ja-JP'] as const) {
      const generic = translate(shown(locale), 'error.unregisteredCode')
      expect(displayedErrorMessage(shown(locale), make())).toBe(generic)
      expect(displayedErrorMessage(shown(locale), make(), '这一步没完成。')).toBe('这一步没完成。')
      expect(appErrorMessage(shown(locale), make())).toBe(generic)
    }
    expect(logged()).toContain(BARE)
  })

  it('完全没有内容时同样用通用说明', () => {
    const generic = translate(shown('en-US'), 'error.unregisteredCode')
    expect(displayedErrorMessage(shown('en-US'), new Error(''))).toBe(generic)
    expect(displayedErrorMessage(shown('en-US'), undefined)).toBe(generic)
    expect(appErrorMessage(shown('en-US'), {})).toBe(generic)
  })

  it('已登记的码照旧按目录说明', () => {
    expect(displayedErrorMessage(shown('en-US'), new Error('PROJECT_NOT_OPEN'))).toBe(translate(shown('en-US'), 'error.projectNotOpen'))
  })
})
