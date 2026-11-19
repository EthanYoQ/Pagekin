import { describe, expect, it } from 'vitest'
import { continuationInsert } from '../continuation-insert'

const accept = (doc: string, selected: string, output: string, occurrence = doc.indexOf(selected)) => {
  const change = continuationInsert(doc, occurrence + selected.length, output)
  return doc.slice(0, change.from) + change.insert + doc.slice(change.to)
}

describe('续写插在选区之后，作为独立段落', () => {
  it('选中段在两段之间：续写成为新的一段，上下段的空行照旧', () => {
    expect(accept('甲段。\n\n乙段。\n\n丙段。', '乙段。', '续写。')).toBe('甲段。\n\n乙段。\n\n续写。\n\n丙段。')
  })
  it('正文用单个换行分段时，续写也用单个换行', () => {
    expect(accept('甲段。\n乙段。\n丙段。', '乙段。', '续写。')).toBe('甲段。\n乙段。\n续写。\n丙段。')
  })
  it('Windows 换行的正文沿用 \\r\\n', () => {
    expect(accept('甲段。\r\n\r\n乙段。', '甲段。', '续写。')).toBe('甲段。\r\n\r\n续写。\r\n\r\n乙段。')
  })
  it('选中最后一段且文末没有换行：续写接成新的最后一段', () => {
    expect(accept('甲段。\n\n乙段。', '乙段。', '续写。')).toBe('甲段。\n\n乙段。\n\n续写。')
  })
  it('文末的换行留在续写之后', () => {
    expect(accept('甲段。\n\n乙段。\n', '乙段。', '续写。')).toBe('甲段。\n\n乙段。\n\n续写。\n')
  })
  it('选区停在段中：续写另起一段，段里剩下的文字再另起一段', () => {
    expect(accept('甲段前半，甲段后半。\n\n乙段。', '甲段前半，', '续写。')).toBe('甲段前半，\n\n续写。\n\n甲段后半。\n\n乙段。')
  })
  it('选区停在有缩进的段中：段里剩下的文字另起一段时也缩进', () => {
    expect(accept('　　甲前，甲后。\n\n　　乙段。', '甲前，', '续写。')).toBe('　　甲前，\n\n　　续写。\n\n　　甲后。\n\n　　乙段。')
  })
  it('选区停在英文段中：剩下的文字另起一段，不带开头的空格', () => {
    expect(accept('A one. B two.\n\nC three.', 'A one.', 'Next.')).toBe('A one.\n\nNext.\n\nB two.\n\nC three.')
  })
  it('选区带上了段尾换行：续写仍是选中段之后的一段', () => {
    expect(accept('甲段。\n\n乙段。\n\n丙段。', '乙段。\n\n', '续写。')).toBe('甲段。\n\n乙段。\n\n续写。\n\n丙段。')
  })
  it('模型输出自带空行、多段或首尾空白时，按正文的分段方式重排', () => {
    expect(accept('甲段。\n乙段。', '甲段。', '\n\n续一。\n\n\n续二。\n')).toBe('甲段。\n续一。\n续二。\n乙段。')
  })
  it('正文段首有全角缩进时，续写的每段也缩进', () => {
    expect(accept('　　甲段。\n\n　　乙段。', '甲段。', '续一。\n　　续二。')).toBe('　　甲段。\n\n　　续一。\n\n　　续二。\n\n　　乙段。')
  })
  it('只有一段的正文用空行分段', () => {
    expect(accept('甲段。', '甲段。', '续写。')).toBe('甲段。\n\n续写。')
  })
})

it('设定文档（Markdown）里续写，嵌套列表和代码缩进照原样保留', () => {
  const doc = '## 势力\n\n- 港务局'
  const change = continuationInsert(doc, doc.length, '\n- 灯塔\n  - 周砚\n\n```\n  旧钟\n```\n', false)
  expect(doc.slice(0, change.from) + change.insert + doc.slice(change.to)).toBe('## 势力\n\n- 港务局\n\n- 灯塔\n  - 周砚\n\n```\n  旧钟\n```')
})
