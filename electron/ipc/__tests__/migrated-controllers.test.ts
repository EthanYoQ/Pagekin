import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import DIRECT_CHANNELS from '../direct-channels.json'
import { REPO_ROOT, repoSourceFiles } from '../../../test/helpers/repo-source-files'

const MIGRATED = [
  'electron/controllers/character-avatar-controller.ts',
  'electron/controllers/config-controller.ts',
  'electron/controllers/external-file-grant-controller.ts',
  'electron/controllers/fs-controller.ts',
  'electron/controllers/kb-controller.ts',
  'electron/controllers/model-provider-resource-controller.ts',
  'electron/controllers/official-homepage-controller.ts',
  'electron/controllers/stage-notification-controller.ts',
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
]

it('迁移后的数据库处理器不在直连基线里', () => {
  const source = readFileSync(join(REPO_ROOT, 'electron/controllers/db-controller.ts'), 'utf8')
  for (const channel of MIGRATED_DATABASE_CHANNELS) expect(source, channel).toContain(`'${channel}'`)
  expect(MIGRATED_DATABASE_CHANNELS.filter(channel => (DIRECT_CHANNELS as string[]).includes(channel))).toEqual([])
})
