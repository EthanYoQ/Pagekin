const LINE_BREAKS = /(?:\r?\n)+/g

/**
 * 续写接在选区末尾，作为独立的段落：段间换行与段首缩进照抄选区附近的正文。
 * 返回要替换的范围（选区末尾两侧的换行）和替换成的文字。
 */
export function continuationInsert(doc: string, selectionEnd: number, output: string, prose = true): { from: number; to: number; insert: string } {
  const before = doc.slice(0, selectionEnd), after = doc.slice(selectionEnd)
  const trailing = /(?:\r?\n)*$/.exec(before)![0], leading = /^(?:\r?\n)*/.exec(after)![0]
  // 选区停在段中：段里剩下的文字另起一段，去掉它开头的空格，下面补上段首缩进。
  const midParagraph = !trailing && !leading && after !== ''
  const from = selectionEnd - trailing.length, to = selectionEnd + (midParagraph ? /^[ \t]*/.exec(after)![0].length : leading.length)
  const gap = trailing + leading, rest = doc.slice(to)
  const separator = [...doc.slice(0, from).matchAll(LINE_BREAKS)].at(-1)?.[0] || (rest && gap)
    || [...rest.matchAll(/(?:\r?\n)+(?=[^\r\n])/g)][0]?.[0] || '\n\n'
  const indent = /^[ \t\u3000]*/.exec(doc.slice(doc.lastIndexOf('\n', from - 1) + 1))![0]
  // 设定文档是 Markdown，缩进和空行是结构，只去掉首尾空行。
  const body = !prose ? output.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd() : output.split(LINE_BREAKS).map(line => line.trim()).filter(Boolean).map(line => indent + line).join(separator)
  return { from, to, insert: (from > 0 ? separator : '') + body + (rest ? gap || separator + (midParagraph ? indent : '') : gap) }
}
