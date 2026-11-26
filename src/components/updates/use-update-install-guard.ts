import { useCallback, useState } from 'react'

import { countUnsavedEditorItems } from '../../stores/editor-unsaved'
import { useEditorStore } from '../../stores/editor-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { discardChangesThenRequestInstall } from './update-install-discard'

export type UpdateInstallBlock = 'workflow' | 'unsaved'

export function useUpdateInstallGuard(requestInstall: () => Promise<void>) {
  const tabs = useEditorStore(s => s.tabs)
  const draftLedgers = useEditorStore(s => s.draftLedgers)
  const activeRunCount = useWorkflowStore(s => s.activeRuns.length)
  const [block, setBlock] = useState<UpdateInstallBlock | null>(null)
  const unsavedItemCount = countUnsavedEditorItems(tabs, draftLedgers)

  const install = useCallback(() => {
    if (useWorkflowStore.getState().activeRuns.length > 0) {
      setBlock('workflow')
      return
    }
    if (unsavedItemCount > 0) {
      setBlock('unsaved')
      return
    }
    void requestInstall()
  }, [requestInstall, unsavedItemCount])

  const discardAndInstall = useCallback(() => {
    setBlock(null)
    if (useWorkflowStore.getState().activeRuns.length > 0) {
      setBlock('workflow')
      return
    }
    void discardChangesThenRequestInstall(requestInstall)
  }, [requestInstall])

  return {
    block,
    dismiss: (kind: UpdateInstallBlock) => setBlock(current => (current === kind ? null : current)),
    install,
    discardAndInstall,
    unsavedItemCount,
    activeRunCount,
  }
}
