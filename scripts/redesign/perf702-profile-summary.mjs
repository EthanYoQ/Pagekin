// 把 .cpuprofile 归约成按函数的自耗时与含子调用耗时表，供 #702 诊断比较 10、50、112 章。
// 用法：node scripts/redesign/perf702-profile-summary.mjs <a.cpuprofile> [更多文件] [--top 25]
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const topIndex = args.indexOf('--top')
const top = topIndex >= 0 ? Number(args.splice(topIndex, 2)[1]) : 25

function summarize(file) {
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'))
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const parent = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const self = new Map()
  const total = new Map()
  const key = node => {
    const { functionName, url, lineNumber, columnNumber } = node.callFrame
    return `${functionName || '(anonymous)'} ${url ? `${path.basename(url)}:${lineNumber + 1}:${columnNumber + 1}` : ''}`.trim()
  }
  const deltas = profile.timeDeltas
  let sampled = 0
  let idle = 0
  profile.samples.forEach((id, index) => {
    const ms = (deltas[index + 1] ?? 0) / 1000
    sampled += ms
    const leaf = nodes.get(id)
    const leafKey = key(leaf)
    if (leaf.callFrame.functionName === '(idle)') idle += ms
    self.set(leafKey, (self.get(leafKey) ?? 0) + ms)
    const seen = new Set()
    for (let current = id; current !== undefined; current = parent.get(current)) {
      const name = key(nodes.get(current))
      if (seen.has(name)) continue
      seen.add(name)
      total.set(name, (total.get(name) ?? 0) + ms)
    }
  })
  const rank = map => [...map].sort(([, a], [, b]) => b - a).slice(0, top).map(([name, ms]) => `${ms.toFixed(1).padStart(9)} ms  ${name}`)
  return [`== ${path.basename(file)}  墙钟 ${((profile.endTime - profile.startTime) / 1000).toFixed(0)} ms，采样 ${sampled.toFixed(0)} ms，空闲 ${idle.toFixed(0)} ms，忙 ${(sampled - idle).toFixed(0)} ms`,
    '-- 自耗时', ...rank(self), '-- 含子调用', ...rank(new Map([...total].filter(([name]) => !/^\((root|program|idle)\)/u.test(name))))].join('\n')
}

for (const file of args) console.log(summarize(file))
