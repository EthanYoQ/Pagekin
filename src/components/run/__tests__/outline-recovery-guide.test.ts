import { describe, expect, it } from 'vitest'
import { buildRecoveryEntries, EMPTY_RECOVERY_SOURCES } from '../run-recovery'
import { outlineRecoveryView } from '../../editor/outline-recovery-view'
import type { GenerationRecoveryContext } from '../../../shared/generation-owner-contract'

const handle = { projectId: '项目', epoch: '纪元', rootActionId: '根', runId: '运行' }
const savedReceipt = { kind: 'author-edit', operationId: '已保存', sourceHandle: handle, requestedRange: { from: 1, to: 5 }, committedRange: { from: 1, to: 2 },
  remainingRange: { from: 3, to: 5 }, synopsisHash: 'a'.repeat(64), payloadHash: 'b'.repeat(64), idempotent: false }

type Cell = { saved: boolean; write: string; continuation: string }
function recovery({ saved, write, continuation }: Cell): GenerationRecoveryContext {
  return { handle, operation: 'generate-plot-outline',
    plotOutline: { range: { from: 1, to: 5 }, cursor: { kind: 'stopped', chapterNumber: 3, reason: write === 'source-invalid' ? 'source-invalid' : 'attempts-exhausted' },
      sourceExpected: { synopsis: '', writingLanguage: 'zh-CN' } },
    plotOutlineRecovery: { sourceHandle: handle, leaseEpoch: '纪元', draft: '', rejectedReply: null, completeChapters: [1, 2], inFormalOutline: false,
      writeState: write === 'ready' ? { kind: 'ready' } : { kind: 'blocked', reason: write }, saved: saved ? savedReceipt : null },
    planningContinuation: { sourceHandle: handle, remainingRange: { from: 3, to: 5 }, targetUnits: 600, state: continuation,
      ...(continuation === 'continued' ? { nextHandle: { ...handle, runId: '下一次' } } : {}) },
  } as never
}

const text = (zh: string) => zh
const page = (cell: Cell) => outlineRecoveryView(recovery(cell), undefined, 'zh-CN', text, '字')
const card = (cell: Cell) => {
  const [entry] = buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, planning: [recovery(cell)] }, 'zh-CN')
  if (entry.kind !== 'planning') throw new Error('不是规划恢复卡')
  return entry
}

// 已保存 × 写状态 × 续写状态 中主进程真会给出的组合；各格写明作者该做什么。
const cells: [string, Cell, { guide: string; primary: 'save' | 'continue' | null; remaining: boolean }][] = [
  ['未保存、来源变了', { saved: false, write: 'source-changed', continuation: 'source-changed' }, { guide: '请从第 1 章重新生成情节大纲', primary: null, remaining: false }],
  ['未保存、来源无效', { saved: false, write: 'source-invalid', continuation: 'source-invalid' }, { guide: '', primary: null, remaining: false }],
  ['已保存后来源变了', { saved: true, write: 'source-changed', continuation: 'source-changed' }, { guide: '请从第 3 章重新生成情节大纲', primary: null, remaining: false }],
  ['未保存、已续写过', { saved: false, write: 'source-changed', continuation: 'continued' }, { guide: '回到那一次生成', primary: 'continue', remaining: true }],
  ['已保存、已续写过', { saved: true, write: 'author-saved', continuation: 'continued' }, { guide: '回到那一次生成', primary: 'continue', remaining: true }],
  ['已保存、来源变了、已续写过', { saved: true, write: 'source-changed', continuation: 'continued' }, { guide: '回到那一次生成', primary: 'continue', remaining: true }],
  ['已保存、可以继续', { saved: true, write: 'author-saved', continuation: 'ready' }, { guide: '继续生成缺少的章节', primary: 'continue', remaining: true }],
  ['生成还在进行', { saved: false, write: 'in-flight', continuation: 'in-flight' }, { guide: '生成结束后才能保存或继续', primary: null, remaining: true }],
]

describe('大纲恢复稿：恢复稿页与运行侧页恢复卡按同一张表给指引', () => {
  it.each(cells)('%s', (_, cell, expected) => {
    const view = page(cell), entry = card(cell)
    const guide = view.notice.lines[0]
    expect(guide).toContain(expected.guide)
    expect(entry.note).toBe(guide)
    expect(view.primary).toBe(expected.primary)
    expect(view.notice.lines.some(line => line.includes('待完成第'))).toBe(expected.remaining)
    expect(entry.meta.includes('缺第 3–5 章')).toBe(expected.remaining)
    // 提示叫作者点「继续生成」时它就是主按钮；说不能继续时没有主按钮。
    if (guide.includes('「继续生成缺少的章节」')) expect(view.primary).toBe('continue')
    if (`${view.notice.title}${guide}`.includes('不能继续') || guide.includes('重新生成情节大纲')) expect(view.primary).toBeNull()
  })

  it('已保存又续写过：标题仍说已保存', () => {
    expect(page({ saved: true, write: 'author-saved', continuation: 'continued' }).notice.title).toContain('已保存')
  })
})
