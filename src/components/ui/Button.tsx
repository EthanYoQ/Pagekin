import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { Check } from 'lucide-react'
import { clsx } from 'clsx'

type NativeButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>

type LegacyButtonProps = NativeButtonProps & {
  variant?: 'default' | 'ai' | 'destructive' | 'outline' | 'ghost' | 'success' | null
  size?: 'default' | 'sm' | 'lg' | 'icon' | null
  asChild?: boolean
}

export type InkButtonVariant = 'primary' | 'secondary' | 'text' | 'danger' | 'danger-solid' | 'icon'
export type InkButtonSize = 'sm' | 'md' | 'lg'

type InkButtonProps = NativeButtonProps & { size?: InkButtonSize } & (
  | { variant: Exclude<InkButtonVariant, 'icon'> }
  | { variant: 'icon'; 'aria-label': string }
)

export type ButtonProps = LegacyButtonProps | InkButtonProps

const inkVariants: ReadonlySet<string> = new Set<InkButtonVariant>(['primary', 'secondary', 'text', 'danger', 'danger-solid', 'icon'])

function isInkButton(props: ButtonProps): props is InkButtonProps {
  return typeof props.variant === 'string' && inkVariants.has(props.variant)
}

type LegacyVariant = NonNullable<LegacyButtonProps['variant']>
type LegacySize = NonNullable<LegacyButtonProps['size']>

const LEGACY_INK_VARIANT: Record<LegacyVariant, Exclude<InkButtonVariant, 'icon'>> = {
  default: 'primary', ai: 'primary', success: 'primary', outline: 'secondary', ghost: 'text', destructive: 'danger-solid',
}
const LEGACY_INK_SIZE: Record<LegacySize, InkButtonSize> = { default: 'sm', sm: 'sm', lg: 'md', icon: 'sm' }

function inkClasses(variant: InkButtonVariant, size: InkButtonSize, className: string | undefined) {
  return clsx('pi-btn', `pi-btn--${variant}`, size !== 'md' && `pi-btn--${size}`, className)
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>((props, ref) => {
  if (isInkButton(props)) {
    const { className, variant, size = 'md', type = 'button', ...rest } = props
    return <button ref={ref} type={type} className={inkClasses(variant, size, className)} {...rest} />
  }
  const { className, variant, size, asChild = false, children, ...rest } = props
  const Comp = asChild ? Slot : 'button'
  const toggle = rest['aria-pressed'] !== undefined || rest['aria-selected'] !== undefined
  const inkVariant = size === 'icon' ? 'icon' : toggle ? 'secondary' : LEGACY_INK_VARIANT[variant ?? 'default']
  const checked = !asChild && (rest['aria-pressed'] === true || rest['aria-pressed'] === 'true')
  return (
    <Comp ref={ref} className={inkClasses(inkVariant, LEGACY_INK_SIZE[size ?? 'default'], className)} {...rest}>
      {checked ? <><Check aria-hidden />{children}</> : children}
    </Comp>
  )
})
Button.displayName = 'Button'

export { Button }
