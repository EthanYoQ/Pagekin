import type { ReactNode } from 'react'
import { CircleCheck, Info, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react'

export type NoticeTone = 'info' | 'ok' | 'warn' | 'danger'

const toneIcons: Record<NoticeTone, LucideIcon> = {
  info: Info,
  ok: CircleCheck,
  warn: TriangleAlert,
  danger: OctagonAlert,
}

interface NoticeProps {
  tone?: NoticeTone
  title: string
  children?: ReactNode
  actions?: ReactNode
}

export function Notice({ tone = 'info', title, children, actions }: NoticeProps) {
  const Icon = toneIcons[tone]
  return (
    <div className="pi-notice" role="status" data-tone={tone}>
      <Icon aria-hidden />
      <div className="pi-notice-body">
        <p className="pi-notice-title">{title}</p>
        {children && <div className="pi-notice-text">{children}</div>}
      </div>
      {actions && <div className="pi-notice-actions">{actions}</div>}
    </div>
  )
}
