import { RotateCcw, ShieldAlert } from 'lucide-react'
import type { ConsistencyPreflightResult, ExemptionScope, PreflightFinding } from '../../../services/consistency-preflight'
import type { ConsistencyExemption } from '../../../shared/consistency-preflight'
import { useLocaleStore } from '../../../stores/locale-store'
import { Button } from '../../ui/Button'
import { PreflightExemptButtons, PreflightFindingSource } from './PreflightFindingParts'

interface WritePreflightProps {
  preflight: ConsistencyPreflightResult
  busy: boolean
  onIgnoreOnce: () => void
  onRerun: () => void
  onExempt: (finding: PreflightFinding, scope: ExemptionScope) => void
  onRevoke: (exemption: ConsistencyExemption) => void
}

/** 写作弹层里的一致性预检：线索提醒只作提示，作者可以一键确认是有意安排、仅本次忽略，或改蓝图后重检；已确认的安排可以撤销。 */
export default function WritePreflight({ preflight, busy, onIgnoreOnce, onRerun, onExempt, onRevoke }: WritePreflightProps) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const { findings } = preflight
  const saved = preflight.exemptions.filter(exemption => !exemption.revoked)

  return (
    <section className="stage-preflight" aria-label={text('一致性预检', 'Consistency preflight')}>
      {findings.length > 0 && (
        <p className="stage-preflight-head">
          <ShieldAlert size={14} aria-hidden />
          {text(`一致性预检 · ${findings.length} 条线索提醒`, `Consistency preflight · ${findings.length} continuity ${findings.length === 1 ? 'finding' : 'findings'}`)}
        </p>
      )}
      {findings.length > 0 && (
        <p className="stage-preflight-note">{text('这些是证据提示，不会阻止创作，也不会自动改写内容。', 'These are evidence prompts. They never block writing or edit content automatically.')}</p>
      )}
      {findings.map(finding => (
        <div key={`${finding.stableFactKey}:${finding.chapterNumber}`} className="stage-preflight-item">
          <p>{locale === 'en-US' ? finding.issue.enUS : finding.issue.zhCN}</p>
          <p><PreflightFindingSource finding={finding} className="stage-preflight-source" /></p>
          <p>{locale === 'en-US' ? finding.suggestion.enUS : finding.suggestion.zhCN}</p>
          <div className="stage-preflight-save">
            <PreflightExemptButtons busy={busy} onExempt={scope => onExempt(finding, scope)} />
          </div>
        </div>
      ))}
      {findings.length > 0 && (
        <div className="stage-preflight-actions">
          <Button variant="text" size="sm" disabled={busy} onClick={onIgnoreOnce}>{text('仅本次忽略', 'Ignore this time')}</Button>
          <Button variant="text" size="sm" disabled={busy} onClick={onRerun}>{text('改蓝图后重检', 'Recheck after editing')}</Button>
        </div>
      )}
      {saved.length > 0 && (
        <details className="stage-preflight-saved">
          <summary>{text(`已保存安排（${saved.length}）`, `Saved arrangements (${saved.length})`)}</summary>
          {saved.map(exemption => (
            <div key={`${exemption.stableFactKey}:${exemption.chapterNumber}`} className="stage-preflight-exemption">
              <span>
                {exemption.chapterNumber === null ? text('全书', 'Whole book') : text(`第 ${exemption.chapterNumber} 章`, `Chapter ${exemption.chapterNumber}`)}
                {' · '}{exemption.reason}
              </span>
              <Button variant="text" size="sm" disabled={busy} onClick={() => onRevoke(exemption)}>
                <RotateCcw size={13} aria-hidden />{text('撤销', 'Revoke')}
              </Button>
            </div>
          ))}
        </details>
      )}
    </section>
  )
}
