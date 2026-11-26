import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from './Button'
import { useInkOverlayHost } from './ink-overlay'
import { useDialogFocusReturn } from './focus-return'
import { keepToastStackClickable } from './ToastStack'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, onPointerDownOutside, onOpenAutoFocus, onCloseAutoFocus, ...props }, ref) => {
  const text = useLocaleStore(s => s.text)
  const focusReturn = useDialogFocusReturn()
  const host = useInkOverlayHost()
  if (!host) return null
  return (
    <DialogPortal container={host}>
      <DialogPrimitive.Overlay className="pi-scrim" />
      <DialogPrimitive.Content
        ref={ref}
        className={cn('pi-dialog pi-dialog--legacy max-w-lg', className)}
        onPointerDownOutside={event => {
          keepToastStackClickable(event)
          onPointerDownOutside?.(event)
        }}
        onOpenAutoFocus={event => {
          focusReturn.remember()
          onOpenAutoFocus?.(event)
        }}
        onCloseAutoFocus={event => {
          onCloseAutoFocus?.(event)
          if (!event.defaultPrevented) focusReturn.onCloseAutoFocus(event)
        }}
        {...props}
      >
        {children}
        <DialogPrimitive.Close asChild>
          <Button variant="icon" size="sm" className="pi-dialog-close" aria-label={text('关闭', 'Close')}>
            <X aria-hidden />
          </Button>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('pi-dialog-head', className)} {...props} />
)
DialogHeader.displayName = 'DialogHeader'

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('pi-dialog-foot justify-between', className)} {...props} />
)
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('pi-dialog-title', className)} {...props} />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn('pi-dialog-sub', className)} {...props} />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
