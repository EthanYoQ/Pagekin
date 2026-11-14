import type { MainGenerationRunView } from '../services/generation/generation-runtime'
import type { EditorInlineRecovery } from './editor-inline-generation'
import type { ReviewRevisionRecovery } from './review-revision-generation'

// 主进程决定列不列、运行侧页决定按钮能不能点，都按这里判断，两边不会对不上。

export const editorCanContinue = ({ view, sourceStatus }: EditorInlineRecovery): boolean => sourceStatus === 'current'
  && view.status !== 'cancelled' && view.ledger?.physicalRequests === 0 && !(view.candidates?.length || view.artifacts.length)

export const reviewCanResume = (view: Pick<MainGenerationRunView, 'status'>, recovery: ReviewRevisionRecovery): boolean =>
  recovery.canResume && recovery.sourceStatus === 'current' && view.status !== 'cancelled'
