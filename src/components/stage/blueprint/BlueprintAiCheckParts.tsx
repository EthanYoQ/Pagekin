import { Fragment } from 'react'
import type { ContinuityCheckNode } from '../../../shared/blueprint-continuity-check'
import { useLocaleStore } from '../../../stores/locale-store'
import { CHARACTER_STATE_FIELDS } from '../../editor/character-state-fields'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { PreflightExemptButtons } from '../write/PreflightFindingParts'
import type { BlueprintAiCheck } from './use-blueprint-ai-check'

function basisLine(node: ContinuityCheckNode, text: (zh: string, en: string) => string): string {
  const { zhCN, enUS } = node.since
  const since = enUS.charAt(0).toUpperCase() + enUS.slice(1)
  if (node.aspect === 'relation') return text(`${zhCN}，${node.subjectName}和${node.targetName}是「${node.value}」`, `${since}, ${node.subjectName}’s relation to ${node.targetName} is “${node.value}”`)
  const [, zh, en] = CHARACTER_STATE_FIELDS.find(([field]) => field === node.aspect)!
  const label = (value: string) => value.replace(/\s*[（(].*$/u, '')
  return text(`${zhCN}，${node.subjectName}的${label(zh)}是「${node.value}」`, `${since}, ${node.subjectName}’s ${label(en).toLowerCase()} is “${node.value}”`)
}

/** 选中章的 AI 结论，放在规则提示下面，单独成段。 */
export function BlueprintAiFindings({ chapterNumber, ai }: { chapterNumber: number; ai: BlueprintAiCheck }) {
  const text = useLocaleStore(s => s.text)
  const findings = ai.chapterFindings(chapterNumber)
  const exempted = ai.exempted(chapterNumber)
  return (
    <>
      {findings.length > 0 && (
        <Notice tone="warn" title={text('AI 检查', 'AI check')}>
          <ul className="stage-bp-ai-list">
            {findings.map(finding => (
              <li key={finding.stableFactKey} className="stage-bp-ai-item">
                <p className="stage-bp-ai-issue">{finding.issue}</p>
                <p>{text('依据：', 'Basis: ')}{finding.basis.map((node, index) => (
                  <Fragment key={node.eventId}>{index > 0 && text('；', '; ')}{basisLine(node, text)}</Fragment>
                ))}</p>
                <p>{text('建议：', 'Suggestion: ')}{finding.suggestion}</p>
                <div className="stage-bp-ai-actions">
                  <PreflightExemptButtons busy={ai.busy} onExempt={scope => void ai.exempt(finding, scope)} />
                </div>
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {exempted && (
        <Notice
          tone="info"
          title={exempted.scope === 'book' ? text('已记下，全书不再提示。', 'Noted. No more reminders in this book.') : text('已记下，这一章不再提示。', 'Noted. No more reminders for this chapter.')}
          actions={<Button variant="text" size="sm" disabled={ai.busy} onClick={() => void ai.undo()}>{text('撤销', 'Undo')}</Button>}
        />
      )}
    </>
  )
}

/** 这次点按钮的总结，页面级，因为结论常常不在当前选中的章。 */
export function BlueprintAiSummary({ ai, onSelectChapter }: { ai: BlueprintAiCheck; onSelectChapter: (chapterNumber: number) => void }) {
  const text = useLocaleStore(s => s.text)
  const { status, checkedThroughChapter: through } = ai
  if (status.kind === 'changed') return <Notice tone="info" title={text('蓝图在检查时改过，这次结果不算数。再点一次“AI 检查”。', 'The blueprints changed during the check, so this result does not count. Choose AI check again.')} />
  if (status.kind === 'unreadable') return <Notice tone="warn" title={text('蓝图没有改动。这次结果没读出来，再点一次“AI 检查”。', 'Your blueprints are unchanged. This result could not be read. Choose AI check again.')} />
  if (status.kind === 'failed') return <Notice tone="warn" title={status.message} />
  if (status.kind !== 'done' || through === null) return null
  if (ai.clean) return <Notice tone="ok" title={text(`没发现和时间线矛盾的地方。检查到第 ${through} 章。`, `No conflicts with the timeline. Checked through chapter ${through}.`)} />
  const chapters = [...new Set(ai.findings.map(finding => finding.chapterNumber))]
  if (chapters.length === 0) return null
  return (
    <Notice
      tone="warn"
      title={text(`AI 检查到第 ${through} 章，这些章和时间线矛盾。`, `AI check reached chapter ${through}. These chapters conflict with the timeline.`)}
      actions={chapters.map(chapter => (
        <Button key={chapter} variant="secondary" size="sm" onClick={() => onSelectChapter(chapter)}>{text(`第 ${chapter} 章`, `Chapter ${chapter}`)}</Button>
      ))}
    />
  )
}
