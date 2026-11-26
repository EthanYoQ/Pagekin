import { type LucideProps, type LucideIcon } from 'lucide-react'

export type IconSize = 12 | 14 | 16 | 18 | 22

interface IconProps extends Omit<LucideProps, 'ref'> {
  icon: LucideIcon
  size?: IconSize
}

const sizeClasses: Record<IconSize, string> = {
  12: 'w-3 h-3',
  14: 'w-3.5 h-3.5',
  16: 'w-4 h-4',
  18: 'w-[18px] h-[18px]',
  22: 'w-[22px] h-[22px]',
}

export function Icon({ icon: IconComponent, size = 14, className, ...props }: IconProps) {
  return (
    <IconComponent
      className={sizeClasses[size] + (className ? ` ${className}` : '')}
      {...props}
    />
  )
}

export type { LucideProps, LucideIcon }
