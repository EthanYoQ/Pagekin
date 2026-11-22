import { afterEach, describe, expect, it } from 'vitest'

import '../../../styles/paper-ink/index.css'

let host: HTMLDivElement | undefined

afterEach(() => {
  host?.remove()
  host = undefined
})

async function advance(lang: string, className: string, char: string, fontFamily?: string) {
  host?.remove()
  host = document.createElement('div')
  host.className = 'paper-ink'
  host.lang = lang
  const span = document.createElement('span')
  span.className = className
  span.style.fontSize = '40px'
  span.style.letterSpacing = '0'
  if (fontFamily) span.style.fontFamily = fontFamily
  span.textContent = char
  host.append(span)
  document.body.append(host)
  await document.fonts.load(getComputedStyle(span).font, char)
  return span.getBoundingClientRect().width / 40
}

const surfaces = ['', 'pi-dialog-title']

describe('弯引号宽度跟界面语言走', () => {
  it('英文界面的撇号与引号按拉丁比例宽度显示', async () => {
    for (const className of surfaces) {
      for (const char of ['’', '‘', '“', '”']) {
        expect(await advance('en-US', className, char), `${className || '界面正文'} ${char}`).toBeLessThan(0.6)
      }
    }
  })

  it('中文界面的引号与直角引号仍是全角', async () => {
    for (const className of surfaces) {
      for (const char of ['“', '”', '‘', '’', '「']) {
        expect(await advance('zh-CN', className, char), `${className || '界面正文'} ${char}`).toBeCloseTo(1, 2)
      }
    }
  })
})

describe('省略号与间隔点宽度跟界面语言走', () => {
  const faces = [
    { className: '', en: '"Inter"', zh: '"Noto Sans SC"' },
    { className: 'pi-dialog-title', en: '"Instrument Serif"', zh: '"Noto Serif SC"' },
  ]

  it('英文界面的 … · • 与界面、标题各自拉丁字体的宽度一致', async () => {
    for (const { className, en } of faces) {
      for (const char of ['…', '·', '•']) {
        const expected = await advance('en-US', className, char, en)
        const actual = await advance('en-US', className, char)
        expect(Math.abs(actual - expected), `${className || '界面正文'} ${char} ${actual} vs ${expected}`).toBeLessThan(0.02)
      }
    }
  })

  it('中文界面的 … · • 仍用 Noto SC 的字形', async () => {
    for (const { className, zh } of faces) {
      for (const char of ['…', '·', '•']) {
        const expected = await advance('zh-CN', className, char, zh)
        expect(await advance('zh-CN', className, char), `${className || '界面正文'} ${char}`).toBeCloseTo(expected, 2)
      }
    }
  })
})
