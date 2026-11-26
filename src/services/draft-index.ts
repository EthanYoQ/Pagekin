import { ipc } from './ipc-client'
import type { DraftStatus } from '../shared/draft-status'

import type { DraftMeta as DB_DraftMeta } from '../../electron/repositories/draft-repository'
import type { RevisionMeta as DB_RevisionMeta } from '../../electron/repositories/revision-repository'
import type { ReviewMeta as DB_ReviewMeta } from '../../electron/repositories/review-repository'

export interface DraftMeta {
  id: number
  chapterNumber: number
  chapterTitle?: string
  version: number
  status: DraftStatus
  wordCount?: number
  createdAt: string
  updatedAt?: string
  source: 'write' | 'rewrite'
  sourceDependencies?: DB_DraftMeta['sourceDependencies']
  dependenciesStale?: boolean

  filePath: string
  fileName: string
}

export interface RevisionEntry {
  id: number
  baseDraftId: number
  baseVersion: number
  revisionIndex: number
  type: 'refine' | 'review-fix'
  status: 'pending' | 'merged' | 'discarded'
  createdAt: string
  mergedToDraftId?: number
  recheckOnMerge?: true

  fileName: string
  baseDraft: string
}

export interface ReviewEntry {
  id: number
  baseDraftId: number
  baseVersion: number
  reviewIndex: number
  createdAt: string

  fileName: string
  baseDraft: string
}

function mapRevisionEntry(dbMeta: DB_RevisionMeta, baseVersion: number): RevisionEntry {
  return {
    ...dbMeta,
    type: dbMeta.revisionType as 'refine' | 'review-fix',
    status: dbMeta.status as 'pending' | 'merged' | 'discarded',
    mergedToDraftId: dbMeta.mergedToDraftId ?? undefined,
    baseVersion,
    fileName: `v${baseVersion}_r${dbMeta.revisionIndex}.md`,
    baseDraft: `draft_v${baseVersion}.md`,
  }
}

function mapReviewEntry(dbMeta: DB_ReviewMeta, baseVersion: number): ReviewEntry {
  return {
    ...dbMeta,
    baseVersion,
    fileName: `v${baseVersion}_review_${dbMeta.reviewIndex}.md`,
    baseDraft: `draft_v${baseVersion}.md`,
  }
}

async function getDraftId(chapterNumber: number, version: number, expectedProjectPath: string): Promise<number | null> {
  const drafts = await ipc.invoke('db:draft-list', chapterNumber, expectedProjectPath)
  const match = drafts.find((d: DB_DraftMeta) => d.version === version)
  return match?.id ?? null
}

export async function getPendingRevisions(
  chapterDir: string,
  baseVersion: number,
  expectedProjectPath: string,
): Promise<RevisionEntry[]> {
  const match = chapterDir.match(/ch(\d+)$/)
  if (!match) return []
  const chapterNumber = parseInt(match[1])

  const draftId = await getDraftId(chapterNumber, baseVersion, expectedProjectPath)
  if (!draftId) return []

  const list: DB_RevisionMeta[] = await ipc.invoke('db:revision-get-pending', draftId, expectedProjectPath)
  return list.map(m => mapRevisionEntry(m, baseVersion))
}

export async function getReviewsForVersion(
  chapterDir: string,
  baseVersion: number,
  expectedProjectPath: string,
): Promise<ReviewEntry[]> {
  const matchCh = chapterDir.match(/ch(\d+)$/)
  if (!matchCh) return []
  const chapterNumber = parseInt(matchCh[1])

  const baseDraftId = await getDraftId(chapterNumber, baseVersion, expectedProjectPath)
  if (!baseDraftId) return []

  const list: DB_ReviewMeta[] = await ipc.invoke('db:review-list', baseDraftId, expectedProjectPath)
  return list.map(m => mapReviewEntry(m, baseVersion)).sort((a, b) => a.reviewIndex - b.reviewIndex)
}
