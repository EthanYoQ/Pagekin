/**
 * 全书审修循环校验（导出、备份、升库版本）里第一条过不了的循环在哪一章（#702）。
 * remedy 是作者删掉哪一稿能让校验通过；循环引用的生成记录读不出时为 null，删章后导出照样失败。
 */
export interface DamagedReviewCycle {
  chapterNumber: number
  chapterTitle: string
  remedy: 'delete-manuscript' | 'delete-draft' | null
}
