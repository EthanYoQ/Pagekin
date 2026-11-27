import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import { NarrativeThreadRepository } from '../narrative-thread-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-thread-readback-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  vi.restoreAllMocks()
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

const PLAN = { title: '青铜钥匙', type: '伏笔', targetStartChapter: 1, targetEndChapter: 5, authorIntent: '第五章揭示钥匙的来历。' }
const readFails = () => { throw new Error('database disk image is malformed') }
const stored = (id: number) => NarrativeThreadRepository.list().find(thread => thread.id === id)

describe('叙事线写入后回读失败时整次写入撤回，报「没写进去」时确实没写进去', () => {
  it('新建线索', () => {
    vi.spyOn(NarrativeThreadRepository, 'getPlan').mockImplementation(readFails)
    expect(() => NarrativeThreadRepository.createPlan(PLAN)).toThrow('malformed')
    vi.restoreAllMocks()
    expect(NarrativeThreadRepository.list()).toEqual([])
  })

  it('改线索', () => {
    const { id } = NarrativeThreadRepository.createPlan(PLAN)
    vi.spyOn(NarrativeThreadRepository, 'getPlan').mockImplementation(readFails)
    expect(() => NarrativeThreadRepository.updatePlan(id, { ...PLAN, title: '铜钥匙' })).toThrow('malformed')
    vi.restoreAllMocks()
    expect(stored(id)?.title).toBe('青铜钥匙')
  })

  it('确认定稿事件', () => {
    const { id } = NarrativeThreadRepository.createPlan(PLAN)
    const [draft] = FinalizedDraftImportRepository.commit(projectRoot, { operationId: 'readback', chapters: [
      { chapterNumber: 1, title: '旧码头', content: '林岚捡到钥匙。', wordCount: countDraftUnits('林岚捡到钥匙。') },
    ] }).drafts
    const db = getProjectDb()!
    const prepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation(sql => sql.includes('SELECT created_at') ? readFails() : prepare(sql))
    expect(() => NarrativeThreadRepository.confirmEvent({ planId: id, draftId: draft!.draftId, type: 'planted', evidence: '林岚捡到钥匙。', reason: '埋设' }))
      .toThrow('malformed')
    vi.restoreAllMocks()
    expect(stored(id)?.events).toEqual([])
  })

  it('延后线索', () => {
    const { id } = NarrativeThreadRepository.createPlan(PLAN)
    vi.spyOn(NarrativeThreadRepository, 'list').mockImplementation(readFails)
    expect(() => NarrativeThreadRepository.setAssignment({ planId: id, chapterNumber: 6, writingChapter: 5, kind: 'resolve', note: '延后' }))
      .toThrow('malformed')
    vi.restoreAllMocks()
    expect(stored(id)).toEqual(expect.objectContaining({ targetEndChapter: 5 }))
    expect(stored(id)).not.toHaveProperty('assignments')
  })

  it('撤销延后', () => {
    const { id } = NarrativeThreadRepository.createPlan(PLAN)
    NarrativeThreadRepository.setAssignment({ planId: id, chapterNumber: 6, writingChapter: 5, kind: 'resolve', note: '延后' })
    vi.spyOn(NarrativeThreadRepository, 'list').mockImplementation(readFails)
    expect(() => NarrativeThreadRepository.removeAssignment(id, 6, 5)).toThrow('malformed')
    vi.restoreAllMocks()
    expect(stored(id)).toEqual(expect.objectContaining({ targetEndChapter: 6, assignments: [expect.objectContaining({ chapterNumber: 6 })] }))
  })
})
