import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve('scripts/check-baseline-shrink.mjs')
const CHANNELS = 'electron/ipc/direct-channels.json'
const LISTING = 'test/directory-listing-baseline.json'
let root: string

function git(...args: string[]) {
  const result = spawnSync('git', ['-c', 'user.name=Baseline Test', '-c', 'user.email=baseline@example.invalid', ...args], { cwd: root, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
}

function write(file: string, entries: string[]) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), `${JSON.stringify(entries)}\n`)
}

function check(base?: string) {
  const result = spawnSync(process.execPath, [SCRIPT, ...(base ? [base] : [])], { cwd: root, encoding: 'utf8' })
  return { status: result.status, output: result.stdout + result.stderr }
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'baseline-shrink-'))
  git('init', '-q', '-b', 'master')
  write(CHANNELS, ['a:one', 'a:two'])
  write(LISTING, ['test/a.test.ts'])
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  git('tag', 'base')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('名单只减不增（与基准提交上的同一文件比较）', () => {
  it('不变或删减时通过', () => {
    write(CHANNELS, ['a:one'])
    write(LISTING, [])
    expect(check('base')).toMatchObject({ status: 0 })
  })

  it.each([CHANNELS, LISTING])('%s 新增一条就失败，并点名新增的条目', file => {
    write(file, file === CHANNELS ? ['a:one', 'a:two', 'b:new'] : ['test/a.test.ts', 'test/new.test.ts'])
    const result = check('base')
    expect(result.status).toBe(1)
    expect(result.output).toContain(file === CHANNELS ? 'b:new' : 'test/new.test.ts')
  })

  it('删掉一条再换一条顶替，同样失败', () => {
    write(CHANNELS, ['a:one', 'b:new'])
    expect(check('base').status).toBe(1)
  })

  it('基准提交拿不到时失败，不放行', () => {
    write(CHANNELS, ['a:one', 'a:two', 'b:new'])
    const result = check('origin/master')
    expect(result.status).toBe(2)
    expect(result.output).toContain('拿不到基准提交')
  })

  it('基准上还没有的名单当作新建，不比较', () => {
    git('rm', '-q', CHANNELS)
    git('commit', '-q', '-m', 'drop channel list')
    git('tag', '-f', 'base')
    write(CHANNELS, ['a:one', 'b:new'])
    expect(check('base')).toMatchObject({ status: 0 })
  })
})
