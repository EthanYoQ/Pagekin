import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'vitest'
import { BASELINE_FILE, checkTestDeterminism, findDeterminismHits } from '../check-test-determinism.mjs'

const script = fileURLToPath(new URL('../check-test-determinism.mjs', import.meta.url))
const roots = []

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-determinism-'))
  roots.push(root)
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const rulesOf = (source, fileName = 'a.test.ts') => findDeterminismHits(source, fileName).map(hit => `${hit.line}:${hit.rule}`)

test('墙钟差值和上限比较的各种写法都报出', () => {
  const source = [
    'const started = performance.now()',
    'expect(Date.now() - started).toBeLessThan(1_000)',
    'const elapsed = performance.now() - started',
    'expect(elapsed).toBeLessThan(OPEN_PROJECT_BUDGET_MS)',
    'const waitedSeconds = (performance.now() - started) / 1000',
    'expect(waitedSeconds).toBeLessThanOrEqual(5)',
    'const stopped = stop().then(() => (performance.now() - started) / 1000)',
    'expect(await stopped).toBeLessThan(5)',
    'assert.ok(Date.now() - started < 10_000, `用了 ${Date.now() - started} ms`)',
    'expect(elapsed).not.toBeGreaterThan(limit)',
    'expect(elapsed <= 2000).toBe(true)',
    'const t0 = process.hrtime.bigint()',
    'expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(200)',
    'expect(process.hrtime(t0)[0]).toBeLessThan(2)',
    'expect(2000 > elapsed).toBe(true)',
    'expect(elapsed)',
    '  .toBeLessThan(2000)',
  ].join('\n')
  assert.deepEqual(rulesOf(source), [2, 4, 6, 8, 9, 10, 11, 13, 14, 15, 16].map(line => `${line}:wall-clock-limit`))
})

test('截止时间轮询、时间戳先后、下限、条件分支和注释字符串里的写法都不报', () => {
  const source = [
    'for (const deadline = Date.now() + 10_000; !copying(); await tick()) {',
    '  expect(Date.now()).toBeLessThan(deadline)',
    '}',
    'const before = Date.now()',
    'expect(before).toBeLessThanOrEqual(record.createdAt)',
    'expect(record.createdAt).toBeLessThanOrEqual(Date.now())',
    'const elapsed = performance.now() - before',
    'expect(elapsed).toBeGreaterThanOrEqual(100)',
    'if (performance.now() - before < 140) expect(loadingShown()).toBe(false)',
    'expect(calls.indexOf("a")).toBeLessThan(calls.indexOf("b"))',
    'expect(end - start).toBeLessThanOrEqual(1200)',
    '// expect(Date.now() - before).toBeLessThan(1000)',
    "const text = 'expect(Date.now() - before).toBeLessThan(1000)'",
    'expect(clock.elapsed).toBeLessThanOrEqual(1000 + Date.now() - before)',
  ].join('\n')
  assert.deepEqual(rulesOf(source), [])
})

test('别的用例里同名的耗时变量、类型里的同名字段不算墙钟', () => {
  const source = [
    "it('a', () => { const elapsed = performance.now() - started })",
    "it('b', () => { const elapsed = rows.length; expect(elapsed).toBeLessThan(3) })",
    'const since = Date.now() - 5_000',
    'const clock = db.get() as { elapsed: number; since: number }',
    'expect(clock.elapsed).toBeLessThanOrEqual(1000)',
  ].join('\n')
  assert.deepEqual(rulesOf(source), [])
})

test('用到 fs.watch 回调文件名的写法报出，带 if (name) 判空也算', () => {
  const source = [
    "import fs from 'node:fs'",
    "import { watch as nodeWatch } from 'fs'",
    "import fsp from 'node:fs/promises'",
    "import { watch } from 'node:fs/promises'",
    'const a = fs.watch(inside, (_event, name) => { if (name) created.push(String(name)) })',
    'nodeWatch(dir, { recursive: true }, function (event, filename) { seen.add(filename) })',
    'const w = fs.watch(dir)',
    "w.on('change', (event, name) => seen.add(name))",
    "fs.watch(dir).on('rename', (event, name) => seen.add(name))",
    'for await (const { filename } of fsp.watch(dir)) seen.add(filename)',
    'for await (const event of watch(dir)) seen.add(event.filename)',
    'for await (const event of fs.promises.watch(dir)) seen.add(event.filename)',
  ].join('\n')
  assert.deepEqual(rulesOf(source), [5, 6, 8, 9, 10, 11, 12].map(line => `${line}:fs-watch-filename`))
})

test('不声明文件名参数的 fs.watch 与别的 watch 不报', () => {
  const source = [
    "import fs from 'node:fs'",
    "import { watch } from 'node:fs/promises'",
    'fs.watch(dir, () => { changed++ })',
    'fs.watch(dir, (event) => { changed++ })',
    "fs.watch(dir).on('change', () => { changed++ })",
    'for await (const event of watch(dir)) changed += event.eventType ? 1 : 0',
    "supervisor.watch('first', (id, controller) => controller.abort())",
  ].join('\n')
  assert.deepEqual(rulesOf(source), [])
  assert.deepEqual(rulesOf("function watch(a, b) {}\nwatch(dir, (event, name) => name)"), [])
})

test('布尔断言按期望真假与 not 判断方向，resolves 后的上限也算', () => {
  const source = [
    'const start = Date.now()',
    'expect(Date.now() - start > 50).toBe(false)',
    'expect(Date.now() - start < 50).not.toBe(true)',
    'expect(Date.now() - start < 50).toBeFalsy()',
    'expect(Date.now() - start > 50).toBe(true)',
    'const stopped = stop().then(() => Date.now() - start)',
    'expect(stopped).resolves.toBeLessThan(5000)',
    'assert.ok(!(Date.now() - start > 50))',
  ].join('\n')
  assert.deepEqual(rulesOf(source), [2, 7, 8].map(line => `${line}:wall-clock-limit`))
})

test('用了假时钟的墙钟上限断言也报', () => {
  const source = [
    "describe('fake', () => {",
    '  beforeEach(() => { vi.useFakeTimers() })',
    "  it('a', () => { const s = Date.now(); vi.advanceTimersByTime(50); expect(Date.now() - s).toBeLessThan(100) })",
    '})',
    "it('b', () => { vi.useFakeTimers(); const s = Date.now(); expect(Date.now() - s).toBeLessThan(100) })",
    "it('c', () => { const s = Date.now(); expect(Date.now() - s).toBeLessThan(100) })",
  ].join('\n')
  assert.deepEqual(rulesOf(source), [3, 5, 6].map(line => `${line}:wall-clock-limit`))
})

test('不同用例复用 watcher 这个名字时按各自声明判断', () => {
  const source = [
    "import fs from 'node:fs'",
    "import { watch } from 'node:fs/promises'",
    "it('a', () => { const watcher = fs.watch(dir); watcher.on('change', () => changed++) })",
    "it('b', () => { const watcher = new DomainWatcher(); watcher.on('change', (id, name) => seen.add(name)) })",
    "it('c', async () => { const watcher = watch(dir); for await (const e of watcher) changed++ })",
    "it('d', () => { const watcher = fs.watch(dir); watcher.on('change', (e, name) => seen.add(name)) })",
  ].join('\n')
  assert.deepEqual(rulesOf(source), ['6:fs-watch-filename'])
})

test('解构出的同名变量遮住外层耗时变量', () => {
  const source = [
    'const elapsed = performance.now() - started',
    'expect(elapsed).toBeLessThan(3)',
    "it('b', () => { const { elapsed } = row; expect(elapsed).toBeLessThan(3) })",
  ].join('\n')
  assert.deepEqual(rulesOf(source), ['2:wall-clock-limit'])
})

test('watch 回调声明了第二个参数就报，读不读、带不带下划线都一样；被参数遮住的 watch 不算 fs', () => {
  const source = [
    "import fs from 'node:fs'",
    "import { watch } from 'node:fs'",
    'fs.watch(dir, (_event, _filename) => seen.push(_filename))',
    'fs.watch(dir, (event, name) => { changed++ })',
    'fs.watch(dir, (_event, _name) => { changed++ })',
    'function probe(watch) { watch(dir, (event, name) => seen.add(name)) }',
    'watch(dir, (event, name) => seen.add(name))',
  ].join('\n')
  assert.deepEqual(rulesOf(source), [3, 4, 5, 7].map(line => `${line}:fs-watch-filename`))
})

const WALL_CLOCK = 'const s = Date.now()\nexpect(Date.now() - s).toBeLessThan(1000)\n'
const HIT = 'expect(Date.now() - s).toBeLessThan(1000)'

test('只扫测试文件：源码与 perf702 实机计时场景里的墙钟上限放行', () => {
  const root = fixture({
    'electron/services/__tests__/a.test.ts': WALL_CLOCK,
    'src/components/x/Probe.browser.tsx': WALL_CLOCK,
    'scripts/redesign/__tests__/drive.test.mjs': WALL_CLOCK,
    'test/helpers/wait.ts': WALL_CLOCK,
    'electron/services/clock.ts': WALL_CLOCK,
    'scripts/redesign/perf702-scenarios.mjs': WALL_CLOCK,
  })
  assert.deepEqual(checkTestDeterminism(root).violations.map(v => `${v.file}:${v.line}`).sort(), [
    'electron/services/__tests__/a.test.ts:2',
    'scripts/redesign/__tests__/drive.test.mjs:2',
    'src/components/x/Probe.browser.tsx:2',
    'test/helpers/wait.ts:2',
  ])
})

test('基线按文件、规则、命中文本计数放行，不看行号；同文多一处、换文件、基线多余都报', () => {
  const baseline = [{ file: 'electron/__tests__/a.test.ts', rule: 'wall-clock-limit', hit: HIT, count: 1 }]
  const moved = fixture({ 'electron/__tests__/a.test.ts': `\n\n\r\n${WALL_CLOCK.replace('expect(Date.now() - s)', 'expect(Date.now()  -  s)')}`, [BASELINE_FILE]: baseline })
  assert.deepEqual(checkTestDeterminism(moved), { violations: [], stale: [] })

  const copied = fixture({ 'electron/__tests__/a.test.ts': `${WALL_CLOCK}${HIT}\n`, [BASELINE_FILE]: baseline })
  assert.deepEqual(checkTestDeterminism(copied).violations.map(v => `${v.file}:${v.line}`), ['electron/__tests__/a.test.ts:3'])

  const renamed = fixture({ 'electron/__tests__/b.test.ts': WALL_CLOCK, [BASELINE_FILE]: baseline })
  assert.deepEqual(checkTestDeterminism(renamed), {
    violations: [{ file: 'electron/__tests__/b.test.ts', line: 2, rule: 'wall-clock-limit', hit: HIT }],
    stale: [{ file: 'electron/__tests__/a.test.ts', rule: 'wall-clock-limit', hit: HIT, count: 1 }],
  })
})

test('仓库当前状态通过检查；CLI 对基线外的命中退出 1 并给出改法', () => {
  const pass = spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true })
  assert.equal(pass.status, 0, pass.stderr)

  const root = fixture({ 'src/__tests__/fresh.test.ts': WALL_CLOCK })
  const fail = spawnSync(process.execPath, [script, root], { encoding: 'utf8', windowsHide: true })
  assert.equal(fail.status, 1)
  assert.match(fail.stderr, /src\/__tests__\/fresh\.test\.ts:2 墙钟上限断言/u)
})
