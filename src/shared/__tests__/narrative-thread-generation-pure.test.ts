import { describe, expect, it } from 'vitest'

import {
  buildNarrativeThreadEventTask,
  buildNarrativeThreadPlanTask,
  parseNarrativeThreadEventCandidates,
  parseNarrativeThreadPlanCandidates,
} from '../narrative-thread-generation-pure'

describe('narrative thread AI candidate boundary', () => {
  it.each(['zh-CN', 'en-US'] as const)('pure %s event task preserves finalized bytes and omits transport identity', writingLanguage => {
    const finalizedContent = '  林岚把日志藏进抽屉。\r\n尾行  '
    const task = buildNarrativeThreadEventTask({ writingLanguage, draftId: 41, chapterNumber: 3,
      finalizedContent, plan: {
        id: 7, title: '日志', type: '伏笔', targetStartChapter: 1, targetEndChapter: 4,
        authorIntent: '找到日志。', status: 'planted', dormantChapters: 0, overdue: false,
        events: [], createdAt: '', updatedAt: '',
      },
    })
    expect(task.messages[0].content).toContain(writingLanguage === 'zh-CN' ? '小说定稿事实审查员' : 'finalized fiction facts')
    const payload = JSON.parse(task.messages[1].content)
    expect(payload.finalizedContent).toBe(finalizedContent)
    expect(payload.plan.currentStatus).toBe('planted')
    expect(payload).not.toHaveProperty('draftId')
    expect(task).not.toHaveProperty('modelId')
    expect(task).not.toHaveProperty('signal')
  })

  it('accepts up to eight useful foreshadowing plan candidates', () => {
    const candidates = parseNarrativeThreadPlanCandidates(JSON.stringify({
      candidates: Array.from({ length: 8 }, (_, index) => ({
        title: `线索 ${index + 1}`,
        type: '伏笔',
        targetStartChapter: 1,
        targetEndChapter: index + 2,
        authorIntent: `在第 ${index + 2} 章回收`,
      })),
    }), 20)

    expect(candidates).toHaveLength(8)
  })

  it('keeps blueprint analysis as plan-only candidates even when the model claims an event already happened', () => {
    const candidates = parseNarrativeThreadPlanCandidates(JSON.stringify({
      candidates: [{
        title: '门框上的刻痕',
        type: '伏笔',
        targetStartChapter: 2,
        targetEndChapter: 8,
        authorIntent: '模型声称第一章已经埋设；作者仍需先确认人工计划。',
        eventType: 'planted',
        evidence: '门框已有三道刻痕。',
      }],
    }), 12)

    expect(candidates).toEqual([{
      title: '门框上的刻痕',
      type: '伏笔',
      targetStartChapter: 2,
      targetEndChapter: 8,
      authorIntent: '模型声称第一章已经埋设；作者仍需先确认人工计划。',
    }])
    expect(candidates[0]).not.toHaveProperty('eventType')
    expect(candidates[0]).not.toHaveProperty('evidence')
  })

  it('rejects the whole result when a plan is outside the frozen chapter range', () => {
    expect(() => parseNarrativeThreadPlanCandidates(JSON.stringify({
      candidates: [
        { title: '校庆直播', type: '主线', targetStartChapter: 2, targetEndChapter: 4, authorIntent: '第四章回收。' },
        { title: '毕业后重逢', type: '伏笔', targetStartChapter: 2, targetEndChapter: 18, authorIntent: '远期回收。' },
      ],
    }), 4)).toThrow('NARRATIVE_THREAD_CANDIDATES_INVALID')
  })

  it('rejects the whole result when an event has invalid evidence or type', () => {
    const finalized = '林岚推开旧仓库的门，发现门框上有三道平行刻痕。她没有声张。'
    expect(() => parseNarrativeThreadEventCandidates(JSON.stringify({
      candidates: [
        { type: 'planted', evidence: '门框上有三道平行刻痕', reason: '第一章完成埋设。' },
        { type: 'resolved', evidence: '正文中不存在的银钥匙', reason: '不能确认。' },
        { type: 'planned', evidence: '她没有声张', reason: '非法事件类型。' },
      ],
    }), finalized)).toThrow('NARRATIVE_THREAD_CANDIDATES_INVALID')
  })

  it.each(['plan', 'event'] as const)('distinguishes a valid empty %s list from an invalid envelope', kind => {
    const parse = (content: string) => kind === 'plan'
      ? parseNarrativeThreadPlanCandidates(content, 4)
      : parseNarrativeThreadEventCandidates(content, '铜钥匙')
    expect(parse('{"candidates":[]}')).toEqual([])
    for (const content of ['{}', '[]', '{"candidates":null}', '{"candidates":[null]}']) {
      expect(() => parse(content)).toThrow('NARRATIVE_THREAD_CANDIDATES_INVALID')
    }
  })

  it.each(['plan', 'event'] as const)('rejects overlong and excess %s candidates instead of silently dropping them', kind => {
    const valid = kind === 'plan'
      ? { title: '铜钥匙', type: '伏笔', targetStartChapter: 1, targetEndChapter: 3, authorIntent: '打开北塔' }
      : { type: 'planted', evidence: '铜钥匙', reason: '发现钥匙' }
    const invalid = kind === 'plan' ? { ...valid, authorIntent: '甲'.repeat(1001) } : { ...valid, reason: '甲'.repeat(501) }
    const parse = (candidates: unknown[]) => kind === 'plan'
      ? parseNarrativeThreadPlanCandidates(JSON.stringify({ candidates }), 4)
      : parseNarrativeThreadEventCandidates(JSON.stringify({ candidates }), '铜钥匙')
    expect(parse([valid])).toEqual([valid])
    for (const candidates of [[invalid], [valid, invalid], Array.from({ length: kind === 'plan' ? 9 : 6 }, () => valid)]) {
      expect(() => parse(candidates)).toThrow('NARRATIVE_THREAD_CANDIDATES_INVALID')
    }
    expect(() => parse([{ ...valid, type: ['planted'] }])).toThrow('NARRATIVE_THREAD_CANDIDATES_INVALID')
  })

  it('freezes the chapter range into one structured planning task', () => {
    const task = buildNarrativeThreadPlanTask({
      writingLanguage: 'zh-CN',
      totalChapters: 12,
      blueprint: {
        chapterNumber: 2, title: '日志失踪', role: '发展', purpose: '引出伪造者',
        keyEvents: '航海日志从保险柜消失。', characters: ['林岚'], suspenseHook: '',
        userGuidance: '', notes: '', notesUpdatedAt: '',
      },
    })

    expect(task).toMatchObject({
      purpose: 'narrative-thread-plan-candidate',
      reasoningStage: 'planning',
      output: 'structured-data',
    })
    expect(task.messages.find(message => message.role === 'system')?.content).toContain('1..12')
    expect(JSON.parse(task.messages.find(message => message.role === 'user')?.content ?? '{}'))
      .toMatchObject({ totalChapters: 12 })
  })

  it('binds an event candidate to the supplied finalized source instead of trusting model identity fields', () => {
    const task = buildNarrativeThreadEventTask({
      writingLanguage: 'zh-CN',
      plan: {
        id: 7, title: '失踪的日志', type: '长期承诺', targetStartChapter: 2,
        targetEndChapter: 8, authorIntent: '第八章揭示伪造者。', status: 'planted',
        dormantChapters: 0, overdue: false, events: [], createdAt: '', updatedAt: '',
      },
      draftId: 41,
      chapterNumber: 3,
      finalizedContent: '林岚把日志藏进抽屉，又故意把窗户留了一条缝。',
    })
    const candidates = parseNarrativeThreadEventCandidates(JSON.stringify({ candidates: [{
      planId: 999, draftId: 999, chapterNumber: 999,
      type: 'progressing', evidence: '林岚把日志藏进抽屉', reason: '线索得到推进。',
    }] }), '林岚把日志藏进抽屉，又故意把窗户留了一条缝。')

    expect(candidates).toEqual([{
      type: 'progressing', evidence: '林岚把日志藏进抽屉', reason: '线索得到推进。',
    }])
    expect(task).toMatchObject({
      purpose: 'narrative-thread-event-candidate',
      reasoningStage: 'review',
      output: 'structured-data',
    })
  })
})
