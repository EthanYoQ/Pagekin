import { useSyncExternalStore } from 'react'

let now = Date.now()
let timer: number | undefined
const listeners = new Set<() => void>()

function tick() {
  now = Date.now()
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    now = Date.now()
    timer = window.setInterval(tick, 1000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.clearInterval(timer)
  }
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now)
}
