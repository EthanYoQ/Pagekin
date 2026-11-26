import { useLocaleStore } from '../../stores/locale-store'
import { openInkPrompt } from './InkPrompt'

interface AlertOptions {
  title?: string
  confirmText?: string
  signal?: AbortSignal
}

export function alertError(message: string, options?: AlertOptions): Promise<void> {
  const text = useLocaleStore.getState().text
  return openInkPrompt({
    kind: 'alert',
    title: options?.title ?? text('发生错误', 'Error'),
    message,
    confirmText: options?.confirmText ?? text('确定', 'OK'),
    signal: options?.signal,
  }).then(() => undefined)
}
