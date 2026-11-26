#!/usr/bin/env node
// 名单只减不增：对比基准提交上的同一文件；拿不到基准提交就失败，不放行。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const listAdditions = (current, previous) => current.filter(entry => !previous.includes(entry))

// 每个文件的旧约定按合计比较，种类互换不算新增；authorOwned 是新约定，不计入。
const legacySum = counts => Object.entries(counts ?? {}).reduce((sum, [kind, n]) => kind === 'authorOwned' ? sum : sum + n, 0)
const countAdditions = (current, previous) => Object.entries(current)
  .filter(([path, counts]) => legacySum(counts) > legacySum(previous[path]))
  .map(([path, counts]) => `${path} 的旧约定合计（${legacySum(previous[path])} → ${legacySum(counts)}）`)

const BASELINES = {
  'electron/ipc/direct-channels.json': listAdditions,
  'test/directory-listing-baseline.json': listAdditions,
  'test/legacy-failure-baseline.json': countAdditions,
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const base = process.argv[2] ?? 'origin/master'
try {
  git('rev-parse', '--verify', '--quiet', `${base}^{commit}`)
} catch {
  console.error(`拿不到基准提交 ${base}。CI 里要先取到它（检出时 fetch-depth: 2 并传 HEAD^1），本地先 git fetch origin master。`)
  process.exit(2)
}

let added = 0
for (const [file, additionsOf] of Object.entries(BASELINES)) {
  try {
    git('cat-file', '-e', `${base}:${file}`)
  } catch {
    console.log(`${file}：基准 ${base} 上没有这个文件，当作新建的名单。`)
    continue
  }
  if (!existsSync(file)) {
    console.error(`${file} 在基准上有、当前分支没有：名单不能改名或删掉绕过比较。`)
    added++
    continue
  }
  const current = JSON.parse(readFileSync(file, 'utf8'))
  const previous = JSON.parse(git('show', `${base}:${file}`))
  const additions = additionsOf(current, previous)
  added += additions.length
  for (const entry of additions) console.error(`${file} 新增了 ${entry}：名单只减不增，新代码改用规定的入口，不进名单。`)
}
process.exit(added === 0 ? 0 : 1)
