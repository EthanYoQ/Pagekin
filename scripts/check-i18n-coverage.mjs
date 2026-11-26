import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const han = /\p{Script=Han}/u
const latinWord = /[A-Za-z]{2,}/
const fixedPluralAfterCount = /^ (?:[a-z]+ ){0,2}(?:chapters|files|characters|items|lines|calls|drafts|words|documents|chunks|days|notes|versions|entries|kinds|blueprints|events|minutes|passages|candidates|tasks|suggestions|changes|checks)\b/
const pluralBeforeCount = /\b(?:these|those)\s$/i
const pluralVerbAfterCount = /^ (?:have|are|were)\b/
const pluralHint = "Write the noun with pluralEn(count, 'chapter'); pass irregular plurals explicitly, as in pluralEn(count, 'entry', 'entries'). Write a verb that follows the count the same way, as in pluralEn(count, 'has', 'have')."
const englishArgumentIndex = new Map([['localize', 2], ['stepDesc', 2], ['mainText', 2], ['projectError', 2], ['artifactError', 2], ['workflowUiText', 2], ['localeText', 2], ['textForLocale', 2], ['agentToolText', 2]])

export const I18N_COVERAGE_BOUNDARIES = Object.freeze({
  rendererRoots: [
    'src/App.tsx',
    'src/components',
    'src/services/project-service.ts',
    'src/services/workflows/architecture-workflow.ts',
  ],
  rendererErrorBoundaries: [
    'src/stores/project-store.ts',
    'src/components/panels/agent/artifact-open.ts',
  ],
  mainReturnErrorBoundaries: [
    'electron/controllers/fs-controller.ts',
  ],
  workflowCommandErrorBoundaries: [
    'src/services/workflows/commands',
  ],
  workflowErrorBoundaries: [
    'src/services/workflows',
  ],
  rendererThrowErrorBoundaries: [
    'src',
  ],
  rendererErrorDisplayBoundaries: [
    'src',
  ],
  strictWorkflowCommandErrorBoundaries: [
    'src/services/workflows/commands/legacy-character-roster-repair.command.ts',
  ],
})

export const I18N_COVERAGE_EXCLUSIONS = Object.freeze([
  'LLM prompts and response-parser strings that do not reach a renderer notification sink.',
  'Console-only diagnostics that are not passed to a renderer notification sink.',
  'Internal identifiers, IPC channel names, paths and protocol values outside visible-copy properties.',
])

const visibleWorkflowProperties = new Set([
  'title',
  'name',
  'description',
  'label',
  'message',
])

const notificationCallNames = new Set([
  'alertError',
  'confirm',
  'addLog',
  'toast.error',
  'toast.success',
  'toast.warning',
  'cb.log',
  'cb.appendText',
  'runProjectEventTask',
])

const enhancedCoverageFiles = new Set([
  'src/components/editor/use-chapter-blueprints.ts',
  'src/components/editor/review-checklist.ts',
  'src/services/project-service.ts',
  'src/services/workflows/architecture-workflow.ts',
])

const localizationCallees = new Set([
  'text',
  'knownAppErrorMessage',
  'agentToolErrorDetail',
  'localize',
  'translate',
  'stepDesc',
  'appErrorMessage',
  'displayedErrorMessage',
  'projectDeleteFailureMessage',
  'projectText',
  'projectError',
  'artifactText',
  'artifactError',
  'mainText',
  'workflowUiText',
  'uiText',
  'localeText',
  'textForLocale',
  'agentToolText',
])

function filesAt(target) {
  if (!fs.existsSync(target)) return []
  const stat = fs.statSync(target)
  if (stat.isFile()) return [target]
  return fs.readdirSync(target, { withFileTypes: true }).flatMap(entry =>
    filesAt(path.join(target, entry.name)))
}

function relativePath(root, file) {
  return path.relative(root, file).replaceAll('\\', '/')
}

function add(violations, root, file, sourceFile, node, text, kind) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  violations.push(`${relativePath(root, file)}:${line} [${kind}] ${text.trim().replace(/\s+/g, ' ')}`)
}

function callName(node, sourceFile) {
  return node.expression.getText(sourceFile)
}

function isLocalizedCall(node, sourceFile) {
  if (!ts.isCallExpression(node)) return false
  const callee = callName(node, sourceFile)
  return localizationCallees.has(callee) || callee.endsWith('.text')
}

function literalContainsHumanCopy(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return han.test(node.text) || latinWord.test(node.text)
  }
  if (ts.isTemplateExpression(node)) {
    return han.test(node.head.text)
      || latinWord.test(node.head.text)
      || node.templateSpans.some(span => han.test(span.literal.text) || latinWord.test(span.literal.text))
  }
  return false
}

function literalContainsHan(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return han.test(node.text)
  }
  if (ts.isTemplateExpression(node)) {
    return han.test(node.head.text) || node.templateSpans.some(span => han.test(span.literal.text))
  }
  return false
}

function nodeContainsHumanCopy(node, sourceFile) {
  if (isLocalizedCall(node, sourceFile)) return false
  if (literalContainsHumanCopy(node)) return true
  let found = false
  ts.forEachChild(node, child => {
    if (!found && nodeContainsHumanCopy(child, sourceFile)) found = true
  })
  return found
}

function nodeContainsHan(node, sourceFile) {
  if (isLocalizedCall(node, sourceFile)) return false
  if (literalContainsHan(node)) return true
  let found = false
  ts.forEachChild(node, child => {
    if (!found && nodeContainsHan(child, sourceFile)) found = true
  })
  return found
}

function nodeContainsEnglishCopy(node, sourceFile) {
  if (isLocalizedCall(node, sourceFile)) return false
  if (ts.isConditionalExpression(node)) {
    return nodeContainsEnglishCopy(node.whenTrue, sourceFile) || nodeContainsEnglishCopy(node.whenFalse, sourceFile)
  }
  if (ts.isElementAccessExpression(node)) return nodeContainsEnglishCopy(node.expression, sourceFile)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return !errorCode.test(node.text) && latinWord.test(node.text)
  }
  if (ts.isTemplateExpression(node)) {
    return [node.head, ...node.templateSpans.map(span => span.literal)].some(part => latinWord.test(part.text))
      || node.templateSpans.some(span => nodeContainsEnglishCopy(span.expression, sourceFile))
  }
  let found = false
  ts.forEachChild(node, child => {
    if (!found && nodeContainsEnglishCopy(child, sourceFile)) found = true
  })
  return found
}

function nodeContainsUnlocalizedPromptDescription(node, sourceFile) {
  if (isLocalizedCall(node, sourceFile)) return false
  if (ts.isIdentifier(node) && node.text === 'desc') return true
  if (
    ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
    || ts.isFunctionDeclaration(node)
    || ts.isJsxElement(node)
    || ts.isJsxSelfClosingElement(node)
    || ts.isJsxFragment(node)
  ) return false
  let found = false
  ts.forEachChild(node, child => {
    if (!found && nodeContainsUnlocalizedPromptDescription(child, sourceFile)) found = true
  })
  return found
}

function collectBindings(sourceFile) {
  const bindings = new Map()
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
    ) {
      bindings.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return bindings
}

function isUnsafeErrorForward(node, sourceFile, bindings, seen = new Set()) {
  if (ts.isParenthesizedExpression(node)) {
    return isUnsafeErrorForward(node.expression, sourceFile, bindings, seen)
  }
  if (ts.isCallExpression(node) && callName(node, sourceFile) === 'String') return true
  if (
    ts.isPropertyAccessExpression(node)
    && ['error', 'warning', 'message'].includes(node.name.text)
  ) return true
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return false
    const initializer = bindings.get(node.text)
    if (!initializer) return false
    seen.add(node.text)
    return isUnsafeErrorForward(initializer, sourceFile, bindings, seen)
  }
  if (ts.isBinaryExpression(node) && ['??', '||'].includes(node.operatorToken.getText(sourceFile))) {
    return isUnsafeErrorForward(node.left, sourceFile, bindings, seen)
      || isUnsafeErrorForward(node.right, sourceFile, bindings, seen)
  }
  return false
}

const isPluralEnCall = (expression, sourceFile) => expression.getText(sourceFile).startsWith('pluralEn(')

function englishSlots(node, sourceFile, params) {
  const parts = ts.isTemplateExpression(node)
    ? [node.head.text, ...node.templateSpans.flatMap(span => [{ pluralEn: isPluralEnCall(span.expression, sourceFile) }, span.literal.text])]
    : [node.text]
  const filled = params && ts.isObjectLiteralExpression(params)
    ? new Map(params.properties.filter(property => property.name).map(property => [property.name.getText(sourceFile),
      ts.isPropertyAssignment(property) ? property.initializer : undefined]))
    : undefined
  const texts = [], slots = []
  let current = ''
  for (const part of parts) {
    if (typeof part !== 'string') {
      texts.push(current)
      slots.push(part)
      current = ''
      continue
    }
    let last = 0
    for (const match of params ? part.matchAll(/\{(\w+)\}/g) : []) {
      texts.push(current + part.slice(last, match.index))
      const value = filled?.get(match[1])
      slots.push({ pluralEn: Boolean(value && isPluralEnCall(value, sourceFile)) })
      current = ''
      last = match.index + match[0].length
    }
    current += part.slice(last)
  }
  texts.push(current)
  return { texts, slots }
}

function inspectEnglishCounts(violations, root, file, sourceFile, node, params) {
  const { texts, slots } = ts.isTemplateExpression(node) || ts.isStringLiteralLike(node)
    ? englishSlots(node, sourceFile, params)
    : { texts: [], slots: [] }
  if (
    slots.some((slot, index) => {
      const before = texts[index], after = texts[index + 1]
      if (/[-–]$/.test(before)) return false
      if (slot.pluralEn) {
        return pluralVerbAfterCount.test(after) && !/\band\b[^.;:!?·—\n。：；！？]*$/i.test(texts.slice(0, index + 1).join(' '))
      }
      return fixedPluralAfterCount.test(after) || pluralBeforeCount.test(before) || pluralVerbAfterCount.test(after)
    })
  ) {
    add(violations, root, file, sourceFile, node, node.getText(sourceFile), 'english-plural')
  }
  ts.forEachChild(node, child => inspectEnglishCounts(violations, root, file, sourceFile, child, params))
}

function inspectVisibleExpression(violations, root, file, sourceFile, node, kind) {
  if (isLocalizedCall(node, sourceFile)) return
  if (nodeContainsHan(node, sourceFile)) {
    add(violations, root, file, sourceFile, node, node.getText(sourceFile), kind)
    return
  }
  ts.forEachChild(node, child => inspectVisibleExpression(violations, root, file, sourceFile, child, kind))
}

function inspectBoundaryExpression(violations, root, file, sourceFile, node, kind, bindings) {
  if (isLocalizedCall(node, sourceFile)) return
  if (isUnsafeErrorForward(node, sourceFile, bindings)) {
    add(violations, root, file, sourceFile, node, node.getText(sourceFile), kind)
    return
  }
  if (nodeContainsHumanCopy(node, sourceFile)) {
    add(violations, root, file, sourceFile, node, node.getText(sourceFile), kind)
    return
  }
  ts.forEachChild(node, child => inspectBoundaryExpression(
    violations,
    root,
    file,
    sourceFile,
    child,
    kind,
    bindings,
  ))
}

function inspectNotification(violations, root, file, sourceFile, node, bindings) {
  const name = callName(node, sourceFile)
  const [message, options] = node.arguments
  if (message) {
    inspectBoundaryExpression(violations, root, file, sourceFile, message, `notification:${name}`, bindings)
  }
  if (options && ts.isObjectLiteralExpression(options)) {
    for (const property of options.properties) {
      if (
        ts.isPropertyAssignment(property)
        && ['title', 'confirmText'].includes(property.name.getText(sourceFile))
      ) {
        inspectBoundaryExpression(
          violations,
          root,
          file,
          sourceFile,
          property.initializer,
          `notification:${name}`,
          bindings,
        )
      }
    }
  }
}

function inspectRendererFile(violations, root, file, sourceFile) {
  const relativeFile = relativePath(root, file)
  const enhanced = enhancedCoverageFiles.has(relativeFile)
  const strictBoundary = I18N_COVERAGE_BOUNDARIES.rendererErrorBoundaries.includes(relativeFile)
  const promptSettings = relativeFile === 'src/components/settings/PromptSettings.tsx'
  const bindings = collectBindings(sourceFile)

  const visit = (node) => {
    if (isLocalizedCall(node, sourceFile)) {
      const englishIndex = englishArgumentIndex.get(callName(node, sourceFile)) ?? 1
      const english = node.arguments[englishIndex]
      const { params, unknown } = copyArguments(node, englishIndex)
      if (english) inspectEnglishCounts(violations, root, file, sourceFile, english, params ?? unknown)
    }
    if (
      promptSettings
      && ts.isJsxExpression(node)
      && node.expression
      && nodeContainsUnlocalizedPromptDescription(node.expression, sourceFile)
    ) {
      add(
        violations,
        root,
        file,
        sourceFile,
        node,
        node.expression.getText(sourceFile),
        'prompt-variable-description',
      )
    }
    if (ts.isJsxText(node) && han.test(node.getText(sourceFile))) {
      add(violations, root, file, sourceFile, node, node.getText(sourceFile), 'jsx-text')
    }
    if (
      ts.isJsxAttribute(node)
      && node.name.getText(sourceFile) !== 'value'
      && node.initializer
      && ts.isStringLiteral(node.initializer)
      && han.test(node.initializer.text)
    ) {
      add(violations, root, file, sourceFile, node, node.initializer.text, `attribute:${node.name.getText(sourceFile)}`)
    }
    if (enhanced && ts.isJsxExpression(node) && node.expression) {
      inspectVisibleExpression(violations, root, file, sourceFile, node.expression, 'jsx-expression')
    }
    if (
      enhanced
      && ts.isPropertyAssignment(node)
      && visibleWorkflowProperties.has(node.name.getText(sourceFile))
    ) {
      inspectVisibleExpression(
        violations,
        root,
        file,
        sourceFile,
        node.initializer,
        `workflow:${node.name.getText(sourceFile)}`,
      )
    }
    if (
      (enhanced || strictBoundary)
      && ts.isCallExpression(node)
      && notificationCallNames.has(callName(node, sourceFile))
    ) {
      if (strictBoundary) {
        inspectNotification(violations, root, file, sourceFile, node, bindings)
      } else {
        const argumentsToInspect = callName(node, sourceFile) === 'runProjectEventTask'
          ? node.arguments.slice(0, 1)
          : node.arguments
        for (const argument of argumentsToInspect) {
          inspectVisibleExpression(
            violations,
            root,
            file,
            sourceFile,
            argument,
            `notification:${callName(node, sourceFile)}`,
          )
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function inspectMainReturnErrors(violations, root, file, sourceFile) {
  const bindings = collectBindings(sourceFile)
  const visit = (node) => {
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      for (const property of node.expression.properties) {
        if (
          ts.isPropertyAssignment(property)
          && ['error', 'warning'].includes(property.name.getText(sourceFile))
        ) {
          inspectBoundaryExpression(
            violations,
            root,
            file,
            sourceFile,
            property.initializer,
            `main-return:${property.name.getText(sourceFile)}`,
            bindings,
          )
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

const errorCode = /^[A-Z][A-Z0-9_]*$/
const testOrDeclarationFile = /\.(?:test|spec)\.tsx?$|\.browser\.tsx?$|\.stories\.tsx?$|\.d\.ts$/u
const exemptDirective =/\/\/\s*i18n-exempt:(.*)$/u

function exemption(sourceFile, node) {
  const lines = sourceFile.getFullText().split(/\r?\n/u)
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
  const commentLineAbove = (index) => lines[index - 1]?.trimStart().startsWith('//') ? lines[index - 1] : undefined
  const candidates = [lines[line], commentLineAbove(line)]
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue
    const declaration = ts.isVariableDeclaration(current.parent) ? current.parent.parent.parent : current
    candidates.push(commentLineAbove(sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line))
  }
  for (const text of candidates) {
    const match = text && exemptDirective.exec(text)
    if (match) return match[1].trim() ? 'exempt' : 'missing-reason'
  }
  return undefined
}

const errorDisplayCalls = new Set(['alertError', 'confirm', 'addLog', 'toast.error', 'toast.warning', 'toast.success', 'toast.info'])
const errorStateSetter = /^set\w*(?:Error|Message|Warning|Notice|Failure|Reason)$/u
const errorStateKey = /error|message|warning|reason|notice|^text$/iu
const textCallees = new Set(['text', 'localize', 'translate', 'workflowUiText', 'uiText', 'localeText', 'textForLocale', 'agentToolText'])

function isCatchVariable(node, sourceFile) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCatchClause(current) && current.variableDeclaration?.name.getText(sourceFile) === node.text) return true
  }
  return false
}

function forwardsRawError(node, sourceFile, bindings, seen = new Set()) {
  if (isLocalizedCall(node, sourceFile)) return false
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    return forwardsRawError(node.expression, sourceFile, bindings, seen)
  }
  if (ts.isCallExpression(node)) return callName(node, sourceFile) === 'String'
  if (ts.isPropertyAccessExpression(node)) return ['error', 'warning', 'message'].includes(node.name.text)
  if (ts.isIdentifier(node)) {
    if (isCatchVariable(node, sourceFile)) return true
    if (seen.has(node.text)) return false
    const initializer = bindings.get(node.text)
    if (!initializer) return false
    seen.add(node.text)
    return forwardsRawError(initializer, sourceFile, bindings, seen)
  }
  if (ts.isBinaryExpression(node) && ['??', '||'].includes(node.operatorToken.getText(sourceFile))) {
    return forwardsRawError(node.left, sourceFile, bindings, seen) || forwardsRawError(node.right, sourceFile, bindings, seen)
  }
  if (ts.isConditionalExpression(node)) {
    return forwardsRawError(node.whenTrue, sourceFile, bindings, seen) || forwardsRawError(node.whenFalse, sourceFile, bindings, seen)
  }
  if (ts.isTemplateExpression(node)) return node.templateSpans.some(span => forwardsRawError(span.expression, sourceFile, bindings, seen))
  return false
}

function inspectRawErrorDisplays(violations, root, file, sourceFile) {
  const bindings = collectBindings(sourceFile)
  const report = (node, value, kind) => {
    const exempt = exemption(sourceFile, node)
    if (exempt === 'missing-reason') add(violations, root, file, sourceFile, node, value.getText(sourceFile), 'exempt-without-reason')
    else if (!exempt) add(violations, root, file, sourceFile, node, value.getText(sourceFile), kind)
  }
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = callName(node, sourceFile)
      const [first] = node.arguments
      const isAddLog = name === 'addLog' || name.endsWith('.addLog')
      if (isAddLog || errorDisplayCalls.has(name) || (ts.isIdentifier(node.expression) && errorStateSetter.test(name))) {
        const values = isAddLog ? node.arguments.slice(1, 2) : first ? [first] : []
        for (const value of values) {
          const forwarded = ts.isObjectLiteralExpression(value)
            ? value.properties.find(property => ts.isPropertyAssignment(property) && errorStateKey.test(property.name.getText(sourceFile))
              && forwardsRawError(property.initializer, sourceFile, bindings))
            : forwardsRawError(value, sourceFile, bindings) && value
          if (forwarded) report(node, forwarded, `raw-error-display:${name}`)
        }
      }
      if ((name === 'set' || name.endsWith('.setState')) && first && ts.isObjectLiteralExpression(first)) {
        for (const property of first.properties) {
          if (ts.isPropertyAssignment(property) && errorStateKey.test(property.name.getText(sourceFile))
            && forwardsRawError(property.initializer, sourceFile, bindings)) report(property, property.initializer, 'raw-error-display:state')
        }
      }
      if (textCallees.has(name) || name.endsWith('.text')) {
        const spans = node.arguments.flatMap(argument => ts.isTemplateExpression(argument)
          ? argument.templateSpans.map(span => span.expression)
          : ts.isObjectLiteralExpression(argument)
            ? argument.properties.filter(ts.isPropertyAssignment).map(property => property.initializer)
            : [])
        const forwarded = spans.find(span => forwardsRawError(span, sourceFile, bindings))
        if (forwarded) report(node, forwarded, `raw-error-display:${name}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function inspectThrownErrors(violations, root, file, sourceFile, mode, allowErrorCodes) {
  const bindings = collectBindings(sourceFile)
  const visit = (node) => {
    const thrown = ts.isThrowStatement(node) ? node.expression
      : ts.isCallExpression(node) && callName(node, sourceFile) === 'Promise.reject' && node.arguments[0]
    const message = thrown && ts.isNewExpression(thrown) && thrown.expression.getText(sourceFile) === 'Error' && thrown.arguments?.[0]
    const exempt = message && exemption(sourceFile, node)
    if (exempt === 'missing-reason') {
      add(violations, root, file, sourceFile, node, message.getText(sourceFile), 'exempt-without-reason')
    } else if (exempt) {
      // 写明理由的豁免：作者看不到这条说明。
    } else if (message && mode === 'chinese') {
      inspectVisibleExpression(violations, root, file, sourceFile, message, 'thrown-error')
    } else if (message && mode === 'untranslated') {
      if (nodeContainsHan(message, sourceFile) || nodeContainsEnglishCopy(message, sourceFile)) {
        add(violations, root, file, sourceFile, message, message.getText(sourceFile), 'thrown-error')
      }
    } else if (message && !(allowErrorCodes && ts.isStringLiteralLike(message) && errorCode.test(message.text))) {
      inspectBoundaryExpression(violations, root, file, sourceFile, message, 'thrown-error', bindings)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

export const MAIN_ERROR_BASELINE_PATH = 'scripts/i18n-main-error-baseline.json'
const MAIN_ERROR_ROOT = 'electron'
const mainErrorProperties = new Set(['error', 'warning', 'reason', 'errorMessage'])
const mainLocalizationCallees = new Set([...localizationCallees, 'mainT', 'importText'])

function isMainLocalized(node, sourceFile) {
  if (ts.isCallExpression(node)) {
    const callee = callName(node, sourceFile)
    if (mainLocalizationCallees.has(callee) || callee.endsWith('.text')) return true
  }
  return ts.isConditionalExpression(node) && /locale|en-US|zh-CN/iu.test(node.condition.getText(sourceFile))
}

function mainContainsHan(node, sourceFile) {
  if (isMainLocalized(node, sourceFile)) return false
  if (literalContainsHan(node)) return true
  let found = false
  ts.forEachChild(node, child => {
    if (!found && mainContainsHan(child, sourceFile)) found = true
  })
  return found
}

const isFunctionWithBody = node => ts.isFunctionLike(node) && Boolean(node.body)

function ownFunctionName(fn) {
  if (fn.name) return fn.name.getText()
  const parent = fn.parent
  if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.name) {
    return parent.name.getText()
  }
  return '<anonymous>'
}

function mainErrorOwner(node) {
  let owner
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionWithBody(current) && (!owner || ts.isSourceFile(current.parent) || ts.isClassDeclaration(current.parent) || ts.isVariableDeclaration(current.parent))) {
      owner = ownFunctionName(current)
    }
    if (ts.isClassDeclaration(current) && current.name && owner) return `${current.name.text}.${owner}`
  }
  return owner ?? '<module>'
}

function insideConsoleCall(node, sourceFile) {
  for (let current = node.parent; current && !isFunctionWithBody(current); current = current.parent) {
    if (ts.isCallExpression(current) && callName(current, sourceFile).startsWith('console.')) return true
  }
  return false
}

function collectMainErrorSites(root, violations) {
  const sites = []
  for (const file of filesAt(path.join(root, MAIN_ERROR_ROOT))) {
    const relativeFile = relativePath(root, file)
    if (!/\.tsx?$/u.test(file) || testOrDeclarationFile.test(file) || relativeFile.split('/').includes('__tests__')) continue
    const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const counted = new Set()
    const record = (node, reported = node) => {
      const exempt = exemption(sourceFile, node)
      if (exempt === 'missing-reason') {
        add(violations, root, file, sourceFile, node, reported.getText(sourceFile), 'exempt-without-reason')
      } else if (!exempt) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        sites.push({ file: relativeFile, owner: mainErrorOwner(node), line, text: reported.getText(sourceFile).trim().replace(/\s+/g, ' ') })
      }
    }
    const visit = (node) => {
      if (ts.isThrowStatement(node) && node.expression && mainContainsHan(node.expression, sourceFile)) {
        record(node, node.expression)
        counted.add(node.expression)
      } else if (ts.isCallExpression(node) && /(?:^|\.)reject$/u.test(callName(node, sourceFile)) && node.arguments.some(argument => mainContainsHan(argument, sourceFile))) {
        record(node)
        node.arguments.forEach(argument => counted.add(argument))
      } else if (ts.isCallExpression(node) && /dialog\.show(?:ErrorBox|MessageBox|MessageBoxSync)$/u.test(callName(node, sourceFile)) && node.arguments.some(argument => mainContainsHan(argument, sourceFile))) {
        record(node)
      } else if (ts.isNewExpression(node) && /Error$/u.test(node.expression.getText(sourceFile)) && !counted.has(node)
        && node.arguments?.some(argument => mainContainsHan(argument, sourceFile)) && !insideConsoleCall(node, sourceFile)) {
        let parent = node.parent
        while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent))) parent = parent.parent
        if (!(parent && ts.isThrowStatement(parent))) record(node)
      } else if (ts.isPropertyAssignment(node) && mainErrorProperties.has(node.name.getText(sourceFile))
        && mainContainsHan(node.initializer, sourceFile) && !insideConsoleCall(node, sourceFile)) {
        record(node, node.initializer)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return sites
}

function countMainErrorSites(sites) {
  const counts = {}
  for (const site of [...sites].sort((left, right) => left.file.localeCompare(right.file) || left.owner.localeCompare(right.owner))) {
    counts[site.file] ??= {}
    counts[site.file][site.owner] = (counts[site.file][site.owner] ?? 0) + 1
  }
  return counts
}

function readMainErrorBaseline(root) {
  const file = path.join(root, MAIN_ERROR_BASELINE_PATH)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).files ?? {} : {}
}

const updateBaselineCommand = `node scripts/check-i18n-coverage.mjs --update-baseline`

function compareMainErrorBaseline(sites, baseline, violations) {
  const counts = countMainErrorSites(sites)
  for (const [file, owners] of Object.entries(counts)) {
    for (const [owner, count] of Object.entries(owners)) {
      const allowed = baseline[file]?.[owner] ?? 0
      if (count <= allowed) continue
      for (const site of sites.filter(candidate => candidate.file === file && candidate.owner === owner)) {
        violations.push(`${site.file}:${site.line} [main-error] ${site.text}`)
      }
      violations.push(`${file} ${owner}: ${count} Chinese-only main-process error(s), baseline allows ${allowed}. Throw a registered error code, localize with mainText, or add \`// i18n-exempt: <reason>\`.`)
    }
  }
  for (const [file, owners] of Object.entries(baseline)) {
    for (const [owner, allowed] of Object.entries(owners)) {
      const count = counts[file]?.[owner] ?? 0
      if (count < allowed) {
        violations.push(`${file} ${owner}: baseline allows ${allowed} Chinese-only main-process error(s) but ${count} remain [main-error-baseline-stale]. Tighten the baseline: ${updateBaselineCommand}`)
      }
    }
  }
  return counts
}

const JA_REPORT_ROOTS = ['src', 'electron']
const RUN_CODE_ROOTS = ['src/services/workflows/', 'src/services/agent/']
const jaCopyCallees = new Map([['text', 0], ['localize', 1], ['mainText', 1]])
const frozenCopyLocale = /^(?:copyLocale\(|useLocaleStore\.getState\(\)\.locale$)/u

function isStringCopy(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)
}

function copyArguments(node, englishIndex) {
  const third = node.arguments[englishIndex + 1]
  if (node.arguments.length > englishIndex + 2 || (third && isStringCopy(third))) return { ja: third, params: node.arguments[englishIndex + 2] }
  if (!third || ts.isObjectLiteralExpression(third)) return { params: third }
  return { unknown: third }
}

function jaCopyCallee(node, sourceFile) {
  const callee = callName(node, sourceFile)
  const name = jaCopyCallees.has(callee) ? callee : callee.endsWith('.text') ? 'text' : undefined
  if (!name) return undefined
  const enough = node.arguments.length >= jaCopyCallees.get(name) + 2 || node.arguments.some(ts.isSpreadElement)
  return enough ? name : undefined
}

function isFunctionValue(node) {
  return Boolean(node) && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
}

function declaresCopyFunction(statement, name) {
  if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return 'local'
  if (!ts.isVariableStatement(statement)) return undefined
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return isFunctionValue(declaration.initializer) ? 'local' : 'shared'
    if (ts.isObjectBindingPattern(declaration.name) && declaration.name.elements.some(element => element.name.getText() === name)) return 'shared'
  }
  return undefined
}

function copyFunctionBinding(node, name) {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters?.some(parameter => parameter.name.getText() === name)) return 'shared'
    const statements = ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) ? scope.statements : undefined
    for (const statement of statements ?? []) {
      const found = declaresCopyFunction(statement, name)
      if (found) return found
    }
  }
  return 'shared'
}

function classifyJaCopyCall(node, sourceFile) {
  const callee = jaCopyCallee(node, sourceFile)
  if (!callee) return undefined
  if (ts.isIdentifier(node.expression) && copyFunctionBinding(node, callee) === 'local') return { callee, status: 'local' }
  const englishIndex = jaCopyCallees.get(callee) + 1
  const locale = callee === 'text' ? undefined : node.arguments[0]?.getText(sourceFile)
  if (node.arguments.slice(0, englishIndex + 2).some(ts.isSpreadElement)) return { callee, locale, status: 'undetermined' }
  const { ja, unknown } = copyArguments(node, englishIndex)
  if (ja) return { callee, locale, status: isStringCopy(ja) && !ts.isTemplateExpression(ja) && ja.text.trim() === '' ? 'empty' : 'translated' }
  if (unknown) return { callee, locale, status: 'undetermined' }
  return { callee, locale, status: locale && frozenCopyLocale.test(locale) ? 'copy-locale' : 'missing' }
}

const isRunCode = file => RUN_CODE_ROOTS.some(root => file.startsWith(root))

function collectJaCopyCalls(root) {
  const calls = []
  for (const relative of JA_REPORT_ROOTS) {
    for (const file of filesAt(path.join(root, relative))) {
      const relativeFile = relativePath(root, file)
      if (!/\.tsx?$/u.test(file) || testOrDeclarationFile.test(file) || relativeFile.split('/').includes('__tests__')) continue
      const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      const visit = (node) => {
        const call = ts.isCallExpression(node) && classifyJaCopyCall(node, sourceFile)
        if (call) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
          calls.push({ ...call, file: relativeFile, line })
        }
        ts.forEachChild(node, visit)
      }
      visit(sourceFile)
    }
  }
  return calls
}

function jaViolations(calls) {
  return calls.flatMap((call) => {
    const at = `${call.file}:${call.line}`
    if (isRunCode(call.file) && (call.status === 'translated' || call.status === 'empty')) {
      return [`${at} [run-code-ja] ${call.callee}() 在运行代码里写了日文：这里的文案跟运行语言走、会写进运行记录，ja-JP 不落库（#725），删掉日文参数 (copy here follows the run language and is stored in run records; do not add Japanese)`]
    }
    return call.status === 'empty' ? [`${at} [empty-ja] ${call.callee}() 的日文是空字符串：写上日文，或删掉这个参数`] : []
  })
}

function countBy(calls, key) {
  const counts = new Map()
  for (const call of calls) {
    const group = key(call)
    const entry = counts.get(group) ?? { calls: 0, missing: 0 }
    entry.calls += 1
    if (call.status === 'missing') entry.missing += 1
    counts.set(group, entry)
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b))
}

export function reportJapaneseCoverage(root = process.cwd(), area = '') {
  const prefix = area.replaceAll('\\', '/').replace(/\/$/u, '')
  const calls = collectJaCopyCalls(root).filter(call => !prefix || call.file === prefix || call.file.startsWith(`${prefix}/`))
  const shared = calls.filter(call => call.status !== 'local')
  const runCode = shared.filter(call => isRunCode(call.file))
  const counted = shared.filter(call => !isRunCode(call.file) && call.status !== 'copy-locale')
  const total = status => counted.filter(call => call.status === status).length
  const describe = call => `${call.file}:${call.line}\t${call.callee}${call.locale ? `(${call.locale})` : ''}`
  const lines = [
    `Japanese copy coverage${prefix ? ` under ${prefix}` : ''}: ${counted.length} calls, ${total('translated')} with Japanese, ${total('missing')} missing, ${total('undetermined')} undetermined; ${calls.length - shared.length} calls to local wrappers skipped`,
    `Run code (no Japanese; copy follows the run language and is stored): ${runCode.length} calls under ${RUN_CODE_ROOTS.join(', ')}`,
    `Frozen copy locale (never shows Japanese): ${shared.filter(call => !isRunCode(call.file) && call.status === 'copy-locale').length} calls whose first argument is copyLocale(...) or useLocaleStore.getState().locale`,
    'Other localize/mainText calls count as missing even when their first argument is a frozen copy locale held in a variable; without type information the checker cannot tell it from an interface locale.',
    '',
    'By top-level directory (missing / calls):',
    ...countBy(counted, call => call.file.split('/').slice(0, 2).join('/')).map(([group, entry]) => `  ${group}\t${entry.missing} / ${entry.calls}`),
    '',
    'By directory (missing / calls):',
    ...countBy(counted, call => path.posix.dirname(call.file)).map(([group, entry]) => `  ${group}\t${entry.missing} / ${entry.calls}`),
    '',
    'Missing Japanese:',
    ...counted.filter(call => call.status === 'missing').map(describe),
    '',
    'Undetermined (spread arguments, or a lone variable after the English copy):',
    ...counted.filter(call => call.status === 'undetermined').map(describe),
  ]
  console.log(lines.join('\n'))
  const violations = jaViolations(calls)
  if (violations.length > 0) {
    console.error(`\nFound ${violations.length} Japanese copy problem(s):\n${violations.join('\n')}`)
    return 1
  }
  return 0
}

export function collectI18nCoverageViolations(root = process.cwd()) {
  const violations = jaViolations(collectJaCopyCalls(root))
  const rendererRoots = [
    ...I18N_COVERAGE_BOUNDARIES.rendererRoots,
    ...I18N_COVERAGE_BOUNDARIES.rendererErrorBoundaries,
  ]
  const scannedRendererFiles = new Set()
  for (const relative of rendererRoots) {
    for (const file of filesAt(path.join(root, relative))) {
      if (relativePath(root, file).split('/').includes('__tests__')) continue
      if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue
      if (scannedRendererFiles.has(file)) continue
      scannedRendererFiles.add(file)
      const source = fs.readFileSync(file, 'utf8')
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      )
      inspectRendererFile(violations, root, file, sourceFile)
    }
  }
  for (const relative of I18N_COVERAGE_BOUNDARIES.mainReturnErrorBoundaries) {
    const file = path.join(root, relative)
    if (!fs.existsSync(file)) continue
    const source = fs.readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    inspectMainReturnErrors(violations, root, file, sourceFile)
  }
  const commandFiles = new Set(I18N_COVERAGE_BOUNDARIES.workflowCommandErrorBoundaries.flatMap(relative => filesAt(path.join(root, relative))))
  const workflowFiles = new Set([...commandFiles, ...I18N_COVERAGE_BOUNDARIES.workflowErrorBoundaries.flatMap(relative => filesAt(path.join(root, relative)))])
  for (const file of workflowFiles) {
    const relativeFile = relativePath(root, file)
    if (!file.endsWith('.ts') || relativeFile.split('/').includes('__tests__')) continue
    const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const allowErrorCodes = !I18N_COVERAGE_BOUNDARIES.strictWorkflowCommandErrorBoundaries.includes(relativeFile)
    inspectThrownErrors(violations, root, file, sourceFile, commandFiles.has(file) ? 'command' : 'untranslated', allowErrorCodes)
  }
  const rendererThrowFiles = new Set(I18N_COVERAGE_BOUNDARIES.rendererThrowErrorBoundaries.flatMap(relative => filesAt(path.join(root, relative))))
  for (const file of rendererThrowFiles) {
    if (workflowFiles.has(file) || !/\.tsx?$/u.test(file) || testOrDeclarationFile.test(file)) continue
    if (relativePath(root, file).split('/').includes('__tests__')) continue
    const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    inspectThrownErrors(violations, root, file, sourceFile, 'chinese', true)
  }
  for (const file of new Set(I18N_COVERAGE_BOUNDARIES.rendererErrorDisplayBoundaries.flatMap(relative => filesAt(path.join(root, relative))))) {
    const relativeFile = relativePath(root, file)
    if (!/\.tsx?$/u.test(file) || testOrDeclarationFile.test(file) || relativeFile.split('/').includes('__tests__')) continue
    const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    inspectRawErrorDisplays(violations, root, file, sourceFile)
  }
  compareMainErrorBaseline(collectMainErrorSites(root, violations), readMainErrorBaseline(root), violations)
  return violations
}

export function updateMainErrorBaseline(root = process.cwd()) {
  const violations = []
  const sites = collectMainErrorSites(root, violations)
  const counts = compareMainErrorBaseline(sites, readMainErrorBaseline(root), violations)
  const blocking = violations.filter(violation => !violation.includes('[main-error-baseline-stale]'))
  if (blocking.length > 0 && fs.existsSync(path.join(root, MAIN_ERROR_BASELINE_PATH))) {
    console.error(`Refusing to raise the main-process error baseline:\n${blocking.join('\n')}`)
    return 1
  }
  const total = Object.values(counts).flatMap(owners => Object.values(owners)).reduce((sum, count) => sum + count, 0)
  const baseline = {
    description: 'electron/ 里只有中文、尚未改成错误码或按语言文案的报错（#474）。按文件与所在函数计数，只减不增；由 node scripts/check-i18n-coverage.mjs --update-baseline 生成。',
    total,
    files: counts,
  }
  const baselineFile = path.join(root, MAIN_ERROR_BASELINE_PATH)
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true })
  fs.writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
  console.log(`Main-process error baseline written: ${total} site(s) in ${Object.keys(counts).length} file(s)`)
  return 0
}

export function runI18nCoverageCheck(root = process.cwd()) {
  const violations = collectI18nCoverageViolations(root)
  if (violations.length > 0) {
    console.error(`Found ${violations.length} unlocalized visible strings:\n${violations.join('\n')}`)
    if (violations.some(violation => violation.includes('[english-plural]'))) console.error(pluralHint)
    return 1
  }
  console.log('i18n coverage check passed: no unlocalized renderer or main-boundary copy')
  return 0
}

export function listMainErrorSites(root = process.cwd()) {
  const sites = collectMainErrorSites(root, [])
  for (const site of sites) console.log([`${site.file}:${site.line}`, site.owner, site.text].join('\t'))
  console.log(`${sites.length} Chinese-only main-process error site(s)`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--update-baseline')) process.exitCode = updateMainErrorBaseline()
  else if (process.argv.includes('--list-main-errors')) process.exitCode = listMainErrorSites()
  else if (process.argv.includes('--ja-report')) {
    const area = process.argv[process.argv.indexOf('--ja-report') + 1]
    process.exitCode = reportJapaneseCoverage(process.cwd(), area?.startsWith('--') ? '' : area)
  }
  else process.exitCode = runI18nCoverageCheck()
}
