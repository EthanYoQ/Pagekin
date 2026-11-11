import { describe, expect, it } from 'vitest'
import {
  buildBlueprintContinuityCheckTask, continuityFindingKey, isChapterAsChecked, parseBlueprintContinuityCheck, selectContinuityCheckScope,
  type ContinuityCheckChapter, type ContinuityCheckNode,
} from '../blueprint-continuity-check'
import type { ContinuityNode } from '../character-continuity'
import { exemptedFactKeys, findBlueprintContinuityRisks } from '../consistency-preflight'

const chapter = (chapterNumber: number, keyEvents = '并肩作战'): ContinuityCheckChapter => ({
  chapterNumber, title: `第${chapterNumber}章`, role: '', purpose: '', keyEvents, characters: [], suspenseHook: '', userGuidance: '', notes: '',
})
const node = (eventId: string, fromChapter: number): ContinuityCheckNode => ({ eventId, since: { zhCN: `第 ${fromChapter - 1} 章定稿后`, enUS: '' }, fromChapter, subjectName: '林岚', aspect: 'physicalState', value: '重伤' })
const line = (over: Record<string, unknown>) => JSON.stringify({ findings: [{ chapterNumber: 3, eventIds: ['e1'], issue: '矛盾', suggestion: '改', ...over }] })
const parse = (text: string) => parseBlueprintContinuityCheck(text, [chapter(2), chapter(3)], [node('真实节点', 2), node('后来的节点', 9)])

describe('parseBlueprintContinuityCheck', () => {
  it('把模型的短 id 换回真实 eventId', () => {
    expect(parse(line({})).findings).toEqual([{ chapterNumber: 3, eventIds: ['真实节点'], points: [{ issue: '矛盾', suggestion: '改' }] }])
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
  it('容忍代码围栏，空结果写明检查到第几章', () => {
    expect(parse('```json\n{"findings":[]}\n```')).toEqual({ checkedThroughChapter: 3, findings: [], droppedFindings: 0 })
  })
  it('同章同依据的几条矛盾并进一条结论，逐条都留着，原样重复的只留一次', () => {
    const items = [
      { chapterNumber: 3, eventIds: ['e1'], issue: '一', suggestion: '改甲' },
      { chapterNumber: 3, eventIds: ['e1'], issue: '二', suggestion: '改乙' },
      { chapterNumber: 3, eventIds: ['e1'], issue: '一', suggestion: '改甲' },
    ]
    expect(parse(JSON.stringify({ findings: items })).findings).toEqual([{ chapterNumber: 3, eventIds: ['真实节点'], points: [
      { issue: '一', suggestion: '改甲' }, { issue: '二', suggestion: '改乙' },
    ] }])
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
  it('窗口连一章都放不下：仍放第一章，不拒绝检查', () => {
    expect(selectContinuityCheckScope([blueprint(3), blueprint(2)], [], 0).chapters.map(item => item.chapterNumber)).toEqual([2])
  })
  it('按章号从小到大放，放不下就停，不跳过', () => {
    const scope = selectContinuityCheckScope([blueprint(4, '短'), blueprint(2, '长'.repeat(900)), blueprint(3, '短')], [], 2_000)
    expect(scope.chapters.map(item => item.chapterNumber)).toEqual([2])
  })
  it.each([
    ['后来清空', author('清空', '', 3)],
    ['后来换了值', author('痊愈', '痊愈', 3)],
  ])('节点在后面的章%s：后面那章引用它的结论丢弃，前面的章照常', (_name, later) => {
    const scope = selectContinuityCheckScope([blueprint(2), blueprint(3)], [author('重伤', '重伤', 1), later], 100_000)
    const injuryId = `e${scope.nodes.findIndex(item => item.eventId === '重伤') + 1}`
    const cite = (chapterNumber: number) => JSON.stringify({ findings: [{ chapterNumber, eventIds: [injuryId], issue: '矛盾', suggestion: '改' }] })
    expect(parseBlueprintContinuityCheck(cite(2), scope.chapters, scope.nodes)).toMatchObject({ findings: [{ chapterNumber: 2 }], droppedFindings: 0 })
    expect(parseBlueprintContinuityCheck(cite(3), scope.chapters, scope.nodes)).toMatchObject({ findings: [], droppedFindings: 1 })
    const task = buildBlueprintContinuityCheckTask({ writingLanguage: 'zh-CN', ...scope })
    expect(JSON.parse(task.messages[1]!.content).timeline.every((item: object) => Object.keys(item).join() === 'id,character,aspect,value,appliesFrom')).toBe(true)
  })
})

describe('依据的来历和规则卡同一种说法', () => {
  const SOURCE = { draftId: 8, finalizationId: 'f8', chapterNumber: 8, contentHash: 'h8' }
  const relation = (provenance: ContinuityNode['provenance']): ContinuityNode => ({
    eventId: 'relation:line', subjectId: 'a', subjectName: '林晚', targetId: 'b', targetName: '沈舟', relationshipId: 'line', aspect: 'relation',
    value: '决裂', effectiveChapter: 8, provenance, draftId: null, seq: 1, quote: { start: 0, end: 7, text: '两人当场决裂。' },
  })
  const plan = { chapterNumber: 12, title: '同行', role: '发展', purpose: '两人赶路', keyEvents: '山路遇雨', characters: ['林晚', '沈舟'],
    suspenseHook: '', userGuidance: '', notes: '', relationshipHints: [{ from: '林晚', to: '沈舟', relation: '亲密同伴' }] }
  it.each([
    ['角色页或名册设的', { kind: 'author', operationId: 'op' }, '第 8 章起', 'from chapter 8'],
    ['定稿派生的', { kind: 'derived', source: SOURCE }, '第 8 章定稿后', 'since chapter 8 was finalized'],
    ['升级前的', { kind: 'legacy' }, '升级前的设定里', 'in your notes from before the upgrade'],
  ] as const)('%s', (_name, provenance, zhCN, enUS) => {
    const relationNode = relation(provenance)
    const [aiNode] = selectContinuityCheckScope([{ ...plan, notesUpdatedAt: '' }], [relationNode], 100_000).nodes
    const [rule] = findBlueprintContinuityRisks([], plan, [], [relationNode])
    expect(aiNode!.since).toEqual({ zhCN, enUS })
    expect(rule!.issue.zhCN).toContain(`但${zhCN}两人是`)
    expect(rule!.issue.enUS).toContain(`but ${enUS} they are`)
  })
})

it('任务把节点换成短 id，不带真实 eventId，也不带来历说法', () => {
  const task = buildBlueprintContinuityCheckTask({ writingLanguage: 'zh-CN', chapters: [chapter(2)], nodes: [node('derived:很长的UUID', 2)] })
  expect(task.messages[1]!.content).toContain('"id":"e1"')
  expect(task.messages[1]!.content).not.toContain('很长的UUID')
  expect(JSON.parse(task.messages[1]!.content).timeline).toEqual([{ id: 'e1', character: '林岚', aspect: 'physicalState', value: '重伤', appliesFrom: 2 }])
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
