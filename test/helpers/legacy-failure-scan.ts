import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { REPO_ROOT, repoSourceFiles } from './repo-source-files.ts'

export const LEGACY_FAILURE_CALLS = ['displayedErrorMessage', 'appErrorMessage', 'knownAppErrorMessage', 'authorOwned'] as const
export type LegacyFailureKind = typeof LEGACY_FAILURE_CALLS[number]

/** 已删掉的旧失败约定（#845 PR-H2）：生产代码里再出现这些名字即红。 */
export const REMOVED_FAILURE_NAMES = ['englishWithReason', 'LegacyReason', 'legacyReasonText', 'unregisteredCodeMessage', 'WIRE_EXCLUDED_KEYS', 'DIRECT_CHANNELS'] as const
/** 已删掉的目录键与名单文件：字符串里再出现即红。 */
export const REMOVED_FAILURE_STRINGS = ['error.unknown', 'direct-channels'] as const
export type LegacyFailureCounts = Record<string, Partial<Record<LegacyFailureKind, number>>>

const NOT_PRODUCTION = /\/__tests__\/|\.(?:test|spec|browser|typecheck)\.[cm]?[jt]sx?$|^src\/stories\//u
const RAW_PROPERTIES = new Set(['message', 'stack', 'toString'])
const FAILURE_TYPES = /\b(?:AuthorNote|AuthorOwned|Failure|NoteParams)\b/u
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
  })
  return counts
}

/** 旧失败约定的入口：删掉的名字、目录键、名单文件，以及只装原文的 { legacy } 对象。 */
export function removedFailureEntries(file: string, text: string): string[] {
  const found: string[] = []
  walk(file, text, (node, source) => {
    const hit = ts.isIdentifier(node) && (REMOVED_FAILURE_NAMES as readonly string[]).includes(node.text)
      || ts.isStringLiteralLike(node) && REMOVED_FAILURE_STRINGS.some(removed => node.text.includes(removed))
      || isLegacyReason(node)
    if (hit) found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${node.getText(source)}`)
  })
  return found
}

const propertyName = (name: ts.PropertyName) => ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined

const isLegacyKey = (property: ts.ObjectLiteralElementLike) =>
  (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && propertyName(property.name) === 'legacy'

/** 带 legacy 键的对象字面量写在哪都算；只豁免还带别的具名键的对照表（如来源标签表）。 */
const isLegacyReason = (node: ts.Node) => ts.isObjectLiteralExpression(node) && node.properties.some(isLegacyKey)
  && node.properties.every(property => isLegacyKey(property) || ts.isSpreadAssignment(property))

export const legacySum = (counts: Partial<Record<LegacyFailureKind, number>>) =>
  Object.entries(counts).reduce((sum, [kind, n]) => kind === 'authorOwned' ? sum : sum + (n ?? 0), 0)

function readsRawText(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'String') return true
  if (ts.isPropertyAccessExpression(node) && RAW_PROPERTIES.has(node.name.text)) return true
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && RAW_PROPERTIES.has(node.argumentExpression.text)) return true
  if (ts.isTemplateSpan(node) && carriesCaughtValue(node.expression)) return true
  return ts.forEachChild(node, readsRawText) ?? false
}

/** 去掉不改变值的包装：括号、类型断言、非空断言、satisfies，逗号表达式取最后一项。 */
function unwrap(expression: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
      || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression
    else if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) expression = expression.right
    else return expression
  }
}

const VALUE_JOINS = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken])

/** 表达式的值里是否原样带着 catch 变量：它本身、+ 拼接、?? || && 与条件表达式的分支。 */
function carriesCaughtValue(expression: ts.Expression): boolean {
  const value = unwrap(expression)
  if (ts.isConditionalExpression(value)) return carriesCaughtValue(value.whenTrue) || carriesCaughtValue(value.whenFalse)
  if (ts.isBinaryExpression(value) && VALUE_JOINS.has(value.operatorToken.kind)) return carriesCaughtValue(value.left) || carriesCaughtValue(value.right)
  return isCaughtValue(value)
}

const bindsName = (binding: ts.BindingName, name: string): boolean => ts.isIdentifier(binding) ? binding.text === name
  : binding.elements.some(element => !ts.isOmittedExpression(element) && bindsName(element.name, name))

function isCaughtValue(expression: ts.Expression): boolean {
  if (!ts.isIdentifier(expression)) return false
  const name = expression.text
  for (let scope: ts.Node | undefined = expression.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some(parameter => bindsName(parameter.name, name))) return false
    const caught = ts.isCatchClause(scope) ? scope.variableDeclaration?.name : undefined
    if (caught && ts.isIdentifier(caught) && caught.text === name) return true
  }
  return false
}

/** 参数原样进作者看到的说明的调用：作者数据，或本应用写好的整句。 */
const OWNED_TEXT_CALLS = new Set(['authorOwned', 'writtenNote'])

export function rawTextInNoteArguments(file: string, text: string): string[] {
  const found: string[] = []
  walk(file, text, (node, source) => {
    if (ts.isCallExpression(node) && OWNED_TEXT_CALLS.has(calleeName(node) ?? '') && node.arguments.some(argument => carriesCaughtValue(argument) || readsRawText(argument))) {
      found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${node.getText(source)}`)
    }
  })
  return found
}

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

const REWRITTEN_FIELDS = new Set(['code', 'errorCode', 'message'])
const fieldName = (name: ts.Node | undefined) => name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined

/** 造完错误之后再改 code、errorCode 或 message 的写法（this 除外）。 */
export function failureRewrites(file: string, text: string): string[] {
  if (!file.startsWith('src/')) return []
  const found: string[] = []
  walk(file, text, (node, source) => {
    const assign = ts.isCallExpression(node) && node.expression.getText(source) === 'Object.assign' && node.arguments.slice(1).some(arg =>
      ts.isObjectLiteralExpression(arg) && arg.properties.some(property => REWRITTEN_FIELDS.has(fieldName(property.name) ?? '')))
    const target = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? unwrap(node.left) : undefined
    const written = target && (ts.isPropertyAccessExpression(target) ? target.name.text
      : ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression) ? target.argumentExpression.text : undefined)
    const write = !!written && REWRITTEN_FIELDS.has(written)
      && (target as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression.kind !== ts.SyntaxKind.ThisKeyword
    if (assign || write) found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${node.getText(source)}`)
  })
  return found
}
