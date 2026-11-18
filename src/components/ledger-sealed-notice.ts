import type { LocalizedText } from '../i18n/core'
import { pluralEn } from '../shared/plural-en'
import { useLocaleStore } from '../stores/locale-store'
import { openInkPrompt } from './ui/InkPrompt'

export function ledgerSealedNotice(count: number, text: LocalizedText): { title: string; message: string } {
  return {
    title: text('有 AI 生成记录读不出', `${pluralEn(count, 'An AI generation record', 'Some AI generation records')} couldn't be read`, '読み取れない AI 生成記録があります'),
    message: text(
      `正文没有受影响。有 ${count} 条 AI 生成记录读不出，已停用，对应的生成不能继续或重试；反复出现请反馈给我们。`,
      `Your manuscript is unaffected. ${count} AI generation ${pluralEn(count, 'record')} couldn't be read and ${pluralEn(count, 'was', 'were')} disabled, so ${count === 1 ? 'that generation' : 'those generations'} can't be continued or retried. If this keeps happening, please let us know.`,
      `本文は影響を受けていません。読み取れない AI 生成記録が ${count} 件あったため無効にしました。該当する生成は続行も再試行もできません。繰り返し起きる場合はお知らせください。`,
    ),
  }
}

export async function showLedgerSealedNotice(count: number | undefined): Promise<void> {
  if (!count) return
  const text = useLocaleStore.getState().text
  await openInkPrompt({ kind: 'notice', ...ledgerSealedNotice(count, text), confirmText: text('知道了', 'Got it', '了解') })
}
