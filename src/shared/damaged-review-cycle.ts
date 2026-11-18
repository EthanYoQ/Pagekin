/** remedy 为 null：坏在删章删不掉的生成记录上，删了也过不了校验。 */
export type DamagedReviewCycle = { chapterNumber: number; chapterTitle: string } & (
  | { remedy: 'delete-manuscript' | null }
  | { remedy: 'delete-draft'; draftVersion: number }
  | { remedy: 'purge-trash'; deletedAt: string }
)
