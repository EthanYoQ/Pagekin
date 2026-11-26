const LINE_BREAKS = /(?:\r?\n)+/g

export function continuationInsert(doc: string, selectionEnd: number, output: string, prose = true): { from: number; to: number; insert: string } {
  const before = doc.slice(0, selectionEnd), after = doc.slice(selectionEnd)
  const trailing = /(?:\r?\n)*$/.exec(before)![0], leading = /^(?:\r?\n)*/.exec(after)![0]
  const midParagraph = !trailing && !leading && after !== ''
  const from = selectionEnd - trailing.length, to = selectionEnd + (midParagraph ? /^[ \t]*/.exec(after)![0].length : leading.length)
  const gap = trailing + leading, rest = doc.slice(to)
  const separator = [...doc.slice(0, from).matchAll(LINE_BREAKS)].at(-1)?.[0] || (rest && gap)
    || [...rest.matchAll(/(?:\r?\n)+(?=[^\r\n])/g)][0]?.[0] || '\n\n'
  const indent = /^[ \t\u3000]*/.exec(doc.slice(doc.lastIndexOf('\n', from - 1) + 1))![0]
  const body = !prose ? output.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd() : output.split(LINE_BREAKS).map(line => line.trim()).filter(Boolean).map(line => indent + line).join(separator)
  return { from, to, insert: (from > 0 ? separator : '') + body + (rest ? gap || separator + (midParagraph ? indent : '') : gap) }
}
