/** 循环自己的证据指不准章节时 chapterNumber 为 null。 */
export interface DamagedReviewCycle {
  chapterNumber: number | null
  chapterTitle: string
  inTrash: boolean
}
