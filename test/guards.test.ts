import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { guardTestFiles, reachesRepoSourceFiles, REPO_SOURCE_FILES_MODULE } from './guards'
import { repoSourceFiles } from './helpers/repo-source-files'

function withFixture(files: Record<string, string>, check: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'guards-'))
  try {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), text)
    }
    check(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('repoSourceFiles()', () => {
  it('递归列出仓库目录下的文件，返回排好序、以 / 分隔的仓库相对路径', () => {
    const files = repoSourceFiles('test')
    expect(files).toContain(REPO_SOURCE_FILES_MODULE)
    expect(files).toContain('test/helpers/__tests__/review-cycle-fixture.test.ts')
    expect(files).toEqual([...files].sort())
    expect(files.filter(file => file.includes('\\') || !file.startsWith('test/'))).toEqual([])
  })
})

describe('test:guards 的成员是经 repoSourceFiles() 扫源码的测试', () => {
  const helper = 'export function repoSourceFiles() { return [] }\n'

  it('直接 import、经 test/ 下的辅助模块 import、动态 import 都算；没走到它的不算', () => {
    withFixture({
      [REPO_SOURCE_FILES_MODULE]: helper,
      'test/helpers/scan.ts': "export { repoSourceFiles as list } from './repo-source-files'\n",
      'src/__tests__/direct.test.ts': "import { repoSourceFiles } from '../../test/helpers/repo-source-files'\n",
      'src/__tests__/via-helper.test.ts': "import { list } from '../../test/helpers/scan'\n",
      'scripts/__tests__/dynamic.test.mjs': "const { repoSourceFiles } = await import('../../test/helpers/repo-source-files.ts')\n",
      'src/__tests__/unrelated.test.ts': "import { readFileSync } from 'node:fs'\nimport { x } from '../x'\n",
      'src/x.ts': "export { repoSourceFiles as x } from '../test/helpers/repo-source-files'\n",
    }, root => {
      const member = (file: string) => reachesRepoSourceFiles(root, file)
      expect(['src/__tests__/direct.test.ts', 'src/__tests__/via-helper.test.ts', 'scripts/__tests__/dynamic.test.mjs'].filter(member)).toHaveLength(3)
      expect(member('src/__tests__/unrelated.test.ts')).toBe(false)
    })
  })

  it('仓库里扫源码的测试都在成员里，只读固定文件或只用临时目录的不在', () => {
    const members = guardTestFiles()
    expect(members).toEqual(expect.arrayContaining([
      'test/guards.test.ts',
      'electron/controllers/__tests__/external-file-grant-controller.test.ts',
      'scripts/redesign/__tests__/issue-scenarios-docs.test.mjs',
      'src/shared/__tests__/review-proof.test.ts',
    ]))
    expect(members).not.toContain('electron/controllers/__tests__/import-controller-secure-file.test.ts')
  })
})
