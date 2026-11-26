import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const BASELINE_FILE = 'scripts/test-determinism-baseline.json'
const SCAN_ROOTS = ['electron', 'scripts', 'src', 'test']
const SCRIPT_KINDS = { '.ts': ts.ScriptKind.TS, '.mts': ts.ScriptKind.TS, '.cts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX, '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS }
const MAY_HIT = /Date\.now|performance\.now|hrtime|\bwatch\b/u

const RULES = {
  'wall-clock-limit': '墙钟上限断言：慢机上会误报。等条件本身成立（轮询加截止时间）；测速度放进 scripts/redesign 的 perf702 实机计时场景',
  'fs-watch-filename': 'fs.watch 回调声明了文件名参数：macOS 上可能为 null。不用文件名就别声明第二个参数；要知道哪个文件变了，比对目录前后快照，或只把事件当作有变化的信号再去读目录',
}

const isTestFile = relative => relative.startsWith('test/') || relative.split('/').includes('__tests__')
  || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(relative) || relative.endsWith('.browser.tsx')

const normalize = text => text.replace(/\s+/gu, ' ').trim()

function clockCall(node) {
  if (!ts.isCallExpression(node)) return null
  const callee = node.expression.getText()
  if (callee === 'Date.now' || callee === 'performance.now' || callee === 'process.hrtime.bigint') return 'stamp'
  if (callee === 'process.hrtime') return node.arguments.length > 0 ? 'elapsed' : 'stamp'
  return null
}

function some(node, predicate) {
  if (predicate(node)) return true
  return ts.forEachChild(node, child => (!ts.isTypeNode(child) && some(child, predicate)) || undefined) === true
}

function scopeDeclarations(scope) {
  const declarations = new Map()
  const addName = (name, declaration) => {
    if (ts.isIdentifier(name)) declarations.set(name.text, declaration)
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) addName(element.name, element)
  }
  const add = list => { for (const d of list) addName(d.name, d) }
  for (const statement of scope.statements ?? []) if (ts.isVariableStatement(statement)) add(statement.declarationList.declarations)
  if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) add(scope.initializer.declarations)
  if (ts.isFunctionLike(scope)) add(scope.parameters)
  return declarations
}

function declarationResolver() {
  const cache = new Map()
  return identifier => {
    for (let scope = identifier.parent; scope; scope = scope.parent) {
      if (!cache.has(scope)) cache.set(scope, scopeDeclarations(scope))
      const declaration = cache.get(scope).get(identifier.text)
      if (declaration) return declaration
    }
    return undefined
  }
}

function wallClockHits(sf) {
  const resolve = declarationResolver()
  const stamps = new Set()
  const elapsed = new Set()
  const isKey = n => n.parent.name === n && !ts.isShorthandPropertyAssignment(n.parent)
  const refersTo = (n, declarations) => ts.isIdentifier(n) && !isKey(n) && declarations.has(resolve(n))
  const timed = node => some(node, n => clockCall(n) !== null || refersTo(n, stamps))
  const isElapsed = node => some(node, n => clockCall(n) === 'elapsed'
    || refersTo(n, elapsed)
    || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.MinusToken && (timed(n.left) || timed(n.right))
      && !ts.isNumericLiteral(n.left) && !ts.isNumericLiteral(n.right)))

  const bindings = []
  const collect = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bindings.push([node, node.initializer])
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      const declaration = resolve(node.left)
      if (declaration) bindings.push([declaration, node.right])
    }
    ts.forEachChild(node, collect)
  }
  collect(sf)
  for (let changed = true; changed;) {
    changed = false
    for (const [declaration, value] of bindings) {
      const target = isElapsed(value) ? elapsed : some(value, n => clockCall(n) !== null) ? stamps : null
      if (target && !target.has(declaration)) { target.add(declaration); changed = true }
    }
  }

  const boundsAbove = (node, assertedTrue) => {
    while (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) node = node.expression
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return boundsAbove(node.operand, !assertedTrue)
    if (!ts.isBinaryExpression(node)) return false
    const op = node.operatorToken.kind
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return assertedTrue && (boundsAbove(node.left, true) || boundsAbove(node.right, true))
    const less = op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken
    if (!less && op !== ts.SyntaxKind.GreaterThanToken && op !== ts.SyntaxKind.GreaterThanEqualsToken) return false
    return isElapsed(less === assertedTrue ? node.left : node.right)
  }

  const expectedTruth = (matcher, argument) => {
    if (matcher === 'toBeTruthy') return true
    if (matcher === 'toBeFalsy') return false
    if (!['toBe', 'toEqual', 'toStrictEqual'].includes(matcher) || !argument) return null
    return argument.kind === ts.SyntaxKind.TrueKeyword ? true : argument.kind === ts.SyntaxKind.FalseKeyword ? false : null
  }

  const assertsUpperBound = (measured, modifiers, call) => {
    const negated = modifiers[0] === 'not'
    const matcher = modifiers.slice(negated ? 1 : 0).join('.')
    if (['toBeLessThan', 'toBeLessThanOrEqual'].includes(matcher)) return !negated && isElapsed(measured)
    if (['toBeGreaterThan', 'toBeGreaterThanOrEqual'].includes(matcher)) return negated && isElapsed(measured)
    const truth = expectedTruth(matcher, call.arguments[0])
    return truth !== null && boundsAbove(measured, truth !== negated)
  }

  const hits = []
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const chain = []
      let target = node.expression
      while (ts.isPropertyAccessExpression(target)) { chain.unshift(target.name.text); target = target.expression }
      if (ts.isCallExpression(target) && ['expect', 'expect.soft'].includes(target.expression.getText()) && target.arguments[0]
        && assertsUpperBound(target.arguments[0], chain.filter(part => part !== 'resolves'), node)) {
        hits.push(node)
        return
      }
    }
    if (ts.isCallExpression(node) && ['assert', 'assert.ok'].includes(node.expression.getText()) && node.arguments[0]
      && boundsAbove(node.arguments[0], true)) {
      hits.push(node)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits.map(node => ({ rule: 'wall-clock-limit', node, hit: normalize(node.getText()) }))
}

function fsBindings(sf) {
  const fsModules = new Set()
  const promiseModules = new Set()
  const callbackWatch = new Set()
  const promiseWatch = new Set()
  const bind = (moduleName, clause) => {
    const isFs = /^(?:node:)?fs$/u.test(moduleName)
    const isPromises = /^(?:node:)?fs\/promises$/u.test(moduleName)
    if (!isFs && !isPromises) return
    if (clause.name) (isFs ? fsModules : promiseModules).add(clause.name.text)
    const named = clause.namedBindings
    if (named && ts.isNamespaceImport(named)) (isFs ? fsModules : promiseModules).add(named.name.text)
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        const imported = (element.propertyName ?? element.name).text
        if (imported === 'watch') (isFs ? callbackWatch : promiseWatch).add(element.name.text)
        if (imported === 'promises' && isFs) promiseModules.add(element.name.text)
      }
    }
  }
  const visit = node => {
    if (ts.isImportDeclaration(node) && node.importClause && ts.isStringLiteral(node.moduleSpecifier)) bind(node.moduleSpecifier.text, node.importClause)
    const required = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText() === 'require' ? node.initializer.arguments[0] : undefined
    if (required && ts.isStringLiteral(required)) bind(required.text, { name: node.name })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { fsModules, promiseModules, callbackWatch, promiseWatch }
}

const isRequire = declaration => declaration?.initializer && ts.isCallExpression(declaration.initializer) && declaration.initializer.expression.getText() === 'require'

function watchKind(call, bindings, resolve) {
  if (!ts.isCallExpression(call)) return null
  const callee = call.expression
  let root = callee
  while (ts.isPropertyAccessExpression(root)) root = root.expression
  const declaration = ts.isIdentifier(root) ? resolve(root) : null
  if (declaration && !isRequire(declaration)) return null
  if (ts.isIdentifier(callee)) return bindings.callbackWatch.has(callee.text) ? 'callback' : bindings.promiseWatch.has(callee.text) ? 'promise' : null
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'watch') return null
  const owner = callee.expression.getText()
  if (bindings.fsModules.has(owner)) return 'callback'
  if (bindings.promiseModules.has(owner) || [...bindings.fsModules].some(name => owner === `${name}.promises`)) return 'promise'
  return null
}

const declaresFileName = fn => (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parameters.length >= 2

function watchFileNameHits(sf) {
  const bindings = fsBindings(sf)
  const resolve = declarationResolver()
  const kindOf = expression => {
    const direct = watchKind(expression, bindings, resolve)
    if (direct || !ts.isIdentifier(expression)) return direct
    const declaration = resolve(expression)
    return declaration?.initializer ? watchKind(declaration.initializer, bindings, resolve) : null
  }

  const hits = []
  const report = (node, label, fn) => hits.push({ rule: 'fs-watch-filename', node, hit: normalize(`${label} (${fn.parameters.map(p => p.getText()).join(', ')})`) })
  const visit = node => {
    if (ts.isCallExpression(node) && watchKind(node, bindings, resolve) === 'callback') {
      const fn = node.arguments.find(declaresFileName)
      if (fn) report(node, node.expression.getText(), fn)
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['on', 'once', 'addListener'].includes(node.expression.name.text)
      && kindOf(node.expression.expression) === 'callback') {
      const fn = node.arguments.find(declaresFileName)
      if (fn) report(node, `${node.expression.expression.getText()}.${node.expression.name.text}`, fn)
    }
    if (ts.isForOfStatement(node) && node.awaitModifier && kindOf(node.expression) === 'promise' && ts.isVariableDeclarationList(node.initializer)) {
      const name = node.initializer.declarations[0].name
      const destructures = ts.isObjectBindingPattern(name) && name.elements.some(element => (element.propertyName ?? element.name).getText() === 'filename')
      const reads = ts.isIdentifier(name) && some(node.statement, n => ts.isPropertyAccessExpression(n) && n.name.text === 'filename' && n.expression.getText() === name.text)
      if (destructures || reads) hits.push({ rule: 'fs-watch-filename', node, hit: normalize(`for await (${node.initializer.getText()} of ${node.expression.getText()})`) })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

export function findDeterminismHits(source, fileName) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[path.extname(fileName)] ?? ts.ScriptKind.TS)
  return [...wallClockHits(sf), ...watchFileNameHits(sf)]
    .map(({ rule, node, hit }) => ({ rule, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, hit }))
    .sort((a, b) => a.line - b.line)
}

function listTestFiles(rootDir) {
  const files = []
  const walk = relativeDir => {
    const absolute = path.join(rootDir, relativeDir)
    if (!fs.existsSync(absolute)) return
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const relative = `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(relative) }
      else if (SCRIPT_KINDS[path.extname(entry.name)] !== undefined && isTestFile(relative)) files.push(relative)
    }
  }
  SCAN_ROOTS.forEach(walk)
  return files.sort()
}

const keyOf = ({ file, rule, hit }) => JSON.stringify([file, rule, hit])

export function checkTestDeterminism(rootDir) {
  const baselinePath = path.join(rootDir, BASELINE_FILE)
  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : []
  const allowed = new Map(baseline.map(entry => [keyOf(entry), entry.count]))
  const violations = []
  for (const file of listTestFiles(rootDir)) {
    const source = fs.readFileSync(path.join(rootDir, file), 'utf8')
    if (!MAY_HIT.test(source)) continue
    for (const { rule, line, hit } of findDeterminismHits(source, file)) {
      const key = keyOf({ file, rule, hit })
      const left = allowed.get(key) ?? 0
      if (left > 0) allowed.set(key, left - 1)
      else violations.push({ file, line, rule, hit })
    }
  }
  const stale = baseline.filter(entry => allowed.get(keyOf(entry)) > 0).map(entry => ({ ...entry, count: allowed.get(keyOf(entry)) }))
  return { violations, stale }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const rootDir = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
  const { violations, stale } = checkTestDeterminism(rootDir)
  for (const { file, line, rule, hit } of violations) console.error(`${file}:${line} ${RULES[rule]}\n  ${hit}`)
  for (const { file, rule, hit, count } of stale) console.error(`${BASELINE_FILE} 里多出 ${count} 条已不存在的命中，删掉或减 count：${file} ${rule}\n  ${hit}`)
  if (violations.length > 0 || stale.length > 0) process.exit(1)
  console.log('check-test-determinism: 通过')
}
