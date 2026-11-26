import { useLocaleStore } from '../../stores/locale-store'
import { pushToast, type ToastTone } from './ToastStack'

export type ActionToastType = 'success' | 'info' | 'warning' | 'error' | 'ai'

export interface ActionToastAction {
  label: string
  onClick?: () => void | Promise<void>
  variant?: 'primary' | 'ghost'
}

export interface ActionToastOptions {
  type?: ActionToastType
  message: string
  actions?: ActionToastAction[]
  duration?: number
  onDismiss?: () => void
}

const INK_TONE: Record<ActionToastType, ToastTone> = { success: 'ok', info: 'info', warning: 'warn', error: 'danger', ai: 'info' }

function enqueue(options: ActionToastOptions): () => void {
  return pushToast({
    tone: INK_TONE[options.type ?? 'info'],
    message: options.message,
    actions: options.actions?.map(action => ({ label: action.label, onClick: action.onClick, emphasis: action.variant === 'ghost' ? 'text' : 'secondary' })),
    duration: options.duration ?? 8000,
    onDismiss: options.onDismiss,
  })
}

export const actionToast = {
  show: (options: ActionToastOptions) => enqueue(options),

  workflowComplete: (message: string, openAction?: () => void | Promise<void>) => {
    const actions: ActionToastAction[] = []
    if (openAction) {
      const text = useLocaleStore.getState().text
      actions.push({ label: text('打开查看', 'Open'), onClick: openAction })
      actions.push({ label: text('忽略', 'Dismiss'), variant: 'ghost' })
    }
    enqueue({ type: 'ai', message, actions, duration: openAction ? 10000 : 6000 })
  },
}
