import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GUARD_TESTS, NOT_GUARD_TESTS } from './guards'

const ROOT = join(__dirname, '..')
const SCANNED_ROOTS = ['electron', 'scripts', 'src', 'test']
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u
const LISTS_DIRECTORY = /\b(?:readdirSync|readdir|globSync)\(/u
const FILTERS_SOURCE = /endsWith\(\s*['"`]\.(?:tsx?|mjs|cjs)['"`]\s*\)|\\\.\(?(?:\?:)?(?:\w+\??\|)*(?:tsx?\??|mjs|cjs)\b/u

const scansSource = (text: string) => LISTS_DIRECTORY.test(text) && FILTERS_SOURCE.test(text)

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(path)
    return TEST_FILE.test(entry.name) ? [relative(ROOT, path).split(sep).join('/')] : []
  })
}

const scanning = SCANNED_ROOTS.flatMap(dir => testFiles(join(ROOT, dir)))
  .filter(file => scansSource(readFileSync(join(ROOT, file), 'utf8')))
  .sort()
const exempt = new Set(NOT_GUARD_TESTS.map(entry => entry.file))

describe('守卫测试登记表', () => {
  it('扫源码的测试正好是登记表里 kind 为 scan 的那些', () => {
    const registered = GUARD_TESTS.filter(entry => entry.kind === 'scan').map(entry => entry.file).sort()
    expect(scanning.filter(file => !exempt.has(file)), '新增或移除了扫源码的测试，同步改 test/guards.ts').toEqual(registered)
  })

  it('登记的文件都在，豁免项仍会被扫中', () => {
    expect(GUARD_TESTS.filter(entry => !existsSync(join(ROOT, entry.file))).map(entry => entry.file)).toEqual([])
    expect(NOT_GUARD_TESTS.filter(entry => !scanning.includes(entry.file)).map(entry => entry.file)).toEqual([])
  })

  it('认得出遍历源码目录的写法，不把遍历临时目录当成守卫', () => {
    expect(scansSource("readdirSync(dir).filter(name => name.endsWith('.ts'))")).toBe(true)
    expect(scansSource('readdirSync(dir).filter(name => /\\.(?:tsx?|mjs)$/u.test(name))')).toBe(true)
    expect(scansSource("readdirSync(dir).filter(name => name.endsWith('.css'))")).toBe(true)
    expect(scansSource('readdirSync(dir).filter(name => /\\.css$/u.test(name))')).toBe(true)
    expect(scansSource("readdirSync('scripts').filter(name => name.endsWith('.ps1'))")).toBe(true)
    expect(scansSource("readdirSync(dir).filter(name => name.endsWith('.jsx'))")).toBe(true)
    expect(scansSource("readdirSync(tmp).filter(name => name.startsWith('.pe-'))")).toBe(false)
    expect(scansSource("readFileSync('src/a.ts', 'utf8')")).toBe(false)
  })
})
