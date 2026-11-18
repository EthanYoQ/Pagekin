/** 一条验不过的审修循环属于哪一章。循环自己的证据指不准章节时 chapterNumber 为 null。 */
export interface DamagedReviewCycle {
  chapterNumber: number | null
  chapterTitle: string
  inTrash: boolean
}
