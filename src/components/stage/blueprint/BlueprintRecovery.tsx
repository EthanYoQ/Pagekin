import { useEditorStore, type EditorTab } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import CodeMirrorEditor from '../../editor/CodeMirrorEditor'
import { planningRemainingText } from '../../run/run-recovery'
import { Notice } from '../../ui/Notice'
import { PlanningRecoveryFrame } from '../PlanningRecoveryFrame'
import { useBlueprintRecovery } from './use-blueprint-recovery'

/**
 * 蓝图恢复稿（F-054）：上次生成中断后恢复出的蓝图文本。作者补齐后选「保存到第几章」，只把连续完整的章节写进蓝图，不调用模型；
 * 也可以接着生成缺少的章节。原始候选随时可展开对照。
 */
export default function BlueprintRecovery({ tab, projectKey }: { tab: EditorTab; projectKey: string }) {
  const text = useLocaleStore(state => state.text)
  const recovery = useBlueprintRecovery(tab, projectKey)
  const { currentTab, context, busy, sessionCurrent } = recovery
  const candidate = context?.blueprintRecovery
  const continuation = context?.planningContinuation
  const editRange = tab.planningRecovery?.blueprintRecovery?.editRange
  const saved = currentTab.planningSaveSnapshot?.status === 'saved'
  const unavailable = candidate?.writeState === 'unavailable'
  const canSave = !busy && sessionCurrent && !saved
    && (candidate?.writeState === 'ready' || Boolean(candidate?.saved && currentTab.planningSaveSnapshot?.status === 'pending'))
  const canContinue = !busy && sessionCurrent && Boolean(continuation?.remainingRange) && ['ready', 'continued'].includes(continuation?.state ?? '')

  return (
    <PlanningRecoveryFrame
      label={text('蓝图恢复', 'Blueprint recovery')}
      eyebrow={text('蓝图 · 恢复稿', 'Blueprint · Recovery draft')}
      heading={text('补齐中断的蓝图', 'Finish the interrupted blueprints')}
      busy={busy}
      end={{ value: recovery.end, min: editRange?.from, max: editRange?.to, disabled: unavailable, onChange: recovery.setEnd }}
      proceed={{ disabled: !canContinue, onClick: () => { void recovery.continuePlanning() } }}
      save={{ label: text('保存恢复蓝图', 'Save recovered blueprints'), disabled: !canSave, onClick: () => { void recovery.save() } }}
      primary="save"
      error={recovery.error}
      original={tab.originalContent}
      notices={<>
        {saved && <Notice tone="ok" title={text('本次恢复已保存，后续修改仅供复制。', 'This recovery is saved. Further edits can only be copied.')} />}
        {unavailable ? (
          <Notice
            tone="warn"
            title={candidate.diagnostic.code === 'GENERATION_BLUEPRINTS_CLEARED'
              ? text('蓝图已清空，旧恢复稿不能保存或续接', 'Blueprints were cleared. This recovery draft cannot be saved or continued.')
              : candidate.diagnostic.code === 'GENERATION_DIRECTORY_PROGRESS_INVALID'
                ? text('蓝图生成进度校验失败，旧恢复稿不能保存或续接', 'Blueprint generation progress failed validation. This recovery draft cannot be saved or continued.')
                : text('蓝图作者保存记录校验失败，旧恢复稿不能保存或续接', 'The blueprint author save record failed validation. This recovery draft cannot be saved or continued.')}
          >
            {text('原文已保留，可继续编辑或复制', 'The original text is preserved. You can still edit or copy it.')}
          </Notice>
        ) : (
          <Notice title={text('蓝图未完整生成，原文已保留', 'The incomplete blueprint text is preserved')}>
            {text('请补齐 JSON 中的引号、括号和必填内容，只保留要保存的连续完整章节。保存只写入本地，不会调用模型。', 'Complete the JSON quotes, brackets and required fields. Keep only complete consecutive chapters to save. Saving is local and does not call a model.')}
            {continuation?.remainingRange && (
              <> {planningRemainingText(continuation.remainingRange, continuation.targetUnits, recovery.planningTargetUnit, text)}</>
            )}
          </Notice>
        )}
        {candidate && ['in-flight', 'source-changed', 'continued'].includes(candidate.writeState) && (
          <Notice tone="warn" title={text('当前正式内容不能覆盖。可继续编辑或复制恢复稿。', 'Saved content cannot currently be replaced. You can still edit or copy this recovery draft.')} />
        )}
      </>}
    >
      <CodeMirrorEditor
        mode="document"
        content={currentTab.content ?? ''}
        hideStatusBar
        onChange={value => useEditorStore.getState().updateTabContent(tab.id, value)}
        onSave={() => recovery.save()}
      />
    </PlanningRecoveryFrame>
  )
}
