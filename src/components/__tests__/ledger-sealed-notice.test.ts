import { describe, expect, it } from 'vitest'
import { useLocaleStore } from '../../stores/locale-store'
import { ledgerSealedNotice } from '../ledger-sealed-notice'

const textIn = (locale: 'zh-CN' | 'en-US' | 'ja-JP') => {
  useLocaleStore.setState({ interfaceLocale: locale, locale: locale === 'zh-CN' ? 'zh-CN' : 'en-US' })
  return useLocaleStore.getState().text
}

describe('打开作品时封存了生成记录的提示', () => {
  it('中文先说正文没受影响，报条数，只请作者反馈，不叫作者重新生成', () => {
    const { message } = ledgerSealedNotice(2, textIn('zh-CN'))
    expect(message).toMatch(/^正文没有受影响/)
    expect(message).toContain('2 条')
    expect(message).toContain('反馈')
    expect(message).not.toContain('重新生成')
  })

  it('英文按条数变单复数，不叫作者重新生成', () => {
    expect(ledgerSealedNotice(1, textIn('en-US')).title).toBe("An AI generation record couldn't be read")
    expect(ledgerSealedNotice(1, textIn('en-US')).message).toContain("1 AI generation record couldn't be read and was disabled")
    expect(ledgerSealedNotice(2, textIn('en-US')).message).toContain("2 AI generation records couldn't be read and were disabled")
    expect(ledgerSealedNotice(2, textIn('en-US')).message).not.toMatch(/generate again|regenerate/iu)
  })

  it('日文有自己的文案，报条数', () => {
    const notice = ledgerSealedNotice(2, textIn('ja-JP'))
    expect(notice.message).toMatch(/^本文は影響を受けていません/)
    expect(notice.message).toContain('2 件')
    expect(notice.title).toBe('読み取れない AI 生成記録があります')
  })
})
