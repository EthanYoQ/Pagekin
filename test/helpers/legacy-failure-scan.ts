import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { REPO_ROOT, repoSourceFiles } from './repo-source-files.ts'

export const LEGACY_FAILURE_CALLS = ['displayedErrorMessage', 'appErrorMessage', 'knownAppErrorMessage', 'englishWithReason', 'authorOwned'] as const
export type LegacyFailureKind = typeof LEGACY_FAILURE_CALLS[number] | '{ legacy:'
export type LegacyFailureCounts = Record<string, Partial<Record<LegacyFailureKind, number>>>

const NOT_PRODUCTION = /\/__tests__\/|\.(?:test|spec|browser|typecheck)\.[cm]?[jt]sx?$|^src\/stories\//u
const RAW_TEXT = /\.message\b|String\(|\.stack\b/u
const FAILURE_TYPES = /\b(?:AuthorNote|Failure)\b/u
const FAILURE_MODULE = 'src/shared/failure.ts'

export function productionSourceFiles(): string[] {
  return ['src', 'electron'].flatMap(dir => repoSourceFiles(dir)).filter(file => /\.tsx?$/u.test(file) && !NOT_PRODUCTION.test(file))
}

function walk(file: string, text: string, visit: (node: ts.Node, source: ts.SourceFile) => void): void {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const go = (node: ts.Node) => { visit(node, source); ts.forEachChild(node, go) }
  go(source)
}

const calleeName = (node: ts.CallExpression) => ts.isIdentifier(node.expression) ? node.expression.text
  : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined

export function legacyFailureCounts(file: string, text: string): Partial<Record<LegacyFailureKind, number>> {
  const counts: Partial<Record<LegacyFailureKind, number>> = {}
  const add = (kind: LegacyFailureKind) => { counts[kind] = (counts[kind] ?? 0) + 1 }
  walk(file, text, node => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      if ((LEGACY_FAILURE_CALLS as readonly string[]).includes(name ?? '')) add(name as LegacyFailureKind)
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'legacy' && ts.isObjectLiteralExpression(node.parent)) add('{ legacy:')
  })
  return counts
}

export function rawAuthorOwnedArguments(file: string, text: string): string[] {
  const found: string[] = []
  walk(file, text, (node, source) => {
    if (ts.isCallExpression(node) && calleeName(node) === 'authorOwned' && node.arguments.some(arg => RAW_TEXT.test(arg.getText(source)))) {
      found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${node.getText(source)}`)
    }
  })
  return found
}

/** 只有 src/shared/failure.ts 可以断言成这些类型。 */
export function failureTypeAssertions(file: string, text: string): string[] {
  if (file === FAILURE_MODULE) return []
  const found: string[] = []
  walk(file, text, (node, source) => {
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && FAILURE_TYPES.test(node.type.getText(source))) {
      found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${node.getText(source)}`)
    }
  })
  return found
}

export function scanProduction<T>(scan: (file: string, text: string) => T): Array<[string, T]> {
  return productionSourceFiles().map(file => [file, scan(file, readFileSync(join(REPO_ROOT, file), 'utf8'))])
}

export function currentLegacyFailureCounts(): LegacyFailureCounts {
  return Object.fromEntries(scanProduction(legacyFailureCounts).filter(([, counts]) => Object.keys(counts).length > 0)
    .map(([file, counts]) => [file, Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))]))
}
