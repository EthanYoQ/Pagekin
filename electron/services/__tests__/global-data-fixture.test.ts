import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { prepareGlobalDataFixture } from './global-data-fixture'

const savedEnv = { vela: process.env.AI_NOVEL_VELA_HOME, appData: process.env.AI_NOVEL_APP_DATA_HOME }
const originalMkdirSync = fs.mkdirSync
const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  fs.mkdirSync = originalMkdirSync
  for (const [key, value] of [['AI_NOVEL_VELA_HOME', savedEnv.vela], ['AI_NOVEL_APP_DATA_HOME', savedEnv.appData]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

it('keeps the underlying file-system error when the global data migration fails on IO', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'global-data-fixture-'))
  roots.push(root)
  const diskError = Object.assign(new Error('EIO: i/o error, mkdir'), { code: 'EIO', syscall: 'mkdir' })
  fs.mkdirSync = (() => { throw diskError }) as typeof fs.mkdirSync

  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const failure = await prepareGlobalDataFixture(root).then(() => null, (error: Error) => error)

  expect(failure?.message).toBe('GLOBAL_MIGRATION_IO_FAILED EIO')
})
