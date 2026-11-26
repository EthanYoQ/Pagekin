#!/usr/bin/env node
// 存量名单只减不增：当前分支的名单与基准提交（默认 origin/master，PR CI 传合并提交的 HEAD^1）上的同一文件比较。
// 基准提交拿不到就失败，不放行；基准上还没有这个文件的，当作本次新建的名单。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const BASELINE_FILES = ['electron/ipc/direct-channels.json', 'test/directory-listing-baseline.json']

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const base = process.argv[2] ?? 'origin/master'
try {
  git('rev-parse', '--verify', '--quiet', `${base}^{commit}`)
} catch {
  console.error(`拿不到基准提交 ${base}。CI 里要先取到它（检出时 fetch-depth: 2 并传 HEAD^1），本地先 git fetch origin master。`)
  process.exit(2)
}

let added = 0
for (const file of BASELINE_FILES) {
  const current = JSON.parse(readFileSync(file, 'utf8'))
  try {
    git('cat-file', '-e', `${base}:${file}`)
  } catch {
    console.log(`${file}：基准 ${base} 上没有这个文件，当作新建的名单。`)
    continue
  }
  const previous = JSON.parse(git('show', `${base}:${file}`))
  const additions = current.filter(entry => !previous.includes(entry))
  added += additions.length
  for (const entry of additions) console.error(`${file} 新增了 ${entry}：名单只减不增，新代码改用规定的入口，不进名单。`)
}
process.exit(added === 0 ? 0 : 1)
