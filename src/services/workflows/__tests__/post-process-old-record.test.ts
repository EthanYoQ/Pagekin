import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getProjectDb } from '../../../../electron/database'
import { applyBaselineTables } from '../../../../electron/migrations/baseline-schema'
import { PostProcessRepository } from '../../../../electron/repositories/post-process-repository'
import { translate } from '../../../i18n/core'
import { shown } from '../../../i18n/__tests__/shown-locale'
import { planFinalizationRetry } from '../../../shared/finalization-step-error'
import { finalizationStepErrorMessage } from '../workflow-utils'

vi.mock('../../../../electron/database', () => ({ getProjectDb: vi.fn() }))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const RAW = "Error invoking remote method 'db:kb-import': TypeError: Cannot read properties of undefined (reading 'docId')"
let db: BetterSqlite3.Database

beforeEach(() => {
  db = new Database(':memory:')
  applyBaselineTables(db)
  vi.mocked(getProjectDb).mockReturnValue(db)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

describe('旧记录里的 step.error 不显示给作者，读旧记录不报错', () => {
  it('升级前落库的原文读得出来，显示成通用说明，重试照旧可点', () => {
    const runId = PostProcessRepository.createRun({ triggerSourceType: 'chapter', triggerSourceId: '3', sourceLabel: '第 3 章定稿',
      steps: [{ key: 'kb_import', label: '导入知识库', critical: true }] })
    PostProcessRepository.markStepFailed(runId, 'kb_import', RAW)

    const [step] = PostProcessRepository.getSteps(runId)
    expect(step).toMatchObject({ stepKey: 'kb_import', ok: false, errorMsg: RAW })
    for (const locale of ['zh-CN', 'en-US', 'ja-JP'] as const) {
      const shownText = finalizationStepErrorMessage(shown(locale), step!.errorMsg)
      expect(shownText).toBe(translate(shown(locale), 'error.unregisteredCode'))
      expect(shownText).not.toContain('docId')
    }
    expect(planFinalizationRetry({ kb_import: { ok: false, error: step!.errorMsg } }).rows.has('kb_import')).toBe(true)
  })
})
