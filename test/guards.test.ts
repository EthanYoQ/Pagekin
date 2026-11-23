import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GUARD_TESTS, NOT_GUARD_TESTS } from './guards'

const ROOT = join(__dirname, '..')
const SCANNED_ROOTS = ['electron', 'scripts', 'src', 'test']
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u
const LISTS_DIRECTORY = /\b(?:readdirSync|readdir|globSync)\(/u
const SOURCE_EXTENSION = String.raw`(?:tsx?\??|mjs|cjs|css|ps1|sh)`
const FILTERS_SOURCE = new RegExp(String.raw`endsWith\(\s*['"${'`'}]\.${SOURCE_EXTENSION}['"${'`'}]\s*\)|\\\.\(?(?:\?:)?(?:\w+\??\|)*${SOURCE_EXTENSION}\b`, 'u')

const scansSource = (text: string) => LISTS_DIRECTORY.test(text) && FILTERS_SOURCE.test(text)

function testFiles(root: string, dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(root, path)
    return TEST_FILE.test(entry.name) ? [relative(root, path).split(sep).join('/')] : []
  })
}

const scanningTests = (root: string) => SCANNED_ROOTS.filter(dir => existsSync(join(root, dir)))
  .flatMap(dir => testFiles(root, join(root, dir)))
  .filter(file => scansSource(readFileSync(join(root, file), 'utf8')))
  .sort()
const scanning = scanningTests(ROOT)
const exempt = new Set(NOT_GUARD_TESTS.map(entry => entry.file))

function inventoryDrift(root: string, registered: readonly string[]) {
  const scanned = scanningTests(root).filter(file => !exempt.has(file))
  return { unregistered: scanned.filter(file => !registered.includes(file)), stale: registered.filter(file => !scanned.includes(file)) }
}

describe('守卫测试登记表', () => {
  it('扫源码的测试正好是登记表里 kind 为 scan 的那些', () => {
    const registered = GUARD_TESTS.filter(entry => entry.kind === 'scan').map(entry => entry.file).sort()
    expect(inventoryDrift(ROOT, registered), '新增或移除了扫源码的测试，同步改 test/guards.ts').toEqual({ unregistered: [], stale: [] })
  })

  it('登记的文件都在，豁免项仍会被扫中', () => {
    expect(GUARD_TESTS.filter(entry => !existsSync(join(ROOT, entry.file))).map(entry => entry.file)).toEqual([])
    expect(NOT_GUARD_TESTS.filter(entry => !scanning.includes(entry.file)).map(entry => entry.file)).toEqual([])
  })

  it('凡列目录的测试都是候选，与怎样按扩展名过滤无关；只按固定路径读文件的不算', () => {
    for (const text of [
      "readdirSync(dir).filter(name => name.endsWith('.ts'))",
      'readdirSync(dir).filter(name => /\\.(?:tsx?|mjs)$/u.test(name))',
      "readdirSync(dir).filter(name => path.extname(name) === '.css')",
      "readdirSync(dir).filter(name => name.endsWith('.css'))",
      "readdirSync(join(ROOT, 'src'), { recursive: true })",
      "await readdir(dir)",
      "for await (const entry of await opendir(dir)) {}",
      "globSync('src/**/*.css')",
    ]) expect(scansSource(text), text).toBe(true)
    expect(scansSource("readFileSync('src/styles/app.css', 'utf8')")).toBe(false)
    expect(scansSource("readFileSync(join(ROOT, 'src/a.ts'), 'utf8'); existsSync('src')")).toBe(false)
  })

  it('只过滤 .css 的守卫未登记时核对失败，登记后通过；按固定路径读 css 的不算', () => {
    const root = mkdtempSync(join(tmpdir(), 'guards-css-'))
    try {
      mkdirSync(join(root, 'src', '__tests__'), { recursive: true })
      writeFileSync(join(root, 'src/__tests__/styles.test.ts'), "readdirSync('src/styles').filter(name => path.extname(name) === '.css')")
      writeFileSync(join(root, 'src/__tests__/fixed.test.ts'), "readFileSync('src/styles/app.css', 'utf8')")
      expect(inventoryDrift(root, [])).toEqual({ unregistered: ['src/__tests__/styles.test.ts'], stale: [] })
      expect(inventoryDrift(root, ['src/__tests__/styles.test.ts'])).toEqual({ unregistered: [], stale: [] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
