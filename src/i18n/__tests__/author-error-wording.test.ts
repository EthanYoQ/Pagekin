import { describe, expect, it } from 'vitest'
import { displayedErrorMessage } from '../app-errors'
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
})
