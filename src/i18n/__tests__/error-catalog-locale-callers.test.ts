import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, repoSourceFiles } from '../../../test/helpers/repo-source-files'

const MINTS = {
  'electron/i18n.ts': 2,
  'src/i18n/app-errors.ts': 1,
  'src/i18n/core.ts': 1,
  'src/stores/locale-store.ts': 1,
}

const MINT = /\bas\s+ErrorDisplayLocale\b|shown-locale/gu

const sourceFiles = () => ['src', 'electron'].flatMap(dir => repoSourceFiles(dir))
  .filter(file => !file.includes('/__tests__/') && /\.tsx?$/u.test(file) && !/\.(?:test|browser)\.tsx?$/u.test(file))

describe('报错目录的界面语言', () => {
  it('生产代码只在界面语言的来源处造出 ErrorDisplayLocale，也不借用测试辅助', () => {
    const found: Record<string, number> = {}
    for (const file of sourceFiles()) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8')
      const count = (text.match(MINT) ?? []).length
      if (count) found[file] = count
    }
    expect(found).toEqual(MINTS)
  })

  it('跨行写的断言也算一处', () => {
    expect('const shown = value as\n    ErrorDisplayLocale'.match(MINT)).toHaveLength(1)
  })
})
