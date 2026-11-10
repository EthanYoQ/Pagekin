import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { chapterThreadPanel, chapterThreadTasks, narrativeThreadSchedule } from '../../../src/shared/narrative-thread'
import { NarrativeThreadRepository } from '../narrative-thread-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-resched-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

const base = { title: '青铜钥匙', type: '伏笔', targetStartChapter: 1, authorIntent: '青铜钥匙要有交代。' }
const plan = (targetEndChapter: number) => NarrativeThreadRepository.createPlan({ ...base, targetEndChapter })
const edit = (id: number, targetEndChapter: number) => NarrativeThreadRepository.updatePlan(id, { ...base, targetEndChapter })
const defer = (planId: number, writingChapter: number, chapterNumber: number) => NarrativeThreadRepository.setAssignment({
  planId, writingChapter, chapterNumber, kind: 'resolve', note: `写第 ${writingChapter} 章时延后`,
})
const view = (id: number) => NarrativeThreadRepository.list().find(item => item.id === id)!
const taskIds = (chapter: number) => chapterThreadTasks(NarrativeThreadRepository.list(), chapter).tasks.map(task => task.planId)

describe('作者最后一次改回收章生效，延后只是改回收章的快捷方式', () => {
  it('写第 5 章时延到第 6 章，再在线索页把回收章存为第 5 章：第 5 章是本章任务', () => {
    const { id } = plan(5)
    defer(id, 5, 6)
    edit(id, 5)
    expect(taskIds(5)).toEqual([id])
  })

  it('延到第 6 章后把回收章改成第 4 章：第 5 章按逾期 1 章排', () => {
    const { id } = plan(5)
    defer(id, 5, 6)
    edit(id, 4)
    expect(narrativeThreadSchedule(view(id), 5)).toEqual({ kind: 'overdue', chaptersOverdue: 1 })
  })

  it('先在线索页存回收章第 5 章，再写第 5 章时延到第 6 章：按第 6 章', () => {
    const { id } = plan(5)
    edit(id, 5)
    defer(id, 5, 6)
    expect(taskIds(5)).toEqual([])
    expect(narrativeThreadSchedule(view(id), 6)).toEqual({ kind: 'due' })
  })

  it('延后后线索的回收章就是第 6 章，编辑表单预填的正是它', () => {
    const { id } = plan(5)
    defer(id, 5, 6)
    expect(view(id).targetEndChapter).toBe(6)
    expect(view(id).assignments).toEqual([{ chapterNumber: 6, kind: 'resolve', note: '写第 5 章时延后' }])
  })
})

describe('写前弹层里撤销延后', () => {
  it('撤销还原延后前的回收章：原先逾期 3 章的仍按逾期 3 章', () => {
    const { id } = plan(2)
    defer(id, 5, 6)
    NarrativeThreadRepository.removeAssignment(id, 6, 2)
    expect(view(id).targetEndChapter).toBe(2)
    expect(view(id).assignments).toBeUndefined()
    expect(narrativeThreadSchedule(view(id), 5)).toEqual({ kind: 'overdue', chaptersOverdue: 3 })
  })

  it('重复点撤销收敛到同一结果', () => {
    const { id } = plan(5)
    defer(id, 5, 6)
    NarrativeThreadRepository.removeAssignment(id, 6, 5)
    edit(id, 7)
    NarrativeThreadRepository.removeAssignment(id, 6, 5)
    expect(view(id).targetEndChapter).toBe(7)
  })

  it('延后之后作者在线索页改了回收章，撤销只删记录，不盖掉作者的改动', () => {
    const { id } = plan(5)
    defer(id, 5, 6)
    edit(id, 8)
    NarrativeThreadRepository.removeAssignment(id, 6, 5)
    expect(view(id).targetEndChapter).toBe(8)
    expect(view(id).assignments).toBeUndefined()
  })

  it('只有本次会话里延后过、回收章仍是延到的那章，才显示可撤销的一行', () => {
    const { id } = plan(5)
    defer(id, 5, 6)
    expect(chapterThreadPanel(NarrativeThreadRepository.list(), 5, new Map([[id, { to: 6 }]])).rows)
      .toEqual([expect.objectContaining({ state: 'deferred', deferredTo: 6 })])

    edit(id, 8)
    expect(chapterThreadPanel(NarrativeThreadRepository.list(), 5, new Map([[id, { to: 6 }]])).rows).toEqual([])
  })

  it('会话记录没了（重启或换章再回来）：延后过的线索在「也可以本章推进」里，点它回到本章任务', () => {
    const { id } = plan(5)
    defer(id, 5, 6)
    const panel = chapterThreadPanel(NarrativeThreadRepository.list(), 5, new Map())
    expect(panel.rows).toEqual([])
    expect(panel.canAdvance.map(item => item.id)).toEqual([id])

    NarrativeThreadRepository.setAssignment({ planId: id, writingChapter: 5, chapterNumber: 5, kind: 'advance', note: '写第 5 章前指定本章推进' })
    expect(taskIds(5)).toEqual([id])
  })

  it('写第 9 章时延到第 10 章，回头重写第 7 章：不出现会把回收章改早的撤销行', () => {
    const { id } = NarrativeThreadRepository.createPlan({ ...base, targetStartChapter: 3, targetEndChapter: 9 })
    defer(id, 9, 10)
    const panel = chapterThreadPanel(NarrativeThreadRepository.list(), 7, new Map())
    expect(panel.rows).toEqual([])
    expect(panel.canAdvance.map(item => item.id)).toEqual([id])
  })
})
