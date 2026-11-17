import { describe, expect, it } from 'vitest'
import { copyLocale, createTranslator, localize, resolveInterfaceLocale, resolveLocale, storedInterfaceLocale, translate } from '../core'

describe('i18n core', () => {
  it.each([
    ['zh-CN', 'zh-CN'],
    ['zh-TW', 'zh-CN'],
    ['en-US', 'en-US'],
    ['fr-FR', 'en-US'],
    ['ja-JP', 'en-US'],
    [undefined, 'en-US'],
  ] as const)('resolves %s to %s', (input, expected) => {
    expect(resolveLocale(input)).toBe(expected)
  })

  it.each([
    ['ja-JP', 'ja-JP'],
    ['ja', 'ja-JP'],
    ['zh-TW', 'zh-CN'],
    ['en-GB', 'en-US'],
    ['fr-FR', 'en-US'],
    [undefined, 'en-US'],
  ] as const)('resolves the interface language for %s to %s', (input, expected) => {
    expect(resolveInterfaceLocale(input)).toBe(expected)
  })

  it('accepts only supported stored interface languages', () => {
    expect(storedInterfaceLocale('ja-JP')).toBe('ja-JP')
    expect(storedInterfaceLocale('zh-CN')).toBe('zh-CN')
    expect(storedInterfaceLocale('ko-KR')).toBeUndefined()
    expect(storedInterfaceLocale(undefined)).toBeUndefined()
  })

  it('reads colocated copy in English for a Japanese interface', () => {
    expect(copyLocale('ja-JP')).toBe('en-US')
    expect(copyLocale('zh-CN')).toBe('zh-CN')
    expect(copyLocale('en-US')).toBe('en-US')
  })

  it('translates catalog messages into Japanese', () => {
    expect(translate('ja-JP', 'error.projectNotOpen')).toBe('先にプロジェクトを開いてください。')
    expect(translate('ja-JP', 'error.unknown', { message: '<b>Book</b>' })).toBe('問題が発生しました：<b>Book</b>')
  })

  it('translates and interpolates values as plain text', () => {
    expect(translate('en-US', 'error.unknown', { message: '<b>Book</b>' }))
      .toBe('Something went wrong: <b>Book</b>')
  })

  it('falls back to English and then the key', () => {
    const localTranslate = createTranslator({
      'en-US': { 'error.projectNotOpen': 'Open a project first.' },
      'zh-CN': {},
      'ja-JP': {},
    })

    expect(localTranslate('zh-CN', 'error.projectNotOpen')).toBe('Open a project first.')
    expect(localTranslate('ja-JP', 'error.projectNotOpen')).toBe('Open a project first.')
    expect(localTranslate('en-US', 'missing.key')).toBe('missing.key')
  })

  it('selects colocated UI copy and interpolates parameters', () => {
    expect(localize('zh-CN', '已关闭 {count} 个文件', 'Closed {count} files', { count: 3 }))
      .toBe('已关闭 3 个文件')
    expect(localize('en-US', '已关闭 {count} 个文件', 'Closed {count} files', { count: 3 }))
      .toBe('Closed 3 files')
  })
})
