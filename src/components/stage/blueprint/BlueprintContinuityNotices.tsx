import { useCharacterStore } from '../../../stores/character-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { openBuiltinEditor } from '../../../stores/open-builtin-editor'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { PreflightExemptButtons, PreflightFindingSource } from '../write/PreflightFindingParts'
import type { BlueprintContinuityNotice } from './use-blueprint-continuity-notice'

function openCharacter(characterId: string, name: string) {
  useCharacterStore.getState().setSelectedId(characterId)
  openBuiltinEditor('character-editor', name, 'character')
}

/** 这一章保存后发现的连续性提示。不挡保存，也不挡写章。 */
export default function BlueprintContinuityNotices({ chapterNumber, notice }: { chapterNumber: number; notice: BlueprintContinuityNotice }) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const exempted = notice.exempted(chapterNumber)
  return (
    <>
      {notice.findings(chapterNumber).map(finding => (
        <Notice
          key={finding.stableFactKey}
          tone="warn"
          title={locale === 'en-US' ? finding.issue.enUS : finding.issue.zhCN}
          actions={(
            <>
              <PreflightExemptButtons busy={notice.busy} onExempt={scope => void notice.exempt(chapterNumber, finding, scope)} />
              {finding.characterId && (
                <Button variant="text" size="sm" onClick={() => openCharacter(finding.characterId!, text('角色名单', 'Cast'))}>
                  {text('去看这个角色', 'View character')}
                </Button>
              )}
            </>
          )}
        >
          <PreflightFindingSource finding={finding} />
        </Notice>
      ))}
      {exempted && (
        <Notice
          tone="info"
          title={exempted.scope === 'book' ? text('已记下，全书不再提示。', 'Noted. No more reminders in this book.') : text('已记下，这一章不再提示。', 'Noted. No more reminders for this chapter.')}
          actions={<Button variant="text" size="sm" disabled={notice.busy} onClick={() => void notice.undo()}>{text('撤销', 'Undo')}</Button>}
        />
      )}
    </>
  )
}
