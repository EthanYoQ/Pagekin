import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * 登记错误按传进去的语言查目录。日文界面下 store 的 `locale` 是文案语言 en-US，
 * 把它传进来，报错就是英文；`Locale` 是 `InterfaceLocale` 的子集，tsc 拦不住。
 * 显示时一律传 currentInterfaceLocale()，冻结了文案语言的运行用 interfaceLocaleFor()。
 * 其余实参只认下面登记过的：运行里写进记录与日志的冻结语言，和转手目录函数的参数。
 * 新出现的实参先判断属于哪一类，再登记。
 */
const LIVE = /^(?:\{ uiLocale: )?(?:currentInterfaceLocale\(\)|interfaceLocaleFor\(.+\))(?: \})?$/u

const REGISTERED: Record<string, string[]> = {
  'src/components/dialogs/use-batch-chapter-form.ts': ['frozenLocale'],
  'src/components/panels/ai-output-failure-presentation.ts': ['locale'],
  'src/services/agent/agent-engine.ts': ['context.uiLocale'],
  'src/services/generation/prompt-budget-failure.ts': ['locale'],
  'src/services/agent/tools/project-context.ts': ['context?.writingLanguage ?? DEFAULT_WRITING_LANGUAGE'],
  'src/services/workflows/batch-chapter-workflow.ts': ['{ uiLocale }'],
  'src/services/workflows/commands/analyze-style.command.ts': ['context'],
  'src/services/workflows/commands/architecture.command.ts': ['context', 'context.uiLocale'],
  'src/services/workflows/commands/base-command.ts': ['context.uiLocale'],
  'src/services/workflows/commands/directory.command.ts': ['context.uiLocale'],
  'src/services/workflows/commands/finalize-chapter.command.ts': ['context'],
  'src/services/workflows/commands/generate-draft.command.ts': ['context', 'context.uiLocale', "context.uiLocale ?? 'zh-CN'"],
  'src/services/workflows/commands/import-novel.command.ts': ['context', 'context.uiLocale'],
  'src/services/workflows/creative-workflow-launcher.ts': ['uiLocale'],
  'src/services/workflows/directory-character-sync-recovery.ts': ['{ uiLocale }'],
  'src/services/workflows/directory-workflow.ts': ['uiLocale', '{ uiLocale }'],
  'src/services/workflows/import-run-orchestrator.ts': ['run.locale'],
  'src/services/workflows/planning-material-workflow.ts': ['{ uiLocale }'],
  'src/services/workflows/structured-batch-executor.ts': ['writingLanguage'],
  'src/services/workflows/workflow-project-session.ts': ['context.uiLocale'],
  'src/services/workflows/workflow-utils.ts': ['uiLocale'],
  'src/stores/locale-store.ts': ['fallback'],
  'src/stores/workflow-store.ts': ['context.uiLocale', 'run.uiLocale', 'targetRun.uiLocale', 'uiLocale'],
}

/** 目录函数与语言实参的位置。 */
const LOCALE_ARGUMENT: Record<string, number> = {
  appErrorMessage: 0,
  displayedErrorMessage: 0,
  importGenerationStopMessage: 0,
  knownAppErrorMessage: 0,
  legacyImportFailureMessage: 0,
  providerContextFailureText: 1,
  workflowMainProcessError: 0,
}

const ROOT = join(__dirname, '..', '..', '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path)
    return /\.tsx?$/u.test(entry.name) && !/\.(?:test|browser)\.tsx?$/u.test(entry.name) ? [path] : []
  })
}

function localeArguments(): Record<string, string[]> {
  const found: Record<string, Set<string>> = {}
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const name = relative(ROOT, file).split(sep).join('/')
    if (name === 'src/i18n/app-errors.ts') continue
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const position = LOCALE_ARGUMENT[node.expression.text]
        const argument = position === undefined ? undefined : node.arguments[position]
        const text = argument?.getText(source).replace(/\s+/gu, ' ')
        if (text && !LIVE.test(text)) (found[name] ??= new Set()).add(text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)).map(([file, texts]) => [file, [...texts].sort()]))
}

describe('登记错误的语言实参', () => {
  it('显示时按界面语言查目录，冻结文案语言的调用点都登记过', () => {
    expect(localeArguments()).toEqual(Object.fromEntries(Object.entries(REGISTERED).map(([file, texts]) => [file, [...texts].sort()])))
  })
})
