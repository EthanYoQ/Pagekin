import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

const GAP = 6
const MARGIN = 8
const TABBABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]'

const tabbablesIn = (layer: HTMLElement) =>
  [...layer.querySelectorAll<HTMLElement>(TABBABLE)].filter((element) => element.tabIndex >= 0 && element.checkVisibility({ visibilityProperty: true }))

export function useAnchoredLayer(align: 'start' | 'end'): {
  open: boolean
  layerId: string
  anchorRef: RefObject<HTMLDivElement | null>
  triggerRef: RefObject<HTMLButtonElement | null>
  layerRef: RefObject<HTMLDivElement | null>
  renderLayer: (layer: ReactNode) => ReactNode
  show: () => void
  toggle: () => void
  close: (returnFocus: boolean) => void
} {
  const [open, setOpen] = useState(false)
  const layerId = useId()
  const anchorRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const placedAt = useRef<DOMRect | null>(null)
  const [root, setRoot] = useState<Element | null>(null)
  const findRoot = useCallback(() => setRoot(anchorRef.current?.closest('.paper-ink') ?? null), [])

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  useLayoutEffect(() => {
    const layer = layerRef.current
    const trigger = triggerRef.current
    if (!open || !layer || !trigger) return
    const rect = trigger.getBoundingClientRect()
    placedAt.current = anchorRef.current?.getBoundingClientRect() ?? null
    const { clientWidth, clientHeight } = document.documentElement
    const below = clientHeight - rect.bottom - GAP - MARGIN
    const above = rect.top - GAP - MARGIN
    const upward = layer.offsetHeight > below && above > below
    layer.style.maxHeight = `${upward ? above : below}px`
    layer.toggleAttribute('data-upward', upward)
    if (upward) layer.style.bottom = `${clientHeight - rect.top + GAP}px`
    else layer.style.top = `${rect.bottom + GAP}px`
    const widest = clientWidth - layer.offsetWidth - MARGIN
    if (align === 'end') layer.style.right = `${Math.min(Math.max(MARGIN, clientWidth - rect.right), widest)}px`
    else layer.style.left = `${Math.min(Math.max(MARGIN, rect.left), widest)}px`
  }, [open, align])

  useEffect(() => {
    const layer = layerRef.current
    const anchor = anchorRef.current
    if (!open || !layer || !anchor) return
    const inside = (target: EventTarget | null) => target instanceof Node && (anchor.contains(target) || layer.contains(target))
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) close(false)
    }
    const onFocusIn = (event: FocusEvent) => {
      if (!inside(event.target)) close(false)
    }
    const onScroll = () => {
      const now = anchor.getBoundingClientRect()
      if (now.top !== placedAt.current?.top || now.left !== placedAt.current?.left) close(false)
    }
    const onResize = () => close(false)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close(true)
      }
    }
    const onLayerKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const tabbables = tabbablesIn(layer)
      const active = document.activeElement
      if (event.shiftKey && (tabbables.length === 0 || active === layer || active === tabbables[0])) {
        event.preventDefault()
        close(true)
      } else if (!event.shiftKey && (tabbables.length === 0 || active === tabbables[tabbables.length - 1])) {
        close(true)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    anchor.addEventListener('keydown', onKeyDown)
    layer.addEventListener('keydown', onKeyDown)
    layer.addEventListener('keydown', onLayerKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      anchor.removeEventListener('keydown', onKeyDown)
      layer.removeEventListener('keydown', onKeyDown)
      layer.removeEventListener('keydown', onLayerKeyDown)
    }
  }, [open, close])

  return {
    open,
    layerId,
    anchorRef,
    triggerRef,
    layerRef,
    renderLayer: (layer) => (root ? createPortal(layer, root) : layer),
    show: useCallback(() => {
      findRoot()
      setOpen(true)
    }, [findRoot]),
    toggle: useCallback(() => {
      findRoot()
      setOpen((value) => !value)
    }, [findRoot]),
    close,
  }
}
