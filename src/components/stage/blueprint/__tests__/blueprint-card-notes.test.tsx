import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { sqliteTime } from '../../../../shared/sqlite-time'

const previousTimeZone = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Asia/Shanghai'
})
afterAll(() => {
  if (previousTimeZone === undefined) delete process.env.TZ
  else process.env.TZ = previousTimeZone
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const ignore = () => undefined

async function renderChineseCard(notesUpdatedAt: string) {
  vi.stubGlobal('navigator', { language: 'zh-CN', languages: ['zh-CN'], userAgent: '' })
  vi.resetModules()
  const { default: BlueprintCard } = await import('../BlueprintCard')
  return renderToStaticMarkup(
    <BlueprintCard
      blueprint={{ chapterNumber: 3, title: '雾钟', role: '发展', purpose: '', keyEvents: '', characters: [], suspenseHook: '', userGuidance: '',
        notes: '林岚发现钟声提前一刻。', notesUpdatedAt }}
      row={undefined}
      saving={false}
      onField={ignore}
      onSave={ignore}
      onDelete={ignore}
    />,
  )
}

describe('蓝图卡的章节要点日期（固定在东八区）', () => {
  it('数据库记的 UTC 2026-10-13 23:30 在东八区是 10 月 14 日', async () => {
    expect(sqliteTime('2026-10-13 23:30:00').toISOString()).toBe('2026-10-13T23:30:00.000Z')
    expect(await renderChineseCard('2026-10-13 23:30:00')).toContain('定稿后自动生成 · 2026/10/14')
  })
})
