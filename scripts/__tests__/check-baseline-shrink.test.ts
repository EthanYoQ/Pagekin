import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve('scripts/check-baseline-shrink.mjs')
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
  write(LISTING, ['test/a.test.ts', 'test/b.test.ts'])
  write(FAILURES, { 'src/a.ts': { displayedErrorMessage: 2 } })
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  git('tag', 'base')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('名单只减不增（与基准提交上的同一文件比较）', () => {
  it('不变或删减时通过', () => {
    write(LISTING, ['test/a.test.ts'])
    expect(check('base')).toMatchObject({ status: 0 })
  })

  it('新增一条就失败，并点名新增的条目', () => {
    write(LISTING, ['test/a.test.ts', 'test/b.test.ts', 'test/new.test.ts'])
    const result = check('base')
    expect(result.status).toBe(1)
    expect(result.output).toContain('test/new.test.ts')
  })

  it('旧约定计数只减不增：某文件合计变大或新增文件就失败，减少和新约定 authorOwned 放行', () => {
    write(FAILURES, { 'src/a.ts': { displayedErrorMessage: 1, authorOwned: 3 } })
    expect(check('base')).toMatchObject({ status: 0 })
    write(FAILURES, { 'src/a.ts': { displayedErrorMessage: 3 } })
    expect(check('base')).toMatchObject({ status: 1, output: expect.stringContaining('src/a.ts 的旧约定合计（2 → 3）') })
    write(FAILURES, { 'src/a.ts': { displayedErrorMessage: 2 }, 'src/b.ts': { appErrorMessage: 1 } })
    expect(check('base')).toMatchObject({ status: 1, output: expect.stringContaining('src/b.ts 的旧约定合计（0 → 1）') })
  })

  it('同一文件旧约定种类互换、合计不变时放行；换完合计变大时失败', () => {
    write(FAILURES, { 'src/a.ts': { displayedErrorMessage: 1, '{ legacy:': 1 } })
    expect(check('base')).toMatchObject({ status: 0 })
    write(FAILURES, { 'src/a.ts': { displayedErrorMessage: 1, '{ legacy:': 2 } })
    expect(check('base')).toMatchObject({ status: 1, output: expect.stringContaining('src/a.ts 的旧约定合计（2 → 3）') })
  })

  it('删掉一条再换一条顶替，同样失败', () => {
    write(LISTING, ['test/a.test.ts', 'test/new.test.ts'])
    expect(check('base').status).toBe(1)
  })

  it('基准提交拿不到时失败，不放行', () => {
    write(LISTING, ['test/a.test.ts', 'test/b.test.ts', 'test/new.test.ts'])
    const result = check('origin/master')
    expect(result.status).toBe(2)
    expect(result.output).toContain('拿不到基准提交')
  })

  it('基准上还没有的名单当作新建，不比较', () => {
    git('rm', '-q', LISTING)
    git('commit', '-q', '-m', 'drop listing')
    git('tag', '-f', 'base')
    write(LISTING, ['test/a.test.ts', 'test/new.test.ts'])
    expect(check('base')).toMatchObject({ status: 0 })
  })

  it('基准上有的名单被改名或删掉，同样失败', () => {
    renameSync(path.join(root, LISTING), path.join(root, 'test/directory-listing-baseline-v2.json'))
    const result = check('base')
    expect(result.status).toBe(1)
    expect(result.output).toContain(LISTING)
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
    write(LISTING, ['test/a.test.ts', 'test/b.test.ts', 'test/new.test.ts'])
    git('commit', '-q', '-am', 'pr')
    const result = runStep()
    expect(result.status).toBe(1)
    expect(result.output).toContain('test/new.test.ts')
  })

  it('引入脚本的 PR（基准上还没有它）用自己的那份，名单加长照样失败', () => {
    commitScript()
    write(LISTING, ['test/a.test.ts', 'test/b.test.ts', 'test/new.test.ts'])
    git('add', '.')
    git('commit', '-q', '-m', 'pr adds checker')
    expect(runStep().status).toBe(1)
  })
})
