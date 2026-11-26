import * as React from 'react'
import { cn } from '../../lib/utils'

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, onBlur, onFocus, ...props }, ref) => {
    const handleBlur: React.FocusEventHandler<HTMLInputElement> = (e) => {
      if (type === 'number' && e.target.value === '') {
        const fallback = props.min != null ? String(props.min) : '0'
        const nativeSet = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype, 'value'
        )?.set
        nativeSet?.call(e.target, fallback)
        e.target.dispatchEvent(new Event('input', { bubbles: true }))
      }
      onBlur?.(e)
    }

    return (
      <input
        type={type}
        className={cn(
          'flex h-7 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1 text-xs text-[var(--color-text)]',
          'placeholder:text-[var(--color-text-muted)]',
          'transition-all duration-200 ease-out',
          'focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-1 focus:ring-offset-[var(--color-bg)]',
          'focus:border-[var(--color-accent)]',
          'hover:border-[var(--color-text-muted)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={ref}
        onBlur={handleBlur}
        onFocus={onFocus}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'

export { Input }
