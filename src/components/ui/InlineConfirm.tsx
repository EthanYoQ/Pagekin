import { useEffect, useId, useRef, type KeyboardEvent, type RefObject } from 'react'
import { Button } from './Button'
import { rememberFocus } from './focus-return'

interface InlineConfirmProps {
  message: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
  returnFocusRef: RefObject<HTMLElement | null>
}

export function InlineConfirm({ message, confirmLabel, cancelLabel, onConfirm, onCancel, returnFocusRef }: InlineConfirmProps) {
  const messageId = useId()
  const groupRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const restoreFocus = rememberFocus(groupRef.current, returnFocusRef)
    cancelRef.current?.focus()
    return () => {
      if (!document.activeElement || document.activeElement === document.body) restoreFocus()
    }
  }, [returnFocusRef])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    <div ref={groupRef} className="pi-inline-confirm" role="group" aria-labelledby={messageId} onKeyDown={onKeyDown}>
      <p id={messageId} className="pi-inline-confirm-text">{message}</p>
      <Button ref={cancelRef} variant="text" size="sm" onClick={onCancel}>{cancelLabel}</Button>
      <Button variant="danger" size="sm" onClick={onConfirm}>{confirmLabel}</Button>
    </div>
  )
}
