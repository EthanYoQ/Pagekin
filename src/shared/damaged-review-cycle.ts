/** remedy 为 null：循环引用的生成记录读不出，删章也过不了校验。 */
export interface DamagedReviewCycle {
  chapterNumber: number
  chapterTitle: string
  remedy: 'delete-manuscript' | 'delete-draft' | null
}
