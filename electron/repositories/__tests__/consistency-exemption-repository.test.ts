import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { ConsistencyExemptionRepository } from '../consistency-exemption-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-consistency-exemption-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('ConsistencyExemptionRepository', () => {
  it('persists only the stable fact key, reason, and revocation state', () => {
    ConsistencyExemptionRepository.save('open-thread:1:key', '刻意延后到第三章')
    expect(ConsistencyExemptionRepository.list()).toEqual([{
      stableFactKey: 'open-thread:1:key',
      reason: '刻意延后到第三章',
      revoked: false,
      chapterNumber: null,
    }])

    ConsistencyExemptionRepository.revoke('open-thread:1:key')
    expect(ConsistencyExemptionRepository.list()[0]).toEqual({
      stableFactKey: 'open-thread:1:key',
      reason: '刻意延后到第三章',
      revoked: true,
      chapterNumber: null,
    })
  })

  it('rejects an empty reason and can reactivate an existing stable key', () => {
    expect(() => ConsistencyExemptionRepository.save('open-thread:1:key', '  ')).toThrow(/^CONSISTENCY_EXEMPTION_REASON_INVALID$/u)
    expect(() => ConsistencyExemptionRepository.save('  ', '原因')).toThrow(/^CONSISTENCY_EXEMPTION_KEY_INVALID$/u)
    ConsistencyExemptionRepository.save('open-thread:1:key', '第一次原因')
    ConsistencyExemptionRepository.revoke('open-thread:1:key')
    ConsistencyExemptionRepository.save('open-thread:1:key', '新的原因')
    expect(ConsistencyExemptionRepository.list()).toEqual([{
      stableFactKey: 'open-thread:1:key', reason: '新的原因', revoked: false, chapterNumber: null,
    }])
  })

  it('按章豁免和全书豁免各占一行，互不影响', () => {
    ConsistencyExemptionRepository.save('death:老周', '第 3 章是回忆', 3)
    ConsistencyExemptionRepository.save('death:老周', '全书都按假死处理')
    ConsistencyExemptionRepository.revoke('death:老周')
    expect(ConsistencyExemptionRepository.list()).toEqual([
      { stableFactKey: 'death:老周', reason: '全书都按假死处理', revoked: true, chapterNumber: null },
      { stableFactKey: 'death:老周', reason: '第 3 章是回忆', revoked: false, chapterNumber: 3 },
    ])

    ConsistencyExemptionRepository.revoke('death:老周', 3)
    ConsistencyExemptionRepository.save('death:老周', '第 3 章改成幻觉', 3)
    expect(ConsistencyExemptionRepository.list()[1]).toEqual({ stableFactKey: 'death:老周', reason: '第 3 章改成幻觉', revoked: false, chapterNumber: 3 })
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM consistency_exemptions').pluck().get()).toBe(2)
  })

  it.each([0, -1, 1.5])('拒绝不合法的章号 %s', (chapter) => {
    expect(() => ConsistencyExemptionRepository.save('death:老周', '原因', chapter)).toThrow(/^CONSISTENCY_EXEMPTION_KEY_INVALID$/u)
  })
})
