import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import {
  chapterThreadPanel,
  chapterThreadTasks,
  effectiveTargetEndChapter,
  narrativeThreadSchedule,
  parseChapterThreadTasks,
  type NarrativeThreadView,
} from '../../../src/shared/narrative-thread'
import { NarrativeThreadRepository } from '../narrative-thread-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-assign-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

const plan = (title: string, targetStartChapter: number, targetEndChapter: number) => NarrativeThreadRepository.createPlan({
  title, type: '伏笔', targetStartChapter, targetEndChapter, authorIntent: `${title}要有交代。`,
})
const defer = (planId: number, writingChapter: number, chapterNumber: number) => NarrativeThreadRepository.setAssignment({
  planId, writingChapter, chapterNumber, kind: 'resolve', note: `写第 ${writingChapter} 章前延后到第 ${chapterNumber} 章`,
})
const advance = (planId: number, chapterNumber: number) => NarrativeThreadRepository.setAssignment({
  planId, writingChapter: chapterNumber, chapterNumber, kind: 'advance', note: `写第 ${chapterNumber} 章前指定本章推进`,
})
const thread = (id: number): NarrativeThreadView => NarrativeThreadRepository.list().find(item => item.id === id)!
const taskIds = (chapter: number) => chapterThreadTasks(NarrativeThreadRepository.list(), chapter).tasks.map(task => task.planId)

describe('写前延后和指定本章推进', () => {
  it('第 5 章到期的线索延后一章：本章不是硬任务，第 6 章列为到期', () => {
    const { id } = plan('青铜钥匙', 1, 5)
    expect(taskIds(5)).toEqual([id])

    defer(id, 5, 6)

    expect(taskIds(5)).toEqual([])
    expect(chapterThreadTasks(NarrativeThreadRepository.list(), 6).tasks).toEqual([expect.objectContaining({ planId: id, schedule: { kind: 'due' } })])
  })

  it('写第 6 章前再延三章：截止章是第 9 章，原定的 targetEndChapter 还是 5', () => {
    const { id } = plan('青铜钥匙', 1, 5)
    defer(id, 5, 6)
    defer(id, 6, 9)

    expect(thread(id).targetEndChapter).toBe(5)
    expect(effectiveTargetEndChapter(thread(id))).toBe(9)
    expect(narrativeThreadSchedule(thread(id), 9)).toEqual({ kind: 'due' })
    expect(narrativeThreadSchedule(thread(id), 10)).toEqual({ kind: 'overdue', chaptersOverdue: 1 })
  })

  it('撤销只删这一行：截止章回到上一个生效值，本章重新是硬任务', () => {
    const { id } = plan('青铜钥匙', 1, 5)
    defer(id, 5, 6)
    defer(id, 6, 9)
    expect(taskIds(6)).toEqual([])

    NarrativeThreadRepository.removeAssignment(id, 9)

    expect(effectiveTargetEndChapter(thread(id))).toBe(6)
    expect(taskIds(6)).toEqual([id])
    NarrativeThreadRepository.removeAssignment(id, 6)
    expect(effectiveTargetEndChapter(thread(id))).toBe(5)
    expect(narrativeThreadSchedule(thread(id), 6)).toEqual({ kind: 'overdue', chaptersOverdue: 1 })
  })

  it('重复点延后和重复点撤销收敛到同一结果', () => {
    const { id } = plan('青铜钥匙', 1, 5)
    defer(id, 5, 6)
    defer(id, 5, 6)
    expect(thread(id).assignments).toEqual([{ chapterNumber: 6, kind: 'resolve', note: '写第 5 章前延后到第 6 章' }])

    NarrativeThreadRepository.removeAssignment(id, 6)
    NarrativeThreadRepository.removeAssignment(id, 6)
    expect(thread(id).assignments).toBeUndefined()
  })

  it('逾期线索的延后从正在写的章算，延后后在新截止章前仍作软参考进相关列表', () => {
    const { id } = plan('青铜钥匙', 1, 2)
    defer(id, 5, 6)
    const context = { chapterNumber: 5, title: '无关标题', keyEvents: '无关事件', characters: [] }

    expect(narrativeThreadSchedule(thread(id), 5)).toEqual({ kind: 'in-window' })
    expect(NarrativeThreadRepository.listRelevantActive(context).map(item => item.id)).toEqual([id])
    expect(thread(id).overdue).toBe(false)
  })

  it('设为本章推进：这一章是 assigned 硬任务，下一章不是，截止章不变', () => {
    const { id } = plan('父亲的旧信', 3, 9)
    advance(id, 5)

    expect(chapterThreadTasks(NarrativeThreadRepository.list(), 5).tasks).toEqual([expect.objectContaining({ planId: id, schedule: { kind: 'assigned' } })])
    expect(taskIds(6)).toEqual([])
    expect(effectiveTargetEndChapter(thread(id))).toBe(9)
  })

  it('到期优先于作者指定', () => {
    const { id } = plan('父亲的旧信', 3, 5)
    advance(id, 5)
    expect(narrativeThreadSchedule(thread(id), 5)).toEqual({ kind: 'due' })
  })

  it('7 条逾期加 1 条指定：指定的在 6 条之内，弹层列全部并给出未纳入条数', () => {
    const overdue = Array.from({ length: 7 }, (_, index) => plan(`逾期${index + 1}`, 1, 2).id)
    const assigned = plan('作者指定', 3, 12).id
    advance(assigned, 8)
    const threads = NarrativeThreadRepository.list()

    const { tasks, leftOut } = chapterThreadTasks(threads, 8)
    expect(tasks).toHaveLength(6)
    expect(tasks[0]).toMatchObject({ planId: assigned, schedule: { kind: 'assigned' } })
    expect(leftOut).toBe(2)

    const panel = chapterThreadPanel(threads, 8)
    expect(panel.rows.map(row => row.thread.id)).toEqual([assigned, ...overdue])
    expect(panel).toMatchObject({ taskCount: 6, leftOut: 2 })
  })

  it('弹层：延后的线索变成可撤销的一行，区间内的进「也可以本章推进」，重开仍能撤销', () => {
    const due = plan('青铜钥匙', 1, 5).id
    const inWindow = plan('父亲的旧信', 3, 9).id
    const later = plan('远期', 7, 9).id
    const resolvedLater = chapterThreadPanel(NarrativeThreadRepository.list(), 5)
    expect(resolvedLater.rows).toEqual([expect.objectContaining({ state: 'task', schedule: { kind: 'due' }, thread: expect.objectContaining({ id: due }) })])
    expect(resolvedLater.canAdvance.map(item => item.id)).toEqual([inWindow])

    defer(due, 5, 8)

    const panel = chapterThreadPanel(NarrativeThreadRepository.list(), 5)
    expect(panel.rows).toEqual([expect.objectContaining({ state: 'deferred', deferredTo: 8, thread: expect.objectContaining({ id: due }) })])
    expect(panel.canAdvance.map(item => item.id)).toEqual([inWindow])
    expect(panel.canAdvance.map(item => item.id)).not.toContain(later)
    expect(panel).toMatchObject({ taskCount: 0, leftOut: 0 })
  })

  it('旧版本冻结的线索任务（只有 due、overdue）和新的 assigned 都能读回，键序不变', () => {
    const recorded = [
      { planId: 1, title: '旧', authorIntent: '甲', schedule: { kind: 'overdue', chaptersOverdue: 2 } },
      { planId: 2, title: '到期', authorIntent: '乙', schedule: { kind: 'due' } },
      { planId: 3, title: '指定', authorIntent: '丙', schedule: { kind: 'assigned' } },
    ]
    expect(JSON.stringify(parseChapterThreadTasks(recorded))).toBe(JSON.stringify(recorded))
    expect(parseChapterThreadTasks([{ ...recorded[0], schedule: { kind: 'later' } }])).toBeNull()
  })

  it('线索计划删除时 assignments 级联消失，没有报错', () => {
    const { id } = plan('青铜钥匙', 1, 5)
    defer(id, 5, 6)
    NarrativeThreadRepository.deletePlan(id)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM narrative_thread_assignments').pluck().get()).toBe(0)
    expect(NarrativeThreadRepository.list()).toEqual([])
  })

  it('延后到的章必须大于正在写的章；线索不存在时报线索不存在，都不留行', () => {
    const { id } = plan('青铜钥匙', 1, 5)
    expect(() => defer(id, 5, 5)).toThrow('NARRATIVE_THREAD_RANGE_INVALID')
    expect(() => defer(id, 5, 4)).toThrow('NARRATIVE_THREAD_RANGE_INVALID')
    expect(() => defer(id + 1, 5, 6)).toThrow('NARRATIVE_THREAD_PLAN_NOT_FOUND')
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM narrative_thread_assignments').pluck().get()).toBe(0)
  })

  it('没有指定和延后的线索不带 assignments 字段', () => {
    const { id } = plan('青铜钥匙', 1, 5)
    expect(thread(id)).not.toHaveProperty('assignments')
  })
})
