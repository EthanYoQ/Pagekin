import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useLocaleStore } from '../../../stores/locale-store'
import MarkdownContent from '../MarkdownContent'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initialLocale = useLocaleStore.getState()
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useLocaleStore.setState(initialLocale, true)
})

describe('模型输出里的思考过程', () => {
  it.each([
    ['zh-CN', true, '正在思考…'],
    ['zh-CN', false, '思考过程'],
    ['en-US', true, 'Thinking…'],
    ['en-US', false, 'Thinking process'],
  ] as const)('%s 界面、生成中 %s：折叠头写「%s」', async (locale, streaming, heading) => {
    useLocaleStore.setState({ locale })
    const content = streaming ? '<think>先列出人物关系' : '<think>先列出人物关系</think>正文'
    await act(async () => root.render(<MarkdownContent content={content} streaming={streaming} />))
    expect(host.querySelector('button')?.textContent).toBe(heading)
  })
})

describe('Windows 换行（CRLF）的文本', () => {
  it('编号列表每一行都按编号行显示', async () => {
    await act(async () => root.render(<MarkdownContent content={'1. 主角入城\r\n2. 盟友背叛\r\n3. 夜探档案馆'} />))
    expect([...host.querySelectorAll('.assistant-content > div')].map(row => row.textContent))
      .toEqual(['1.主角入城', '2.盟友背叛', '3.夜探档案馆'])
  })
})
