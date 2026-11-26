import { useEffect, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { clsx } from 'clsx'
import { Button } from '../../ui/Button'
import type { useAnchoredLayer } from '../../ui/use-anchored-layer'

export default function SplitAction({ layer, label, icon, onRun, disabled, busy, optionsLabel, popoverClassName, children }: {
  layer: ReturnType<typeof useAnchoredLayer>
  label: string
  icon: ReactNode
  onRun: () => void
  disabled?: boolean
  busy?: boolean
  optionsLabel: string
  popoverClassName: string
  children: ReactNode
}) {
  const { open, layerId, anchorRef, triggerRef, layerRef, renderLayer, toggle } = layer

  useEffect(() => {
    if (open) layerRef.current?.focus()
  }, [open, layerRef])

  return (
    <div className={clsx('pi-anchor pi-split', disabled && !busy && 'pi-split--main-off')} ref={anchorRef}>
      <Button variant="primary" className="pi-split-main" disabled={disabled || busy} aria-busy={busy || undefined} onClick={onRun}>
        {icon}{label}
      </Button>
      <Button
        ref={triggerRef}
        variant="primary"
        className="pi-split-toggle"
        aria-label={optionsLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? layerId : undefined}
        onClick={toggle}
      >
        <ChevronDown size={14} aria-hidden />
      </Button>
      {open && renderLayer(
        <div id={layerId} ref={layerRef} role="dialog" aria-label={optionsLabel} tabIndex={-1} className={`pi-popover ${popoverClassName}`}>
          {children}
        </div>,
      )}
    </div>
  )
}
