import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, repoSourceFiles } from '../../../test/helpers/repo-source-files'

const sourceFiles = (directory: string) => repoSourceFiles(directory)
  .filter(file => !file.includes('/__tests__/') && /\.tsx?$/u.test(file) && !/\.(test|browser)\.tsx?$/u.test(file))

function literalsMentioning(file: string, word: string): string[] {
  const text = readFileSync(resolve(REPO_ROOT, file), 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const hits: string[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) && node.text.includes(word)) {
      hits.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

describe('1.3.0 删除了侧栏的「草稿箱」（#663）', () => {
  it('界面文案不再提草稿箱，作者照着找不到它', () => {
    const hits = ['src', 'electron'].flatMap(dir => sourceFiles(dir)).flatMap(file => literalsMentioning(file, '草稿箱'))
    expect(hits).toEqual([])
  })
})
