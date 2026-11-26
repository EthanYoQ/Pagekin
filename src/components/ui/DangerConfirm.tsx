import { useId, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { OctagonAlert } from 'lucide-react'
import { Button } from './Button'
import { useDialogFocusReturn } from './focus-return'
import { keepToastStackClickable } from './ToastStack'
import { usePaperInkRoot } from './use-paper-ink-root'

interface DangerConfirmProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  consequence: string
  recoverability: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  typeToConfirm?: { expected: string; label: string }
}

export function DangerConfirm({ open, onOpenChange, title, ...content }: DangerConfirmProps) {
  const sentinelRef = useRef<HTMLSpanElement>(null)
  const root = usePaperInkRoot(sentinelRef)
  const focusReturn = useDialogFocusReturn()

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <span ref={sentinelRef} hidden />
      {root !== undefined && (
        <DialogPrimitive.Portal container={root}>
          <DialogPrimitive.Overlay className="pi-scrim" />
          <DialogPrimitive.Content
            className="pi-dialog pi-dialog--marked"
            onPointerDownOutside={keepToastStackClickable}
            onOpenAutoFocus={focusReturn.remember}
            onCloseAutoFocus={focusReturn.onCloseAutoFocus}
          >
            <div className="pi-dialog-head">
              <span className="pi-dialog-mark" aria-hidden><OctagonAlert /></span>
              <DialogPrimitive.Title className="pi-dialog-title">{title}</DialogPrimitive.Title>
            </div>
            <DangerConfirmBody {...content} onClose={() => onOpenChange(false)} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}
    </DialogPrimitive.Root>
  )
}

function DangerConfirmBody({ consequence, recoverability, confirmLabel, cancelLabel, onConfirm, typeToConfirm, onClose }:
  Omit<DangerConfirmProps, 'open' | 'onOpenChange' | 'title'> & { onClose: () => void }) {
  const [typed, setTyped] = useState('')
  const inputId = useId()
  const confirmable = !typeToConfirm || typed === typeToConfirm.expected

  return (
    <>
      <div className="pi-dialog-body">
        <DialogPrimitive.Description asChild>
          <div className="pi-dialog-consequence">
            <p>{consequence}</p>
            <p className="pi-dialog-recover">{recoverability}</p>
          </div>
        </DialogPrimitive.Description>
        {typeToConfirm && (
          <label className="pi-field" htmlFor={inputId}>
            {typeToConfirm.label}
            <input
              id={inputId}
              className="pi-input"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
        )}
      </div>
      <div className="pi-dialog-foot">
        <DialogPrimitive.Close asChild>
          <Button variant="secondary">{cancelLabel}</Button>
        </DialogPrimitive.Close>
        <Button
          variant="danger-solid"
          disabled={!confirmable}
          onClick={() => {
            onConfirm()
            onClose()
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </>
  )
}
