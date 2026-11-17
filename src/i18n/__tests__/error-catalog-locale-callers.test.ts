import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 报错目录只收 ErrorDisplayLocale，文案语言传进去 tsc 就报错（见 error-display-locale.typecheck.ts）。
 * 类型挡不住的只剩手写断言和借用测试辅助，这里把生产代码里造出这个类型的地方限定为下面几处来源。
 */
const MINTS = {
  'electron/i18n.ts': 2,
  'src/i18n/app-errors.ts': 1,
  'src/i18n/core.ts': 1,
  'src/stores/locale-store.ts': 1,
}

const ROOT = join(__dirname, '..', '..', '..')
const MINT = /\bas ErrorDisplayLocale\b|shown-locale/gu

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'node_modules' ? [] : sourceFiles(path)
    return /\.tsx?$/u.test(entry.name) && !/\.(?:test|browser)\.tsx?$/u.test(entry.name) ? [path] : []
  })
}

describe('报错目录的界面语言', () => {
  it('生产代码只在界面语言的来源处造出 ErrorDisplayLocale，也不借用测试辅助', () => {
    const found: Record<string, number> = {}
    for (const file of [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'electron'))]) {
      const text = readFileSync(file, 'utf8')
      const count = (text.match(MINT) ?? []).length
      if (count) found[relative(ROOT, file).split(sep).join('/')] = count
    }
    expect(found).toEqual(MINTS)
  })

  it('跨行写的断言也算一处', () => {
    expect('const shown = value as\n    ErrorDisplayLocale'.match(MINT)).toHaveLength(1)
  })
})
