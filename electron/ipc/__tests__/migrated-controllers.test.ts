import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import DIRECT_CHANNELS from '../direct-channels.json'
import { REPO_ROOT, repoSourceFiles } from '../../../test/helpers/repo-source-files'

const MIGRATED = [
  'electron/controllers/chapter-lifecycle-controller.ts',
  'electron/controllers/character-avatar-controller.ts',
  'electron/controllers/cloud-backup-controller.ts',
  'electron/controllers/config-controller.ts',
  'electron/controllers/external-file-grant-controller.ts',
  'electron/controllers/finalization-controller.ts',
  'electron/controllers/fs-controller.ts',
  'electron/controllers/import-controller.ts',
  'electron/controllers/kb-controller.ts',
  'electron/controllers/model-provider-resource-controller.ts',
  'electron/controllers/official-homepage-controller.ts',
  'electron/controllers/project-archive-controller.ts',
  'electron/controllers/project-controller.ts',
  'electron/controllers/stage-notification-controller.ts',
  'electron/controllers/update-controller.ts',
  'electron/controllers/startup-controller.ts',
  'electron/controllers/window-controller.ts',
]

it('迁移后的控制器不在直连基线里', () => {
  expect(repoSourceFiles('electron/controllers')).toEqual(expect.arrayContaining(MIGRATED))
  for (const file of MIGRATED) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8')
    const channels = [...source.matchAll(/'([a-z-]+:[a-z-]+)'/gu)].map(match => match[1])
    expect(channels.length, file).toBeGreaterThan(0)
    expect(channels.filter(channel => (DIRECT_CHANNELS as string[]).includes(channel)), file).toEqual([])
    expect(source, file).not.toMatch(/\bipcMain\b/u)
  }
})

const MIGRATED_DATABASE_CHANNELS = [
  'db:recovery-candidate-record',
  'db:recovery-candidate-list',
  'db:recovery-candidate-update',
  'db:recovery-candidate-resolve',
  'db:narrative-thread-list',
  'db:narrative-thread-list-relevant',
  'db:narrative-thread-review-candidates',
  'db:narrative-thread-plan-create',
  'db:narrative-thread-plan-update',
  'db:narrative-thread-plan-delete',
  'db:narrative-thread-event-confirm',
  'db:narrative-thread-assignment-set',
  'db:narrative-thread-assignment-remove',
  'db:plot-tree-read',
  'db:plot-tree-clear',
  'db:log-llm-call',
  'db:get-llm-stats',
  'db:get-llm-history',
  'db:import-global-facts-commit',
  'db:import-run-prepare-inspection',
  'db:import-run-finalize-parsing',
  'db:import-run-author-preview',
  'db:import-run-get',
  'db:import-run-list-resumable',
  'db:import-run-list-chapters',
  'db:import-run-effect-receipt-get',
  'db:import-run-effect-receipt-prepare',
  'db:import-run-effect-receipt-commit',
  'db:import-run-start-resume',
  'db:import-run-renew-execution',
  'db:import-run-restart',
  'db:import-run-request-cancel',
  'db:import-run-cancel-at-boundary',
  'db:import-run-complete-batch',
  'db:import-run-advance-stage',
  'db:import-run-fail',
  'db:import-run-complete',
  'db:finalization-link-knowledge-document',
  'db:post-process-create-run',
  'db:post-process-get-latest-run',
  'db:post-process-get-steps',
  'db:post-process-mark-step-ok',
  'db:post-process-mark-step-failed',
  'db:post-process-is-all-passed',
  'db:review-create',
  'db:review-list',
  'db:review-get-latest',
  'db:review-get-full',
  'db:review-next-index',
  'db:review-cycle-get',
  'db:annotation-history-list',
  'db:annotation-commit',
  'db:revision-create',
  'db:revision-replace-pending',
  'db:revision-list',
  'db:revision-get-pending',
  'db:revision-get-full',
  'db:revision-next-index',
  'db:revision-merge',
  'db:revision-mark-merged',
  'db:revision-mark-discarded',
]

it('迁移后的数据库处理器不在直连基线里', () => {
  const source = readFileSync(join(REPO_ROOT, 'electron/controllers/db-controller.ts'), 'utf8')
  for (const channel of MIGRATED_DATABASE_CHANNELS) expect(source, channel).toContain(`'${channel}'`)
  expect(MIGRATED_DATABASE_CHANNELS.filter(channel => (DIRECT_CHANNELS as string[]).includes(channel))).toEqual([])
})

const MIGRATED_GENERATION_FAMILIES = ['character-proposal', 'character-identity', 'finalized-character', 'legacy-roster', 'review-revision']

it('迁移后的生成通道不在直连基线里', () => {
  const source = readFileSync(join(REPO_ROOT, 'electron/controllers/generation-controller.ts'), 'utf8')
  const channels = [...source.matchAll(/register\('([a-z-]+):([a-z-]+)'/gu)].filter(match => MIGRATED_GENERATION_FAMILIES.includes(match[1]))
  expect(channels).toHaveLength(25)
  expect(channels.map(match => `${match[1]}:${match[2]}`).filter(channel => (DIRECT_CHANNELS as string[]).includes(channel))).toEqual([])
})
