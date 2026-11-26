interface DraftSourceDependencyBase {
  draftId: number
  contentHash: string
}

export type DraftSourceDependency =
  | (DraftSourceDependencyBase & { kind?: 'candidate' })
  | (DraftSourceDependencyBase & {
      kind: 'finalized'
      chapterNumber: number
      finalizationId: string
    })
  | (DraftSourceDependencyBase & {
      kind: 'legacy-finalized'
      chapterNumber: number
    })
