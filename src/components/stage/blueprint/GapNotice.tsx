import { useState, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import type { TrashedChapter } from '../../../shared/chapter-deletion'
import type { ChapterBlueprint } from '../../../services/workflows/directory-workflow'
import type { ChapterGap } from '../../../shared/chapter-sequence'
import { useLocaleStore } from '../../../stores/locale-store'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { restoreTrashedChapter } from '../trash/trash-actions'

export type GapTrash = TrashedChapter | null | 'unknown'

export default function GapNotice({ gap, blueprint, unsaved, trashed, onWrite, onAddBlueprint, clearAction }: {
  gap: ChapterGap
  blueprint: ChapterBlueprint | null
  unsaved: boolean
  trashed: GapTrash
  onWrite: (blueprint: ChapterBlueprint) => void
  onAddBlueprint: (chapterNumber: number) => void
  clearAction?: ReactNode
}) {
  const text = useLocaleStore(s => s.text)
  const [restoring, setRestoring] = useState(false)
  const head = gap.from
  const many = gap.to > gap.from
  const zhRange = many ? `第 ${gap.from}～${gap.to} 章` : `第 ${head} 章`
  const enRange = many ? `Chapters ${gap.from}–${gap.to}` : `Chapter ${head}`
  const inTrash = trashed !== null && trashed !== 'unknown' ? trashed : null
  const rewrite = inTrash?.chapterNumber === head
  const canRewrite = rewrite && blueprint !== null && !unsaved
  const writeLabel = rewrite
    ? text(`重写第 ${head} 章`, `Rewrite chapter ${head}`)
    : text(`写第 ${head} 章`, `Write chapter ${head}`)
  const addLabel = text(`补上第 ${head} 章蓝图`, `Add chapter ${head} blueprint`)

  const order = many
    ? text(`要从第 ${head} 章起逐章写，前一章定稿后才能写下一章。`,
        `Write them one at a time from Chapter ${head}; each opens once the one before it is finalized. `)
    : ''
  const nextStep = order + (blueprint && unsaved
    ? text(`先保存第 ${head} 章蓝图，再写这一章。`, `Save the chapter ${head} blueprint first, then write it.`)
    : blueprint
    ? text(`点「${writeLabel}」在原位置重写。`, `Choose “${writeLabel}” to rewrite it in place.`)
    : text(
        `第 ${head} 章的蓝图也没有了，先点「${addLabel}」填好并保存，再写这一章。`,
        `Chapter ${head}’s blueprint is gone too. Choose “${addLabel}”, fill it in and save, then write it.`,
      ))

  const restore = () => {
    if (!inTrash || restoring) return
    setRestoring(true)
    void restoreTrashedChapter(inTrash).finally(() => setRestoring(false))
  }

  const actions = (
    <>
      {inTrash && (
        <Button variant="secondary" size="sm" disabled={restoring} onClick={restore}>
          <RotateCcw size={13} aria-hidden />{restoring ? text('恢复中…', 'Restoring…') : text('恢复', 'Restore')}
        </Button>
      )}
      {blueprint
        ? !unsaved && <Button variant="secondary" size="sm" onClick={() => onWrite(blueprint)}>{writeLabel}</Button>
        : <Button variant="secondary" size="sm" onClick={() => onAddBlueprint(head)}>{addLabel}</Button>}
      {clearAction}
    </>
  )

  if (inTrash) {
    const trashedNumber = inTrash.chapterNumber
    const zhTitle = many ? `${zhRange}已删除，第 ${trashedNumber} 章的正文在回收站里` : `${zhRange}已删除，正文在回收站里`
    const enTitle = many ? `${enRange} were deleted; chapter ${trashedNumber}’s text is in the trash` : `${enRange} was deleted; its text is in the trash`
    return (
      <Notice tone="info" title={text(zhTitle, enTitle)} actions={actions}>
        {canRewrite
          ? text(`后面的章节照常可写。点「恢复」放回这一章，或者重写它。${order}`,
              `Later chapters stay writable. Choose “Restore” to put this chapter back, or rewrite it. ${order}`)
          : text(`后面的章节照常可写。点「恢复」放回这一章。${order}`,
              `Later chapters stay writable. Choose “Restore” to put this chapter back. ${order}`)}
      </Notice>
    )
  }

  if (gap.cause === 'deleted') {
    return (
      <Notice tone="info" title={text(`${zhRange}的正文已删除`, `${enRange} ${many ? 'were' : 'was'} deleted`)} actions={actions}>
        {trashed === 'unknown'
          ? text(`后面的章节都还在，照常可写。${nextStep}`, `Later chapters are untouched and stay writable. ${nextStep}`)
          : text(`后面的章节都还在，照常可写。删掉的正文找不回来，${nextStep}`,
              `Later chapters are untouched and stay writable. The deleted text cannot be recovered. ${nextStep}`)}
      </Notice>
    )
  }
  return (
    <Notice tone="warn" title={text(`${zhRange}还没写，后面却已有正文`, `${enRange} ${many ? 'are' : 'is'} unwritten, but later chapters have text`)} actions={actions}>
      {text(`后面的正文都还在，照常可写。没有删除记录，可能是旧版「小说拆解与仿写」误导入的原文。只是缺${many ? '这几章' : '这一章'}时，${nextStep}确认后面的正文是误导入时才用「清除误导入正文…」，它会清掉全书所有草稿和定稿。`,
        `Later text is untouched and stays writable. With no deletion record, this may be text the old “Novel breakdown & imitation” imported by mistake. If only ${many ? 'these chapters are' : 'this chapter is'} missing: ${nextStep} Use “Clear imported text…” only if the later text was imported by mistake; it clears every draft and finalized chapter in the book.`)}
    </Notice>
  )
}
