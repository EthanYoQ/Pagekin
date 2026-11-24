import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { it, vi } from 'vitest'
vi.mock('playwright', () => ({ _electron: { launch: () => { throw new Error('UNIT_TEST_MUST_NOT_LAUNCH_ELECTRON') } } }))
const { loadScenarios, missingPrerequisites } = await import('../drive.mjs')

const scenarios = await loadScenarios(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
const WINDOWS_ONLY = ['errl2-source-unreadable', 'trash-ui', 'x1-cleanup-retry']

it('setup、run、after 里看 process.platform 的场景都在 requires.platform 声明平台', () => {
  const undeclared = Object.entries(scenarios)
    .filter(([, scenario]) => !scenario.requires?.platform && ['setup', 'run', 'after'].some(step => String(scenario[step] ?? '').includes('process.platform')))
    .map(([name]) => name)
  assert.deepEqual(undeclared, [])
})

it('只能在 Windows 上跑的场景，在 macOS 上列为缺前提、不启动，在 Windows 上照常跑', () => {
  const prerequisites = Object.fromEntries(WINDOWS_ONLY.map(name => [name, {
    darwin: missingPrerequisites(scenarios[name], { theme: 'light' }, {}, 'darwin'),
    win32: missingPrerequisites(scenarios[name], { theme: 'light' }, {}, 'win32'),
  }]))
  assert.deepEqual(prerequisites, Object.fromEntries(WINDOWS_ONLY.map(name => [name, { darwin: ['只在 win32 上跑，当前平台 darwin'], win32: [] }])))
})
