import { discardAllEditorChanges } from '../../stores/editor-discard'

export async function discardChangesThenRequestInstall(
  requestInstall: () => Promise<void>,
): Promise<void> {
  discardAllEditorChanges()
  await requestInstall()
}
