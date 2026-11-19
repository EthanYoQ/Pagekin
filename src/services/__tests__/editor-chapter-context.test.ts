import { afterEach, expect, it, vi } from 'vitest'
import { prepareEditorChapterContext } from '../editor-chapter-context'
import type { NarrativeThreadView } from '../../shared/narrative-thread'

const session = { projectId: '项目', leaseId: '会话', projectPath: 'C:/合成项目' }
const blueprint = { chapterNumber: 30, title: '北塔', role: '', purpose: '找钥匙', keyEvents: '林岚在北塔找到钥匙', characters: ['林岚'], suspenseHook: '', userGuidance: '别让周砚出场', notes: '', notesUpdatedAt: '' }
const thread: NarrativeThreadView = { id: 1, title: '青铜钥匙', type: '伏笔', targetStartChapter: 20, targetEndChapter: 40, authorIntent: '钥匙要有交代', status: 'progressing',
  dormantChapters: 0, overdue: false, createdAt: '', updatedAt: '', events: [
    { id: 1, planId: 1, draftId: 12, type: 'progressing', evidence: '钥匙落进井里', reason: '', chapterNumber: 12, chapterTitle: '', createdAt: '' },
    { id: 2, planId: 1, draftId: 31, type: 'resolved', evidence: 'LATER_THREAD_EVIDENCE', reason: '', chapterNumber: 31, chapterTitle: '', createdAt: '' }] }
const card = { name: '林岚', role: 'protagonist', currentState: { location: '北塔', mentalState: 'LATER_AUTHOR_STATE',
  provenance: { location: { kind: 'author', chapterNumber: 30 }, mentalState: { kind: 'author', chapterNumber: 31 } } } }
function bridge(handlers: Record<string, (...args: unknown[]) => unknown>) {
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    const handler = handlers[channel]
    if (!handler) throw new Error(`unexpected ${channel}`)
    return handler(...args)
  })
  vi.stubGlobal('window', { aiNovelAPI: { invoke, on: () => () => {} } })
  return invoke
}
const reads = {
  'db:blueprint-get': () => blueprint,
  'db:character-roster-read': () => ({ status: 'ready', entries: [card], aliases: [] }),
  'db:narrative-thread-list-relevant': () => [thread],
  'db:draft-get-finalized': () => ({ id: 29 }),
  'db:draft-get-full': () => ({ id: 29, content: '第二十九章的结尾，雨停了。' }),
}
const prepareWithCounts = (action: 'continue' | 'refine' | 'dialogue', precedingChars = 0) => prepareEditorChapterContext({ session, novelConfig: { narrativePOV: 'first_person', writingStyle: '冷峻' },
  language: 'zh-CN', chapterNumber: 30, action, precedingChars })
const prepare = async (action: 'continue' | 'refine' | 'dialogue', precedingChars = 0) => (await prepareWithCounts(action, precedingChars)).context
afterEach(() => vi.unstubAllGlobals())

it('改第 30 章时，人物状态和线索证据只取到第 30 章为止', async () => {
  bridge(reads)
  const context = await prepare('continue')
  const text = context.blocks.map(block => block.text).join('\n')
  expect(text).toContain('location@chapter30: 北塔')
  expect(text).toContain('来源第12章：钥匙落进井里')
  expect(text).not.toContain('LATER_AUTHOR_STATE')
  expect(text).not.toContain('LATER_THREAD_EVIDENCE')
  expect(context.blocks.map(block => block.kind)).toEqual(['style', 'blueprint', 'characters', 'threads', 'previous-ending'])
  expect(context.blocks.find(block => block.kind === 'blueprint')?.text).toContain('作者微操：别让周砚出场')
})
it('润色只读文风视角，不读蓝图、人物、线索', async () => {
  const invoke = bridge(reads)
  const context = await prepare('refine')
  expect(context.blocks).toEqual([{ kind: 'style', text: '叙事视角：第一人称\n文风：冷峻', required: true }])
  expect(invoke).not.toHaveBeenCalled()
})
it('选区前的本章正文够长时，续写不读上一章结尾', async () => {
  const invoke = bridge(reads)
  const context = await prepare('continue', 800)
  expect(context.blocks.map(block => block.kind)).not.toContain('previous-ending')
  expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:draft-get-full')
})
it('人物名册或线索读不出时只记 unreadable，其余块照常备好', async () => {
  bridge({ ...reads, 'db:character-roster-read': () => { throw new Error('SQLITE_CORRUPT') }, 'db:narrative-thread-list-relevant': () => { throw new Error('SQLITE_BUSY') } })
  const context = await prepare('dialogue')
  expect(context.unreadable).toEqual(['characters'])
  expect(context.blocks.map(block => block.kind)).toEqual(['style', 'blueprint'])
  bridge({ ...reads, 'db:narrative-thread-list-relevant': () => { throw new Error('SQLITE_BUSY') } })
  expect((await prepare('continue')).unreadable).toEqual(['threads'])
})
it('相关线索超出条数或长度上限时，记下没带上的条数', async () => {
  const many = Array.from({ length: 7 }, (_, index) => ({ ...thread, id: index + 1, title: `线索${index + 1}` }))
  bridge({ ...reads, 'db:narrative-thread-list-relevant': () => many })
  const trimmed = await prepareWithCounts('continue')
  expect(trimmed.context.blocks.find(block => block.kind === 'threads')?.text).not.toContain('线索7')
  expect(trimmed.threadsLeftOut).toBe(1)
  bridge({ ...reads, 'db:narrative-thread-list-relevant': () => [{ ...thread, authorIntent: '长'.repeat(1300) }] })
  const tooLong = await prepareWithCounts('continue')
  expect(tooLong.context.blocks.map(block => block.kind)).not.toContain('threads')
  expect(tooLong.threadsLeftOut).toBe(1)
})
