import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import InlineAnnotationReview from '../InlineAnnotationReview'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('批注逐处审阅', () => {
  it('原文中展示红删绿增，逐处接受后自动提交', async () => {
    const commit = vi.fn(async () => {})
    await act(async () => root.render(<InlineAnnotationReview before="春雨落下。天色明亮。" after="秋雨落下。天色昏暗。" annotations={[]} onCommit={commit} onCancel={() => {}} />))
    expect(host.querySelectorAll('del').length).toBeGreaterThan(0)
    expect(host.querySelectorAll('ins').length).toBeGreaterThan(0)
    expect(page.getByRole('button', { name: /查看修改/ }).elements().length).toBeGreaterThan(1)
    await act(async () => page.getByRole('button', { name: '查看修改 1' }).click())
    await act(async () => page.getByRole('button', { name: '接受', exact: true }).click())
    expect(commit).not.toHaveBeenCalled()
    await act(async () => page.getByRole('button', { name: '接受全部' }).click())
    expect(commit).toHaveBeenCalledWith('秋雨落下。天色昏暗。')
  })
  it('手动修改候选后接受，使用作者修改的内容', async () => {
    const commit = vi.fn(async () => {})
    await act(async () => root.render(<InlineAnnotationReview before="春天到了" after="秋天到了" annotations={[]} onCommit={commit} onCancel={() => {}} />))
    await act(async () => page.getByRole('button', { name: '查看修改 1' }).click())
    await act(async () => page.getByRole('button', { name: '编辑' }).click())
    await act(async () => page.getByRole('textbox', { name: '编辑修改 1' }).fill('冬'))
    await act(async () => page.getByRole('button', { name: '接受', exact: true }).click())
    expect(commit).toHaveBeenCalledWith('冬天到了')
  })
  it('改的是扩展区汉字时，一处修改是完整的字，编辑后提交的正文没有残缺的半个字', async () => {
    const commit = vi.fn(async () => {})
    await act(async () => root.render(<InlineAnnotationReview before={'他叫\u{2000B}山'} after={'他叫\u{2000C}山'} annotations={[]} onCommit={commit} onCancel={() => {}} />))
    expect(host.querySelector('del')!.textContent).toBe('\u{2000B}')
    expect(host.querySelector('ins')!.textContent).toBe('\u{2000C}')
    await act(async () => page.getByRole('button', { name: '查看修改 1' }).click())
    await act(async () => page.getByRole('button', { name: '编辑' }).click())
    await act(async () => page.getByRole('textbox', { name: '编辑修改 1' }).fill('岳'))
    await act(async () => page.getByRole('button', { name: '接受', exact: true }).click())
    expect(commit).toHaveBeenCalledWith('他叫岳山')
  })
})
