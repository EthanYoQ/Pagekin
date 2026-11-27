import { describe, expect, it } from 'vitest'
import { enUS } from '../messages/en-US'
import { jaJP } from '../messages/ja-JP'

/** 日文界面里本来就照写英文的值：品牌名、文件格式、模型参数名这类专有名词。 */
const PROPER_NOUNS: ReadonlySet<string> = new Set([
  'app.windowTitle',
])

const ENGLISH_WORD = /[A-Za-z]{2,}/u
const withoutPlaceholders = (value: string) => value.replace(/\{\w+\}/gu, '')

export function copiedEnglishKeys(): string[] {
  const ja = jaJP as Record<string, string>
  return Object.entries(enUS as Record<string, string>)
    .filter(([key, en]) => !PROPER_NOUNS.has(key) && ja[key] === en && ENGLISH_WORD.test(withoutPlaceholders(en)))
    .map(([key]) => key)
}

describe('日文目录里没有照搬英文的说明', () => {
  it('ja-JP 与 en-US 值相同且含英文单词的键为 0', () => {
    expect(copiedEnglishKeys()).toEqual([])
  })
})
