import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

function sourceFiles(directory: string): string[] {
  return readdirSync(resolve(ROOT, directory), { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path)
    return /\.tsx?$/u.test(entry.name) && !/\.(test|browser)\.tsx?$/u.test(entry.name) ? [path] : []
  })
}

function literalsMentioning(file: string, word: string): string[] {
  const text = readFileSync(resolve(ROOT, file), 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const hits: string[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) && node.text.includes(word)) {
      hits.push(`${relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

describe('1.3.0 删除了侧栏的「草稿箱」（#663）', () => {
  it('界面文案不再提草稿箱，作者照着找不到它', () => {
    const hits = ['src', 'electron'].flatMap(sourceFiles).flatMap(file => literalsMentioning(file, '草稿箱'))
    expect(hits).toEqual([])
  })
})
