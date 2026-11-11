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

/** 每秒刷新的当前时间，所有显示时长的地方共用一个时钟，同屏的数字才一致。只在显示时长的小组件里用。 */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now)
}
