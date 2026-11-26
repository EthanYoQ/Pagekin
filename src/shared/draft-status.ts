export type DraftStatus = 'draft' | 'revised' | 'reviewed' | 'finalized' | 'superseded' | 'archived'

export interface DraftStatusInfo {
  readOnly: boolean
  label: readonly [zh: string, en: string]
}

export const DRAFT_STATUS_INFO: Readonly<Record<DraftStatus, DraftStatusInfo>> = {
  draft: { readOnly: false, label: ['草稿', 'Draft'] },
  reviewed: { readOnly: false, label: ['草稿', 'Draft'] },
  revised: { readOnly: false, label: ['修稿已合并', 'Revised'] },
  finalized: { readOnly: true, label: ['定稿', 'Final'] },
  superseded: { readOnly: true, label: ['已被替换的定稿', 'Replaced final'] },
  archived: { readOnly: true, label: ['已归档', 'Archived'] },
}

export const WORKING_DRAFT_STATUSES = ['draft', 'revised', 'reviewed'] as const satisfies readonly DraftStatus[]

export const WORKING_DRAFT_STATUS_SQL = WORKING_DRAFT_STATUSES.map(status => `'${status}'`).join(',')

export const CURRENT_DRAFT_STATUSES = [...WORKING_DRAFT_STATUSES, 'finalized'] as const satisfies readonly DraftStatus[]

export const CURRENT_DRAFT_STATUS_SQL = CURRENT_DRAFT_STATUSES.map(status => `'${status}'`).join(',')

export const RECEIPTED_DRAFT_STATUSES = ['finalized', 'superseded'] as const satisfies readonly DraftStatus[]

export const RECEIPTED_DRAFT_STATUS_SQL = RECEIPTED_DRAFT_STATUSES.map(status => `'${status}'`).join(',')

export function isReceiptedDraftStatus(status: string): boolean {
  return (RECEIPTED_DRAFT_STATUSES as readonly string[]).includes(status)
}
