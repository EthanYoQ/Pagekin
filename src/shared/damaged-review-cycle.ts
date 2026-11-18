export type DamagedReviewCycle = { chapterNumber: number; chapterTitle: string } & (
  | { location: 'manuscript' }
  | { location: 'draft'; draftVersion: number }
  | { location: 'trash'; deletedAt: string }
)
