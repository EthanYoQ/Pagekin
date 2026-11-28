/* eslint-disable react-refresh/only-export-components */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { ErrorBoundary } from '../ErrorBoundary'
import { useLocaleStore } from '../../stores/locale-store'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RAW_MESSAGE = 'Cannot read properties of undefined (reading chapterTitle)'
let broken = true

function ChapterPreviewCrasher() {
  if (broken) throw new TypeError(RAW_MESSAGE)
  return <p>章节预览已恢复</p>
}

const locales = [
  { name: 'zh-CN', state: { interfaceLocale: 'zh-CN', locale: 'zh-CN' }, retry: '重试', copy: '复制诊断信息', copied: '已复制', failed: '复制失败' },
  { name: 'en-US', state: { interfaceLocale: 'en-US', locale: 'en-US' }, retry: 'Retry', copy: 'Copy diagnostics', copied: 'Copied', failed: 'Copy failed' },
  { name: 'ja-JP', state: { interfaceLocale: 'ja-JP', locale: 'en-US' }, retry: '再試行', copy: '診断情報をコピー', copied: 'コピーしました', failed: 'コピーに失敗しました' },
] as const

let root: Root
let container: HTMLDivElement
let writeText: ReturnType<typeof vi.fn>
let consoleError: MockInstance<typeof console.error>

beforeEach(() => {
  broken = true
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(navigator, 'clipboard')
  useLocaleStore.setState({ interfaceLocale: 'zh-CN', locale: 'zh-CN' })
  vi.restoreAllMocks()
})

function button(label: string) {
  const found = [...container.querySelectorAll('button')].find(node => node.textContent?.includes(label))
  if (!found) throw new Error(`没有找到按钮「${label}」，面板文本：${container.textContent}`)
  return found
}

describe.each(locales)('组件出错面板（$name）', ({ state, retry, copy, copied, failed }) => {
  beforeEach(() => { useLocaleStore.setState(state) })

  it('面板不显示异常原文与组件栈，原文与组件栈写进日志', async () => {
    await act(async () => root.render(<ErrorBoundary><ChapterPreviewCrasher /></ErrorBoundary>))

    const shown = container.textContent ?? ''
    expect(shown).not.toContain(RAW_MESSAGE)
    expect(shown).not.toContain('ChapterPreviewCrasher')
    expect(shown).not.toContain('TypeError')
    button(retry)
    button(copy)
    const logged = consoleError.mock.calls.find(args => args.some(arg => arg instanceof TypeError && arg.message === RAW_MESSAGE))
    expect(logged).toBeDefined()
    expect(JSON.stringify(logged?.map(arg => arg instanceof Error ? arg.message : arg))).toContain('ChapterPreviewCrasher')
  })

  it('复制诊断信息把原文与组件栈写进剪贴板，并提示已复制', async () => {
    await act(async () => root.render(<ErrorBoundary><ChapterPreviewCrasher /></ErrorBoundary>))

    await act(async () => button(copy).click())

    expect(writeText).toHaveBeenCalledTimes(1)
    const diagnostics = String(writeText.mock.calls[0][0])
    expect(diagnostics).toContain(RAW_MESSAGE)
    expect(diagnostics).toContain('ChapterPreviewCrasher')
    await vi.waitFor(() => expect(container.textContent).toContain(copied))
  })

  it('剪贴板写入失败时提示复制失败', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    await act(async () => root.render(<ErrorBoundary><ChapterPreviewCrasher /></ErrorBoundary>))

    await act(async () => button(copy).click())

    await vi.waitFor(() => expect(container.textContent).toContain(failed))
    expect(container.textContent).not.toContain(copied)
  })

  it('重试后重新渲染子组件', async () => {
    await act(async () => root.render(<ErrorBoundary><ChapterPreviewCrasher /></ErrorBoundary>))
    broken = false

    await act(async () => button(retry).click())

    expect(container.textContent).toContain('章节预览已恢复')
  })
})
