import type { CSSProperties } from 'react'

interface LifecycleProps {
  label: string
  steps: readonly string[]
  current: number
}

export function Lifecycle({ label, steps, current }: LifecycleProps) {
  return (
    <ol className="pi-life" aria-label={label} style={{ '--pi-life-steps': steps.length } as CSSProperties}>
      {steps.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'todo'
        return (
          <li key={step} className="pi-life-step" data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="pi-life-bar" aria-hidden />
            {step}
          </li>
        )
      })}
    </ol>
  )
}
