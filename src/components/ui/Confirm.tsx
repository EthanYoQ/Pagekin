import { useLocaleStore } from '../../stores/locale-store'
import { openInkPrompt } from './InkPrompt'

interface ConfirmOptions {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

export function confirm(
  message: string,
  options?: Partial<Omit<ConfirmOptions, 'message'>>,
): Promise<boolean> {
  const text = useLocaleStore.getState().text
  return openInkPrompt({
    kind: options?.danger ? 'danger' : 'confirm',
    title: options?.title ?? text('确认操作', 'Confirm action'),
    message,
    confirmText: options?.confirmText ?? text('确认', 'Confirm'),
    cancelText: options?.cancelText ?? text('取消', 'Cancel'),
  })
}
