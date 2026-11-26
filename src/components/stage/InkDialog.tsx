import { useRef, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { keepToastStackClickable } from '../ui/ToastStack'
import { usePaperInkRoot } from '../ui/use-paper-ink-root'

interface InkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  footer: ReactNode
  keepOnOutsideClick?: boolean
}

export function InkDialog({ open, onOpenChange, title, description, children, footer, keepOnOutsideClick = false }: InkDialogProps) {
  const sentinelRef = useRef<HTMLSpanElement>(null)
  const root = usePaperInkRoot(sentinelRef)
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <span ref={sentinelRef} hidden />
      {root !== undefined && (
        <DialogPrimitive.Portal container={root}>
          <DialogPrimitive.Overlay className="pi-scrim" />
          <DialogPrimitive.Content className="pi-dialog stage-dialog" onPointerDownOutside={event => {
            keepToastStackClickable(event)
            if (keepOnOutsideClick) event.preventDefault()
          }} {...(description ? {} : { 'aria-describedby': undefined })}>
            <div className="pi-dialog-head">
              <DialogPrimitive.Title className="pi-dialog-title">{title}</DialogPrimitive.Title>
            </div>
            <div className="pi-dialog-body">
              {description && <DialogPrimitive.Description className="pi-dialog-text">{description}</DialogPrimitive.Description>}
              {children}
            </div>
            <div className="pi-dialog-foot">{footer}</div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}
    </DialogPrimitive.Root>
  )
}
