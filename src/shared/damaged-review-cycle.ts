/** remedy 为 null：删掉这一章也导不出，只请作者反馈。 */
export type DamagedReviewCycle = { chapterNumber: number; chapterTitle: string } & (
  | { remedy: 'delete-manuscript' | null }
  | { remedy: 'delete-draft'; draftVersion: number }
  | { remedy: 'purge-trash'; deletedAt: string }
)
