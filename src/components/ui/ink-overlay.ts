import { useLayoutEffect, useState } from 'react'
import { useThemeStore } from '../../stores/theme-store'

const HOST_ID = 'ai-novel-ink-overlay'
const TOAST_MOUNT_ID = 'ai-novel-ink-toasts'
let unsubscribeTheme: (() => void) | undefined

export function inkOverlayHost(): HTMLElement {
  const existing = document.getElementById(HOST_ID)
  if (existing) return existing
  const host = document.createElement('div')
  host.id = HOST_ID
  host.className = 'paper-ink pi-overlay-host'
  host.dataset.theme = useThemeStore.getState().resolvedTheme
  unsubscribeTheme?.()
  unsubscribeTheme = useThemeStore.subscribe(state => { host.dataset.theme = state.resolvedTheme })
  const toasts = document.createElement('div')
  toasts.id = TOAST_MOUNT_ID
  toasts.setAttribute('aria-live', 'polite')
  host.append(toasts)
  document.body.append(host)
  return host
}

export function toastStackMount(): HTMLElement {
  inkOverlayHost()
  return document.getElementById(TOAST_MOUNT_ID)!
}

export function createInkOverlayMount(): HTMLElement {
  const mount = document.createElement('div')
  mount.className = 'pi-prompt-layer'
  inkOverlayHost().append(mount)
  return mount
}

export function useInkOverlayHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHost(inkOverlayHost())
  }, [])
  return host
}
