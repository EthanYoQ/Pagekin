import { localize, type LocalizedText } from '../core'
import type { InterfaceLocale } from '../types'

/** tsc 检查：日文只能写在英文之后，参数对象只能放在最后。 */
export function japaneseCopyComesBeforeParams(text: LocalizedText, locale: InterfaceLocale): void {
  const params = { n: 1 }
  text('第 {n} 章', 'Chapter {n}', '第 {n} 章', params)
  localize(locale, '第 {n} 章', 'Chapter {n}', '第 {n} 章', params)
  // @ts-expect-error 参数对象不能放在日文之前
  text('第 {n} 章', 'Chapter {n}', params, '第 {n} 章')
  // @ts-expect-error 参数对象不能放在日文之前
  localize(locale, '第 {n} 章', 'Chapter {n}', params, '第 {n} 章')
  // @ts-expect-error 参数对象只有一个
  text('第 {n} 章', 'Chapter {n}', params, params)
  // @ts-expect-error 日文之后只能是参数对象
  text('保存', 'Save', '保存', '保存')
}
