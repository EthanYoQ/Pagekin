/* eslint-disable react-refresh/only-export-components */

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center px-2 py-0.5 text-[0.7rem] font-medium rounded-full whitespace-nowrap leading-none transition-all duration-200',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--color-badge-bg)] text-[var(--color-badge-text)]',
        success:
          'badge-success bg-[color-mix(in_srgb,var(--color-success)_15%,transparent)]',
        warning:
          'badge-warning bg-[color-mix(in_srgb,var(--color-warning)_15%,transparent)]',
        error:
          'badge-error bg-[color-mix(in_srgb,var(--color-error)_15%,transparent)]',
        outline:
          'border border-[var(--color-border)] text-[var(--color-text-secondary)] bg-transparent',
        solid:
          'bg-[var(--color-accent)] text-white',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => {
    return (
      <span
        ref={ref}
        className={cn(badgeVariants({ variant }), className)}
        {...props}
      />
    )
  }
)
Badge.displayName = 'Badge'

export { Badge, badgeVariants }
