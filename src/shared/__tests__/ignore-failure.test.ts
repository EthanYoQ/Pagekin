import { afterEach, describe, expect, it, vi } from 'vitest'

import { ignoreFailure, parseJsonOrUndefined } from '../ignore-failure'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ignoreFailure', () => {
  it('returns the result when the work succeeds without logging', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(ignoreFailure('unused', async () => 7)).resolves.toBe(7)
    expect(warn).not.toHaveBeenCalled()
  })

  it('logs the named reason with the error and resolves undefined when the work fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failure = new Error('database is locked')

    await expect(ignoreFailure('draft list refresh failed', async () => { throw failure })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('[ignored] draft list refresh failed', failure)
  })
})

describe('parseJsonOrUndefined', () => {
  it('parses valid JSON and returns undefined for malformed text', () => {
    expect(parseJsonOrUndefined('{"projects":[]}')).toEqual({ projects: [] })
    expect(parseJsonOrUndefined('null')).toBeNull()
    expect(parseJsonOrUndefined('{"projects":')).toBeUndefined()
  })
})
