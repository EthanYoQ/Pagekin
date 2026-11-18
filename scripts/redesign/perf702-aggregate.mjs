// 把 PERF702_LOG 的逐操作记录按「章数-操作」聚合：中位数、范围、次数，外加主进程账本的中位数。
// 用法：node scripts/redesign/perf702-aggregate.mjs <timing.jsonl> [更多 jsonl]
import fs from 'node:fs'

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}
/** 操作的主读数：打开取最后一个标记（正文可交互），定稿章同时报正文与后处理卡片的差，模型操作取 toFirstRequestMs 与 totalMs。 */
function readings(record) {
  const { ms } = record
  if (Array.isArray(ms?.marks)) {
    const out = { ms: ms.marks.at(-1), maxFrameGapMs: ms.maxFrameGapMs }
    if (ms.marks.length > 1) Object.assign(out, { firstMarkMs: ms.marks[0], gapMs: ms.marks.at(-1) - ms.marks[0] })
    return out
  }
  return { ...ms }
}
const groups = new Map()
for (const file of process.argv.slice(2)) {
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
    const record = JSON.parse(line)
    if (record.label === 'discard') continue
    const key = record.label.replace(/-r\d+-/u, '-')
    const group = groups.get(key) ?? groups.set(key, []).get(key)
    group.push({ ...readings(record), ipcCalls: record.ipcCalls, spawns: record.spawns, sqlCalls: record.sqlCalls, sqlRows: record.sqlRows, sqlMs: record.sqlMs,
      mainMaxBlockMs: record.mainMaxBlockMs, longTaskMs: record.longTaskMs, ipcTop: Object.entries(record.ipc ?? {})[0] })
  }
}
for (const [key, runs] of [...groups].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))) {
  const fields = [...new Set(runs.flatMap(run => Object.keys(run).filter(field => typeof run[field] === 'number')))]
  const summary = fields.map(field => {
    const values = runs.map(run => run[field]).filter(value => typeof value === 'number')
    return `${field}=${median(values)}[${Math.min(...values)}–${Math.max(...values)}]`
  }).join(' ')
  const top = runs.map(run => run.ipcTop ? `${run.ipcTop[0]}:${run.ipcTop[1].ms}` : '').join(',')
  console.log(`${key} n=${runs.length} ${summary} | 最慢通道 ${top}`)
}
