import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve('scripts/check-baseline-shrink.mjs')
const CHANNELS = 'electron/ipc/direct-channels.json'
const LISTING = 'test/directory-listing-baseline.json'
const FAILURES = 'test/legacy-failure-baseline.json'
let root: string

function git(...args: string[]) {
  const result = spawnSync('git', ['-c', 'user.name=Baseline Test', '-c', 'user.email=baseline@example.invalid', ...args], { cwd: root, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
}

function write(file: string, entries: unknown) {
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
  write(FAILURES, { 'src/a.ts': { displayedErrorMessage: 2 } })
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

  it('旧约定计数只减不增：某文件计数变大或新增文件就失败，减少和新约定 authorOwned 放行', () => {
    write(FAILURES, { 'src/a.ts': { displayedErrorMessage: 1, authorOwned: 3 } })
    expect(check('base')).toMatchObject({ status: 0 })
    write(FAILURES, { 'src/a.ts': { displayedErrorMessage: 3 } })
    expect(check('base')).toMatchObject({ status: 1, output: expect.stringContaining('src/a.ts 的 displayedErrorMessage（2 → 3）') })
    write(FAILURES, { 'src/a.ts': { displayedErrorMessage: 2 }, 'src/b.ts': { appErrorMessage: 1 } })
    expect(check('base')).toMatchObject({ status: 1, output: expect.stringContaining('src/b.ts 的 appErrorMessage（0 → 1）') })
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

  it('基准上有的名单被改名或删掉，同样失败', () => {
    renameSync(path.join(root, CHANNELS), path.join(root, 'electron/ipc/direct-channels-v2.json'))
    const result = check('base')
    expect(result.status).toBe(1)
    expect(result.output).toContain(CHANNELS)
  })
})

describe('PR CI 的比较步骤用基准提交上的检查脚本', () => {
  const workflow = readFileSync(path.resolve('.github/workflows/pr-ci.yml'), 'utf8').split(/\r?\n/u)
  const start = workflow.findIndex(line => line.trim() === '- name: Check that baselines only shrink')
  const runAt = workflow.findIndex((line, index) => index > start && line.trim() === 'run: |')
  const body = workflow.slice(runAt + 1).filter(line => line.trim() !== '')
  const indent = body[0]!.length - body[0]!.trimStart().length
  const end = body.findIndex(line => line.length - line.trimStart().length < indent)
  const step = body.slice(0, end === -1 ? body.length : end).map(line => line.slice(indent)).join('\n')

  function runStep() {
    const runnerTemp = mkdtempSync(path.join(tmpdir(), 'baseline-shrink-runner-'))
    try {
      const result = spawnSync('bash', ['-c', step], { cwd: root, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: runnerTemp } })
      return { status: result.status, output: result.stdout + result.stderr }
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true })
    }
  }

  function commitScript(content?: string) {
    mkdirSync(path.join(root, 'scripts'), { recursive: true })
    if (content === undefined) copyFileSync(SCRIPT, path.join(root, 'scripts/check-baseline-shrink.mjs'))
    else writeFileSync(path.join(root, 'scripts/check-baseline-shrink.mjs'), content)
  }

  it('PR 把脚本改成放行、同时加长名单，仍按基准上的脚本失败', () => {
    commitScript()
    git('add', '.')
    git('commit', '-q', '-m', 'base with checker')
    commitScript('process.exit(0)\n')
    write(CHANNELS, ['a:one', 'a:two', 'b:new'])
    git('commit', '-q', '-am', 'pr')
    const result = runStep()
    expect(result.status).toBe(1)
    expect(result.output).toContain('b:new')
  })

  it('引入脚本的 PR（基准上还没有它）用自己的那份，名单加长照样失败', () => {
    commitScript()
    write(CHANNELS, ['a:one', 'a:two', 'b:new'])
    git('add', '.')
    git('commit', '-q', '-m', 'pr adds checker')
    expect(runStep().status).toBe(1)
  })
})
