import { useRef, type RefObject } from 'react'

export function rememberFocus(container: Element | null, openerRef?: RefObject<HTMLElement | null>): () => void {
  const active = document.activeElement
  const opener = active instanceof HTMLElement && active !== document.body ? active : null
  const fallbacks: HTMLElement[] = []
  for (let node = container?.parentElement; node; node = node.parentElement) {
    if (node.hasAttribute('tabindex')) fallbacks.push(node)
  }
  return () => {
    for (const target of [openerRef ? openerRef.current : opener, ...fallbacks]) {
      if (!target?.isConnected) continue
      target.focus()
      if (document.activeElement === target) return
    }
  }
}

export function useDialogFocusReturn() {
  const restore = useRef<() => void>(() => {})
  return {
    remember: () => { restore.current = rememberFocus(document.activeElement) },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault()
      const active = document.activeElement
      const dialog = event.currentTarget
      if (!active || active === document.body || (dialog instanceof Node && dialog.contains(active))) restore.current()
    },
  }
}
