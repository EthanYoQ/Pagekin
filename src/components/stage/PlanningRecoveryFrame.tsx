import { useId, type ReactNode } from 'react'
import { ChevronRight, Save, Sparkles } from 'lucide-react'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'

interface PlanningRecoveryFrameProps {
  label: string
  eyebrow: string
  heading: string
  busy: boolean
  end: { value: string; min?: number; max?: number; disabled: boolean; onChange: (value: string) => void }
  proceed: { disabled: boolean; onClick: () => void }
  save: { label: string; title?: string; disabled: boolean; onClick: () => void }
  primary: 'save' | 'continue' | null
  tools?: ReactNode
  notices: ReactNode
  error: string
  original: string | undefined
  children: ReactNode
}

export function PlanningRecoveryFrame({ label, eyebrow, heading, busy, end, proceed, save, primary, tools, notices, error, original, children }: PlanningRecoveryFrameProps) {
  const text = useLocaleStore(state => state.text)
  const endId = useId()
  return (
    <section className="stage-bp stage-bp-recovery" aria-label={label} aria-busy={busy}>
      <header className="stage-bp-head">
        <div className="stage-bp-heading">
          <div className="stage-bp-kicker">
            <span className="stage-bp-eyebrow">{eyebrow}</span>
          </div>
          <h1 className="stage-bp-h1">{heading}</h1>
        </div>
        <div className="stage-bp-actions">
          <label className="stage-bp-recovery-end" htmlFor={endId}>{text('保存到第几章', 'Last complete chapter')}</label>
          <input
            id={endId}
            type="number"
            className="pi-input stage-bp-recovery-end-input"
            disabled={end.disabled}
            min={end.min}
            max={end.max}
            value={end.value}
            onChange={event => end.onChange(event.target.value)}
          />
          <Button variant={primary === 'continue' ? 'primary' : 'secondary'} disabled={proceed.disabled} onClick={proceed.onClick}>
            <Sparkles size={15} aria-hidden />{text('继续生成缺少的章节', 'Generate remaining chapters')}
          </Button>
          <Button variant={primary === 'save' ? 'primary' : 'secondary'} title={save.title} disabled={save.disabled} onClick={save.onClick}>
            <Save size={15} aria-hidden />{save.label}
          </Button>
          {tools}
        </div>
      </header>

      {notices}
      {error && <p className="stage-dialog-error stage-bp-recovery-error" role="alert">{error}</p>}

      <details className="stage-write-more stage-bp-recovery-original">
        <summary><ChevronRight size={14} aria-hidden />{text('原始候选', 'Original candidate')}</summary>
        <pre>{original}</pre>
      </details>
      <div className="stage-bp-recovery-editor">{children}</div>
    </section>
  )
}
