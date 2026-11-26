import type { MainGenerationRunView } from '../services/generation/generation-runtime'
import type { EditorInlineRecovery } from './editor-inline-generation'
import type { ReviewRevisionRecovery } from './review-revision-generation'

export const editorCanContinue = ({ view, sourceStatus }: EditorInlineRecovery): boolean => sourceStatus === 'current'
  && view.status !== 'cancelled' && view.ledger?.physicalRequests === 0 && !(view.candidates?.length || view.artifacts.length)

export const reviewCanResume = (view: Pick<MainGenerationRunView, 'status'>, recovery: ReviewRevisionRecovery): boolean =>
  recovery.canResume && recovery.sourceStatus === 'current' && view.status !== 'cancelled'
