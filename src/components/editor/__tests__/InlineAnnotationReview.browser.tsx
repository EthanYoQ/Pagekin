import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
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
  it('只用键盘也能展开一处修改并接受', async () => {
    const commit = vi.fn(async () => {})
    await act(async () => root.render(<InlineAnnotationReview before="春天到了。" after="秋天到了。" annotations={[]} onCommit={commit} onCancel={() => {}} />))
    await userEvent.keyboard('{Tab}')
    await expect.element(page.getByRole('button', { name: '查看修改 1' })).toHaveFocus()
    await act(async () => userEvent.keyboard('{Enter}'))
    await expect.element(page.getByRole('button', { name: '查看修改 1' })).toHaveAttribute('aria-expanded', 'true')
    await act(async () => page.getByRole('button', { name: '接受', exact: true }).click())
    expect(commit).toHaveBeenCalledWith('秋天到了。')
  })
})

const BEFORE = [
  '守塔人的屋子在灯塔背风的一侧，窗玻璃上积着经年的盐。',
  '他给林岚倒了一杯很淡的茶，自己却只是捧着杯子，看着炉火。',
  '「你父亲也问过钟的事。」他说完这句话，就再也没有开口。',
].join('\n\n')
const AFTER = [
  '守塔人的屋子在灯塔背风的一侧，窗玻璃上积着厚厚一层白霜。',
  '他给她倒了一杯很淡的茶，自己却只是捧着杯子，看着炉火。',
  '「你父亲也问过钟的事。」他说完这句话，就再也没有开口，只是抬头望向塔顶。',
].join('\n\n')
const NO_LINE_START = '，。、；：！？）」』'

type Item = { char: string; rect: DOMRect }
function layoutLines(prose: Element) {
  const items: Item[] = []
  const walk = (node: Node) => {
    if (node instanceof Element && node.matches('svg, .inline-annotation-actions')) { items.push({ char: '', rect: node.getBoundingClientRect() }); return }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent!
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') { items.push({ char: '\n', rect: new DOMRect() }); continue }
        const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1)
        const rect = range.getBoundingClientRect()
        if (rect.width) items.push({ char: text[i]!, rect })
      }
      return
    }
    node.childNodes.forEach(walk)
  }
  walk(prose)
  const lines: Item[][] = [[]]
  let lastBottom = -Infinity
  for (const item of items) {
    if (item.char === '\n') { if (lines.at(-1)!.length) lines.push([]); lines.at(-1)!.push(item); lastBottom = -Infinity; continue }
    if (item.rect.top >= lastBottom - 1 && lines.at(-1)!.some(entry => entry.char !== '\n')) lines.push([])
    lines.at(-1)!.push(item)
    lastBottom = Math.max(lastBottom, item.rect.bottom)
  }
  return lines.map(line => line.filter(item => item.char !== '\n')).filter(line => line.length)
}

describe('逐处审阅的断行', () => {
  for (const width of [612, 460, 440, 349, 340]) for (const state of ['', '、展开一处修改', '、全部接受']) {
    it(`修改片段像正文一样断行，宽 ${width}px${state}`, async () => {
      await act(async () => root.render(<div className="paper-ink" style={{ width }}><InlineAnnotationReview before={BEFORE} after={AFTER} annotations={[]} onCommit={async () => {}} onCancel={() => {}} /></div>))
      if (state === '、展开一处修改') await act(async () => page.getByRole('button', { name: '查看修改 3' }).click())
      if (state === '、全部接受') await act(async () => page.getByRole('button', { name: '接受全部' }).click())
      const prose = host.querySelector('.inline-annotation-prose')!
      const right = prose.getBoundingClientRect().right
      const lines = layoutLines(prose)
      expect(lines.length).toBeGreaterThan(3)
      const lineStarts = lines.map(line => line[0]!.char).filter(char => NO_LINE_START.includes(char) && char)
      expect(lineStarts).toEqual([])
      lines.slice(0, -1).forEach((line, i) => {
        const next = lines[i + 1]!
        if (next[0]!.rect.top - line.at(-1)!.rect.bottom > line.at(-1)!.rect.height) return
        const room = right - line.at(-1)!.rect.right
        const pulled = next[0]!.rect.width + (next[1] && NO_LINE_START.includes(next[1].char) && next[1].char ? next[1].rect.width : 0)
        expect(room, `第 ${i + 1} 行末尾还空着 ${Math.round(room)}px，下一行以「${next.map(item => item.char).join('').slice(0, 6)}」开头`).toBeLessThan(pulled + 4)
      })
    })
  }
})
