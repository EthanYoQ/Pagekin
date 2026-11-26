import type { ReactNode } from 'react'

export interface StatItem {
  id: string
  label: string
  value: ReactNode
  hint?: string
}

interface StatGridProps {
  label: string
  items: readonly StatItem[]
}

export function StatGrid({ label, items }: StatGridProps) {
  return (
    <dl className="pi-stats" aria-label={label}>
      {items.map((item) => (
        <div key={item.id} className="pi-stat">
          <dt className="pi-stat-label">{item.label}</dt>
          <dd className="pi-stat-value">{item.value}</dd>
          {item.hint && <dd className="pi-stat-hint">{item.hint}</dd>}
        </div>
      ))}
    </dl>
  )
}
