import { RangeSetBuilder } from '@codemirror/state'
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'

const indented = Decoration.line({ class: 'cm-indent' })
const NOT_PARAGRAPH = /^(?:#{1,6}\s|(?:[-*_＊※◇◆○●—·~～]\s*){3,}$)/

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    for (let position = from; position <= to;) {
      const line = view.state.doc.lineAt(position)
      if (/^\S/.test(line.text) && !NOT_PARAGRAPH.test(line.text)) builder.add(line.from, line.from, indented)
      position = line.to + 1
    }
  }
  return builder.finish()
}

export const paragraphIndent = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = build(view)
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) this.decorations = build(update.view)
  }
}, { decorations: plugin => plugin.decorations })
