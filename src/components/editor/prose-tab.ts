import { Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'

const KEEPS_TAB_FOCUS_MODE = new Set(['Escape', 'Tab', 'Shift', 'Control', 'Alt', 'Meta'])

export const proseTab = Prec.highest([
  keymap.of([
    {
      key: 'Escape',
      run: (view) => {
        view.setTabFocusMode(true)
        return false
      },
    },
    {
      key: 'Tab',
      run: (view) => {
        if (view.state.readOnly || view.state.selection.ranges.length !== 1 || !view.state.selection.main.empty) return false
        view.dispatch({
          changes: { from: view.state.selection.main.head, insert: '\u2003\u2003' },
          selection: { anchor: view.state.selection.main.head + 2 },
        })
        return true
      },
    },
  ]),
  EditorView.domEventHandlers({
    keydown: (event, view) => {
      if (!KEEPS_TAB_FOCUS_MODE.has(event.key)) view.setTabFocusMode(false)
      return false
    },
    blur: (_event, view) => {
      view.setTabFocusMode(false)
      return false
    },
  }),
])
