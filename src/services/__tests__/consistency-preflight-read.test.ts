import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../ipc-client', () => ({ ipc: { invokeWithProjectSession: invoke } }))

import { readConsistencyPreflight } from '../consistency-preflight'

const session = { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' }
const BLUEPRINT = {
  chapterNumber: 2, title: '新的清晨', role: '发展', purpose: '主角拜访证人', keyEvents: '主角前往车站。',
  characters: ['林岚', '顾舟'], suspenseHook: '证人突然失踪。', userGuidance: '', notes: '',
}
const PROJECTION = [{
  draftId: 7, chapterNumber: 1, chapterTitle: '午夜怀表', chapterNotes: '银色怀表仍待调查。', sourceStatus: 'current',
  facts: [{ category: 'character-state', entities: ['顾舟'], statement: '顾舟已经死亡。', sourceChapter: 1, evidence: '表盖内侧刻着一组陌生坐标。' }],
}]

const REJECTIONS = [
  ['master 的原文', new Error("Error invoking remote method 'db:x': SqliteError: database disk image is malformed")],
  ['迁移后的通用码', new Error('IPC_HANDLER_FAILED')],
] as const

function answer(failing: string | undefined, rejection: Error) {
  invoke.mockImplementation(async (_session: unknown, channel: string) => {
    if (channel === failing) throw rejection
    if (channel === 'db:consistency-exemption-list') return []
    if (channel === 'db:blueprint-relationship-hints') return { 2: [{ characterId: 'c-1' }] }
    if (channel === 'db:character-continuity-preflight-nodes') return []
    if (channel === 'finalized-character:list-relation-candidates') return []
    if (channel === 'db:continuity-list-before') return PROJECTION
    throw new Error(`unexpected ${channel}`)
  })
}

beforeEach(() => { invoke.mockReset() })

describe('一致性预检的判定不变', () => {
  it('读得到数据时按数据给出结论', async () => {
    answer(undefined, new Error('unused'))
    const result = await readConsistencyPreflight(session, [BLUEPRINT])
    expect(result.findings).toEqual([expect.objectContaining({ chapterNumber: 2, sourceChapter: 1, severity: 'warning' })])
  })

  it.each(REJECTIONS)('关系提示与关系节点读不出来时只少这一类提示（%s）', async (_name, rejection) => {
    answer(undefined, rejection)
    const expected = await readConsistencyPreflight(session, [BLUEPRINT])
    for (const failing of ['db:blueprint-relationship-hints', 'db:character-continuity-preflight-nodes', 'finalized-character:list-relation-candidates']) {
      answer(failing, rejection)
      expect(await readConsistencyPreflight(session, [BLUEPRINT]), failing).toEqual(expected)
    }
  })

  it.each(REJECTIONS)('豁免与连续性记录读不出来时预检照旧失败（%s）', async (_name, rejection) => {
    for (const failing of ['db:consistency-exemption-list', 'db:continuity-list-before']) {
      answer(failing, rejection)
      await expect(readConsistencyPreflight(session, [BLUEPRINT]), failing).rejects.toBe(rejection)
    }
  })
})
