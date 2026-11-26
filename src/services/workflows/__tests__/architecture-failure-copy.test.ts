import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import SNAPSHOT from './architecture-failure-copy.master.json'

type Entry = [file: string, zh: string, en: string]

const FILES = [
  'src/services/workflows/commands/architecture.command.ts',
  'src/services/workflows/architecture-workflow.ts',
  'src/services/workflows/commands/generate-field.command.ts',
]

const squash = (node: ts.Node) => node.getText().replace(/\s+/gu, '')
const calleeName = (call: ts.CallExpression) => ts.isIdentifier(call.expression) ? call.expression.text : undefined

function pairOf(call: ts.CallExpression): { zh: ts.Expression; en: ts.Expression; params?: ts.Expression } | undefined {
  const name = calleeName(call)
  const args = call.arguments
  if ((name === 'text' || name === 'uiText') && args.length === 2) return { zh: args[0], en: args[1] }
  if (name === 'workflowUiText' && args.length === 3) return { zh: args[1], en: args[2] }
  if (name === 'note' && (args.length === 2 || args.length === 3)) return { zh: args[0], en: args[1], params: args[2] }
  return undefined
}

function isFailureCopy(call: ts.CallExpression): boolean {
  if (calleeName(call) === 'note') return true
  for (let node: ts.Node | undefined = call.parent; node; node = node.parent) {
    if (ts.isThrowStatement(node)) return true
    if (ts.isNewExpression(node) && /Error$/u.test(node.expression.getText())) return true
    if (ts.isCallExpression(node) && calleeName(node) === 'authorError') return true
    if (ts.isFunctionLike(node)) return false
  }
  return false
}

function paramExpressions(params: ts.Expression | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!params || !ts.isObjectLiteralExpression(params)) return map
  for (const property of params.properties) {
    if (ts.isShorthandPropertyAssignment(property)) map.set(property.name.text, property.name.text)
    else if (ts.isPropertyAssignment(property)) {
      const value = property.initializer
      const owned = ts.isCallExpression(value) && calleeName(value) === 'authorOwned' ? value.arguments[0] : value
      map.set(property.name.getText(), squash(owned))
    }
  }
  return map
}

/** 与 codemod.mjs 快照同一套写法：插值和参数统一成 ⟨表达式⟩。 */
function normalized(node: ts.Expression, params: Map<string, string> | undefined): string {
  let text: string
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text
  else if (ts.isTemplateExpression(node)) {
    text = node.head.text + node.templateSpans.map(span => `⟨${squash(span.expression)}⟩${span.literal.text}`).join('')
  } else return `⟨${squash(node)}⟩`
  return params ? text.replace(/\{(\w+)\}/gu, (whole, name: string) => params.has(name) ? `⟨${params.get(name)}⟩` : whole) : text
}

function currentCopy(): Entry[] {
  const entries: Entry[] = []
  for (const file of FILES) {
    const source = ts.createSourceFile(file, readFileSync(join(process.cwd(), file), 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const pair = pairOf(node)
        if (pair && isFailureCopy(node)) {
          const params = pair.params ? paramExpressions(pair.params) : undefined
          entries.push([file, normalized(pair.zh, params), normalized(pair.en, params)])
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return entries
}

const keyOf = (entry: readonly string[]) => entry.join('\u0000')
const counted = (entries: readonly (readonly string[])[]) => entries.map(keyOf).sort()

it('架构线的失败说明与 master 逐字相同', () => {
  const removed = new Map<string, number>()
  for (const entry of [...SNAPSHOT.removedRestructured, ...SNAPSHOT.removedReworded]) removed.set(keyOf(entry), (removed.get(keyOf(entry)) ?? 0) + 1)
  const kept = SNAPSHOT.master.filter(entry => {
    const left = removed.get(keyOf(entry)) ?? 0
    if (left === 0) return true
    removed.set(keyOf(entry), left - 1)
    return false
  })
  // 除了快照里登记的整句展开（restructured）和改写（reworded），其余失败说明都和 master 一字不差。
  expect(counted(currentCopy())).toEqual(counted([...kept, ...SNAPSHOT.addedRestructured, ...SNAPSHOT.addedReworded]))
})
