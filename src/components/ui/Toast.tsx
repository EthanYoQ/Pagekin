import { pushToast, type ToastTone } from './ToastStack'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

const INK_TONE: Record<ToastType, ToastTone> = { success: 'ok', error: 'danger', warning: 'warn', info: 'info' }

function show(message: string, type: ToastType = 'info', duration = 4000) {
  pushToast({ tone: INK_TONE[type], message, duration })
}

export const toast = {
  success: (msg: string, duration = 3500) => show(msg, 'success', duration),
  error:   (msg: string, duration = 5000) => show(msg, 'error', duration),
  warning: (msg: string, duration = 4500) => show(msg, 'warning', duration),
  info:    (msg: string, duration = 4000) => show(msg, 'info', duration),
}
