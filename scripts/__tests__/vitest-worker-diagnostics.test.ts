import fs from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const VitestWorkerDiagnostics = createRequire(import.meta.url)('../vitest-worker-diagnostics.cjs')

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
})
