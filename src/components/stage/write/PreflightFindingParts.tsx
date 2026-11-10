import type { ExemptionScope, PreflightFinding } from '../../../services/consistency-preflight'
import { useLocaleStore } from '../../../stores/locale-store'
import { Button } from '../../ui/Button'

/** 依据行。sourceChapter 为 0 的是升级前的设定，没有可信的章号。 */
export function PreflightFindingSource({ finding, className }: { finding: PreflightFinding; className?: string }) {
  const text = useLocaleStore(s => s.text)
  const place = finding.sourceChapter > 0
    ? text(`第 ${finding.sourceChapter} 章`, `Chapter ${finding.sourceChapter}`)
    : text('升级前的设定', 'Pre-upgrade notes')
  return <span className={className}>{text(`依据：${place} · ${finding.evidence}`, `Basis: ${place} · ${finding.evidence}`)}</span>
}

export function PreflightExemptButtons({ busy, onExempt }: { busy: boolean; onExempt: (scope: ExemptionScope) => void }) {
  const text = useLocaleStore(s => s.text)
  return (
    <>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => onExempt('chapter')}>{text('这是有意安排', 'This is intentional')}</Button>
      <Button variant="text" size="sm" disabled={busy} onClick={() => onExempt('book')}>{text('全书都不再提示', 'Never remind me in this book')}</Button>
    </>
  )
}
