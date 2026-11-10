import { describe, expect, it } from 'vitest'
import {
  buildBlueprintContinuityCheckTask, continuityFindingKey, isChapterAsChecked, parseBlueprintContinuityCheck, selectContinuityCheckScope,
  type ContinuityCheckChapter, type ContinuityCheckNode,
} from '../blueprint-continuity-check'
import type { ContinuityNode } from '../character-continuity'
import { exemptedFactKeys } from '../consistency-preflight'

const chapter = (chapterNumber: number, keyEvents = '并肩作战'): ContinuityCheckChapter => ({
  chapterNumber, title: `第${chapterNumber}章`, role: '', purpose: '', keyEvents, characters: [], suspenseHook: '', userGuidance: '', notes: '',
})
const node = (eventId: string, fromChapter: number): ContinuityCheckNode => ({ eventId, sourceChapter: fromChapter - 1, fromChapter, subjectName: '林岚', aspect: 'physicalState', value: '重伤' })
const line = (over: Record<string, unknown>) => JSON.stringify({ findings: [{ chapterNumber: 3, eventIds: ['e1'], issue: '矛盾', suggestion: '改', ...over }] })
const parse = (text: string) => parseBlueprintContinuityCheck(text, [chapter(2), chapter(3)], [node('真实节点', 2), node('后来的节点', 9)])

describe('parseBlueprintContinuityCheck', () => {
  it('把模型的短 id 换回真实 eventId', () => {
    expect(parse(line({})).findings).toEqual([{ chapterNumber: 3, eventIds: ['真实节点'], issue: '矛盾', suggestion: '改' }])
  })
  it('引用该章还看不到的节点按编造处理', () => {
    expect(parse(line({ eventIds: ['e2'] }))).toMatchObject({ findings: [], droppedFindings: 1 })
  })
  it.each([
    ['章号不是数字', { chapterNumber: '3' }], ['eventIds 为空', { eventIds: [] }], ['eventIds 不是数组', { eventIds: 'e1' }],
    ['说明为空', { issue: ' ' }], ['建议过长', { suggestion: '长'.repeat(601) }],
  ])('%s：丢弃这一条', (_name, over) => {
    expect(parse(line(over))).toMatchObject({ findings: [], droppedFindings: 1 })
  })
  it('整段读不出来才抛错', () => {
    expect(() => parse('不是 JSON')).toThrow()
    expect(() => parse('{"wrong":[]}')).toThrow('GENERATION_GRAPH_CONTINUITY_RESULT_INVALID')
  })
  it('容忍代码围栏，同章同依据只留一条，空结果写明检查到第几章', () => {
    expect(parse('```json\n{"findings":[]}\n```')).toEqual({ checkedThroughChapter: 3, findings: [], droppedFindings: 0 })
    const twice = JSON.stringify({ findings: [{ chapterNumber: 3, eventIds: ['e1'], issue: '一', suggestion: '改' }, { chapterNumber: 3, eventIds: ['e1'], issue: '二', suggestion: '改' }] })
    expect(parse(twice).findings).toHaveLength(1)
  })
})

describe('selectContinuityCheckScope', () => {
  const blueprint = (chapterNumber: number, keyEvents = '事件') => ({ ...chapter(chapterNumber, keyEvents), notesUpdatedAt: '' })
  const author = (eventId: string, value: string, effectiveChapter: number): ContinuityNode => ({ eventId, subjectId: '甲', subjectName: '林岚', aspect: 'physicalState', value, effectiveChapter, provenance: { kind: 'author', operationId: eventId }, draftId: null, seq: 1, quote: null })

  it('同系列只留各章生效的最新节点，未来才生效的节点按章进入', () => {
    const scope = selectContinuityCheckScope([blueprint(5)], [author('旧', '轻伤', 1), author('新', '重伤', 3), author('未来', '痊愈', 9)], 100_000)
    expect(scope.nodes.map(item => item.eventId)).toEqual(['新'])
  })
  it('没有定稿原文的派生节点不进输入', () => {
    const derived = { ...author('派生', '重伤', 1), provenance: { kind: 'derived' as const, source: { draftId: 1, chapterNumber: 1, finalizationId: 'f', contentHash: 'h' } } }
    expect(selectContinuityCheckScope([blueprint(5)], [derived], 100_000).nodes).toEqual([])
  })
  it('按章号从小到大放，放不下就停，不跳过', () => {
    const scope = selectContinuityCheckScope([blueprint(4, '短'), blueprint(2, '长'.repeat(900)), blueprint(3, '短')], [], 2_000)
    expect(scope.chapters.map(item => item.chapterNumber)).toEqual([2])
  })
})

it('任务把节点换成短 id，不带真实 eventId', () => {
  const task = buildBlueprintContinuityCheckTask({ writingLanguage: 'zh-CN', chapters: [chapter(2)], nodes: [node('derived:很长的UUID', 2)] })
  expect(task.messages[1]!.content).toContain('"id":"e1"')
  expect(task.messages[1]!.content).not.toContain('很长的UUID')
})

it('蓝图改过就不算已检查，空保存和时间戳不算改', () => {
  const checked = chapter(2)
  expect(isChapterAsChecked(checked, { ...checked, notesUpdatedAt: '今天' })).toBe(true)
  expect(isChapterAsChecked(checked, { ...checked, keyEvents: '改了', notesUpdatedAt: '' })).toBe(false)
  expect(isChapterAsChecked(checked, undefined)).toBe(false)
})

it('豁免键与 eventIds 顺序无关，按章和全书豁免都经同一过滤', () => {
  const key = continuityFindingKey(['b', 'a'])
  expect(key).toBe(continuityFindingKey(['a', 'b']))
  expect(key).toMatch(/^ai:[0-9a-f]{16}$/u)
  expect(exemptedFactKeys([{ stableFactKey: key, reason: '', revoked: false, chapterNumber: 3 }], 3).has(key)).toBe(true)
  expect(exemptedFactKeys([{ stableFactKey: key, reason: '', revoked: false, chapterNumber: 3 }], 4).has(key)).toBe(false)
  expect(exemptedFactKeys([{ stableFactKey: key, reason: '', revoked: false, chapterNumber: null }], 4).has(key)).toBe(true)
  expect(exemptedFactKeys([{ stableFactKey: key, reason: '', revoked: true, chapterNumber: 3 }], 3).has(key)).toBe(false)
})
