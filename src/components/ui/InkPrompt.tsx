/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { OctagonAlert } from 'lucide-react'
import { Button } from './Button'
import { createInkOverlayMount } from './ink-overlay'
import { keepToastStackClickable } from './ToastStack'

/** alert：报错，带警示印、只有「确定」；notice：告知一件已经办完的事，不带警示印、只有「确定」；confirm：取消加确认；danger：后果用朱批排、确认为实心朱印，进场焦点落在取消上。 */
export type InkPromptKind = 'alert' | 'notice' | 'confirm' | 'danger'

export interface InkPromptOptions {
  kind: InkPromptKind
  title: string
  message: string
  confirmText: string
  cancelText?: string
  /** 提示所属的事已经不在了（例如作者换了书）：撤回它，结果按取消算。 */
  signal?: AbortSignal
}

function InkPrompt({ kind, title, message, confirmText, cancelText, signal, onResolve }: InkPromptOptions & { onResolve: (value: boolean) => void }) {
  const [open, setOpen] = useState(true)
  /** 第一次的决定。关掉后要淡出 140ms，这期间内容还在、按钮还点得到，后点的不能改写它。 */
  const result = useRef<boolean | null>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const marked = kind === 'alert' || kind === 'danger'

  const close = (value: boolean) => {
    if (result.current !== null) return
    result.current = value
    setOpen(false)
  }

  useEffect(() => {
    if (!signal) return
    const withdraw = () => {
      if (result.current !== null) return
      result.current = false
      setOpen(false)
    }
    if (signal.aborted) withdraw()
    signal.addEventListener('abort', withdraw, { once: true })
    return () => signal.removeEventListener('abort', withdraw)
  }, [signal])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={next => { if (!next) close(false) }}>
      <DialogPrimitive.Overlay className="pi-scrim pi-scrim--prompt" />
      <DialogPrimitive.Content
        className={marked ? 'pi-dialog pi-dialog--prompt pi-dialog--marked' : 'pi-dialog pi-dialog--prompt'}
        role={kind === 'alert' ? 'alertdialog' : 'dialog'}
        onOpenAutoFocus={event => {
          event.preventDefault()
          ;(kind === 'danger' ? cancelRef : confirmRef).current?.focus()
        }}
        onPointerDownOutside={keepToastStackClickable}
        // 关掉后 Radix 等 140ms 淡出走完、内容卸载才触发它（减少动态效果时立即），这时才把结果交给调用方
        onCloseAutoFocus={() => onResolve(result.current ?? false)}
      >
        <div className="pi-dialog-head">
          {marked && <span className="pi-dialog-mark" aria-hidden><OctagonAlert /></span>}
          <DialogPrimitive.Title className="pi-dialog-title">{title}</DialogPrimitive.Title>
        </div>
        <div className="pi-dialog-body">
          <DialogPrimitive.Description asChild>
            {kind === 'danger'
              ? <div className="pi-dialog-consequence"><p className="pi-dialog-message">{message}</p></div>
              : <p className="pi-dialog-text pi-dialog-message">{message}</p>}
          </DialogPrimitive.Description>
        </div>
        <div className="pi-dialog-foot">
          {(kind === 'confirm' || kind === 'danger') && (
            <Button ref={cancelRef} variant="secondary" onClick={() => close(false)}>{cancelText}</Button>
          )}
          <Button ref={confirmRef} variant={kind === 'danger' ? 'danger-solid' : 'primary'} onClick={() => close(true)}>
            {confirmText}
          </Button>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  )
}

/** 在纸墨宿主里渲染一次性的对话框；关闭后卸载挂载点，再以用户的选择 resolve。 */
export function openInkPrompt(options: InkPromptOptions): Promise<boolean> {
  return new Promise(resolve => {
    if (options.signal?.aborted) return resolve(false)
    const mount = createInkOverlayMount()
    const root = createRoot(mount)
    const finish = (value: boolean) => {
      setTimeout(() => {
        root.unmount()
        mount.remove()
        resolve(value)
      })
    }
    root.render(<InkPrompt {...options} onResolve={finish} />)
  })
}
