import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const VitestWorkerDiagnostics = createRequire(import.meta.url)('../vitest-worker-diagnostics.cjs')

const BROKEN_STDERR_RUN = `
const fs = require('node:fs')
const path = require('node:path')
const reporter = new (require(process.env.REPORTER))()
const nextTurn = () => new Promise(resolve => setImmediate(resolve))
;(async () => {
  reporter.onInit({ config: { root: process.cwd() } })
  for (const hook of ['onTestModuleQueued', 'onTestModuleStart', 'onTestModuleEnd']) {
    await nextTurn()
    reporter[hook]({ moduleId: path.resolve('scripts/__tests__/vitest-worker-diagnostics.test.ts') })
  }
  await nextTurn()
  reporter.onTestModuleStart({ get moduleId() { throw new Error('metadata unavailable') } })
  setTimeout(() => fs.writeSync(1, 'DONE'), 50)
})()
`

describe('vitest 工作进程诊断报告器', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('读不到测试元数据时不打断测试，并记一行忽略日志', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const metadataFailure = new Error('metadata unavailable')
    const reporter = new VitestWorkerDiagnostics()
    reporter.root = process.cwd()

    expect(() => reporter.onTestModuleStart({ get moduleId() { throw metadataFailure } })).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[ignored]'), metadataFailure)
  })

  it('诊断输出写不出时不打断测试，并记一行忽略日志', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sinkFailure = new Error('EPIPE')
    vi.spyOn(fs, 'writeSync').mockImplementation(() => { throw sinkFailure })
    const reporter = new VitestWorkerDiagnostics()
    reporter.root = process.cwd()

    expect(() => reporter.onTestModuleStart({ moduleId: resolve('scripts/__tests__/vitest-worker-diagnostics.test.ts') })).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[ignored]'), sinkFailure)
  })

  it('stderr 断管时测试进程照常走完，退出码为 0', async () => {
    const child = spawn(process.execPath, ['-e', BROKEN_STDERR_RUN], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, REPORTER: resolve('scripts/vitest-worker-diagnostics.cjs') },
    })
    child.stderr.destroy()
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    const [code, signal] = await once(child, 'close')

    expect(signal).toBeNull()
    expect({ code, stdout: stdout.trim() }).toEqual({ code: 0, stdout: 'DONE' })
  })
})
