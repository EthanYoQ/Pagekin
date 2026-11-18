/* eslint-disable react-refresh/only-export-components */
import { afterEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useLocaleStore } from '../locale-store'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initial = useLocaleStore.getState()
const win = window as unknown as { aiNovelAPI?: { invoke: (channel: string) => Promise<unknown>; on: () => () => void } }
let root: Root | undefined
let host: HTMLDivElement | undefined

function Copy() {
  const text = useLocaleStore(s => s.text)
  return <p>{text('第 {n} 章', 'Chapter {n}', '第 {n} 話', { n: 3 })}|{text('保存', 'Save')}</p>
}

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  delete win.aiNovelAPI
  useLocaleStore.setState(initial, true)
})

it('组件里用 hook 取的 text：日文界面显示写了的日文，没写的显示英文；切回中文、英文照旧', async () => {
  win.aiNovelAPI = { invoke: async () => ({ success: true }), on: () => () => undefined }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<Copy />))

  await act(async () => useLocaleStore.getState().setLocale('ja-JP'))
  expect(host.textContent).toBe('第 3 話|Save')
  await act(async () => useLocaleStore.getState().setLocale('zh-CN'))
  expect(host.textContent).toBe('第 3 章|保存')
  await act(async () => useLocaleStore.getState().setLocale('en-US'))
  expect(host.textContent).toBe('Chapter 3|Save')
})
