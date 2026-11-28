import { describe, expect, it } from 'vitest'
import { catalogNote, displayedErrorMessage, failureText } from '../app-errors'
import { SUPPORTED_LOCALES } from '../types'
import { shown } from './shown-locale'

describe('作者看到的报错不露码、不用内部用词', () => {
  it('AI 生成的小说配置写进作品后作品被切换：说明已保存，不退回成通用说明', () => {
    const error = new Error('GENERATION_CONFIG_COMMIT_FAILED')
    expect(displayedErrorMessage(shown('zh-CN'), error)).toBe('AI 生成的小说配置已保存。保存时作品被切换了，请重新打开该作品查看。')
    for (const locale of SUPPORTED_LOCALES) {
      expect(displayedErrorMessage(shown(locale), error)).not.toBe(displayedErrorMessage(shown(locale), new Error('UNKNOWN_CODE_SAMPLE')))
    }
  })

  it('修订稿合并不了时用作者的话说，不出现「身份」「资源」', () => {
    const shownText = (locale: (typeof SUPPORTED_LOCALES)[number]) => failureText(shown(locale), { note: catalogNote('error.mergeTargetUnresolved') })
    expect(shownText('zh-CN')).toBe('没能合并修订稿：草稿只读，或找不到对应的草稿和修订稿。')
    expect(shownText('en-US')).toBe('Could not merge the revision: the draft is read-only, or its draft or revision could not be found.')
    expect(shownText('ja-JP')).toBe('改稿を統合できませんでした。草稿が読み取り専用か、対応する草稿と改稿が見つかりません。')
  })
})
