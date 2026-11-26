import { useEffect, useId, type ReactNode } from 'react'
import { Button, type InkButtonVariant } from './Button'
import { useAnchoredLayer } from './use-anchored-layer'

interface PopoverProps {
  label: string
  title: string
  triggerVariant?: Exclude<InkButtonVariant, 'icon' | 'danger-solid'>
  align?: 'start' | 'end'
  children: ReactNode
}

export function Popover({ label, title, triggerVariant = 'secondary', align = 'start', children }: PopoverProps) {
  const { open, layerId, anchorRef, triggerRef, layerRef, renderLayer, toggle } = useAnchoredLayer(align)
  const titleId = useId()

  useEffect(() => {
    if (open) layerRef.current?.focus()
  }, [open, layerRef])

  return (
    <div className="pi-anchor" ref={anchorRef}>
      <Button
        ref={triggerRef}
        variant={triggerVariant}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? layerId : undefined}
        onClick={toggle}
      >
        {label}
      </Button>
      {open && renderLayer(
        <div
          id={layerId}
          ref={layerRef}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="pi-popover"
        >
          <h3 id={titleId} className="pi-popover-title">{title}</h3>
          {children}
        </div>
      )}
    </div>
  )
}
