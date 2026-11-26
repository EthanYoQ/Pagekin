const LANCEDB_SYNTAX = {
  selector: "ImportExpression[source.value='@lancedb/lancedb'], CallExpression[arguments.0.value='@lancedb/lancedb']",
  message: '经 electron/lance-database.ts 打开 LanceDB，新表格式钉在那里。',
}
const EMPTY_CATCH_SYNTAX = {
  selector: 'CatchClause[body.body.length=0]',
  message: '空 catch 会吞掉失败：让错误传到上层，或改用 src/shared/ignore-failure.ts 的 ignoreFailure 记一行日志。',
}
const EMPTY_CATCH_FREE_FILES = [
  'src/services/agent/skill-registry.ts',
  'src/services/agent/tools/read-project-state.tool.ts',
  'src/services/project-clear-service.ts',
  'src/services/workflows/chapter-workflow.ts',
  'src/services/workflows/commands/generate-draft.command.ts',
  'src/shared/character-proposal-parser.ts',
  'src/shared/writing-skills.ts',
  'src/stores/agent-store.ts',
  'src/stores/character-store.ts',
  'src/stores/draft-store.ts',
  'src/stores/editor-unsaved.ts',
  'src/stores/mcp-store.ts',
]
const EMPTY_CATCH_SCRIPT_SYNTAX = {
  selector: EMPTY_CATCH_SYNTAX.selector,
  message: '空 catch 会吞掉失败：让错误传到上层，或改用 ignoreFailure 记一行日志（脚本用 scripts/lib/ignore-failure.mjs，vitest 测试用 src/shared/ignore-failure.ts）。',
}
const EMPTY_CATCH_FREE_SCRIPTS = [
  'scripts/check-i18n-coverage.mjs',
  'scripts/f05-u01-transitions-journey.mjs',
  'scripts/f05-u06-editor-journey.mjs',
  'scripts/f05-u11-graph-profile-journey.mjs',
  'scripts/probe-legacy-project-open.mjs',
  'scripts/quality-modernization-driver.mjs',
  'scripts/real-provider-generation-qualification.mjs',
  'scripts/redesign/fspeed-scenarios.mjs',
  'scripts/redesign/perf702-scenarios.mjs',
  'scripts/redesign/preview-speed-scenarios.mjs',
  'scripts/redesign/scenarios.mjs',
  'scripts/redesign/trash-scenarios.mjs',
  'scripts/run-continuity-calibration.mjs',
  'scripts/windows-in-app-update-e2e-driver.mjs',
  'scripts/__tests__/release-win-verify.test.ts',
]
const EMPTY_CATCH_FREE_SCRIPT_TESTS = [
  'scripts/__tests__/probe-legacy-project-open.node.mjs',
  'scripts/__tests__/quality-modernization-run.test.mjs',
  'scripts/__tests__/quality-modernization-stream-settlement.test.mjs',
]
const LISTING_MESSAGE = '测试列仓库源码改用 test/helpers/repo-source-files.ts 的 repoSourceFiles()，列临时目录改用 test/helpers/temporary-directory.ts 的 listTemporaryDirectory()。'
const LISTING_PRIMITIVES = ['readdir', 'readdirSync', 'opendir', 'opendirSync', 'glob', 'globSync', 'readDirectory']
const LISTING_MODULES = ['glob', 'fast-glob', 'globby', 'tinyglobby']
const listingModule = `/^(?:${LISTING_MODULES.join('|')})$/`
const LISTING_SYNTAX = {
  selector: `ImportSpecifier[imported.name=/^(?:${LISTING_PRIMITIVES.join('|')})$/], CallExpression[callee.name='require'][arguments.0.value=${listingModule}], ImportExpression[source.value=${listingModule}]`,
  message: LISTING_MESSAGE,
}

module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'plugin:react-hooks/recommended', 'plugin:storybook/recommended'],
  ignorePatterns: ['dist', 'dist-electron', 'build', 'docs', 'plugins', '.eslintrc.cjs', '!.release'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx'],
      excludedFiles: ['electron/lance-database.ts', '**/__tests__/**', '**/*.test.ts', '**/*.test.tsx', 'scripts/**', 'test/**'],
      rules: {
        '@typescript-eslint/no-restricted-imports': ['error', {
          paths: [{ name: '@lancedb/lancedb', allowTypeImports: true, message: '经 electron/lance-database.ts 打开 LanceDB，新表格式钉在那里。' }],
        }],
        'no-restricted-syntax': ['error', LANCEDB_SYNTAX],
      },
    },
    {
      files: EMPTY_CATCH_FREE_FILES,
      rules: {
        'no-restricted-syntax': ['error', LANCEDB_SYNTAX, EMPTY_CATCH_SYNTAX],
      },
    },
    {
      files: ['**/*.mjs'],
      env: { node: true },
      rules: {
        '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
        'react-hooks/rules-of-hooks': 'off',
      },
    },
    {
      files: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'test/**'],
      excludedFiles: ['test/helpers/repo-source-files.ts', 'test/helpers/temporary-directory.ts', ...require('./test/directory-listing-baseline.json')],
      rules: {
        'no-restricted-imports': ['error', { paths: LISTING_MODULES.map(name => ({ name, message: LISTING_MESSAGE })) }],
        'no-restricted-properties': ['error', ...LISTING_PRIMITIVES.map(property => ({ property, message: LISTING_MESSAGE }))],
        'no-restricted-syntax': ['error', LISTING_SYNTAX],
      },
    },
    {
      files: EMPTY_CATCH_FREE_SCRIPTS,
      rules: {
        'no-restricted-syntax': ['error', EMPTY_CATCH_SCRIPT_SYNTAX],
      },
    },
    {
      files: EMPTY_CATCH_FREE_SCRIPT_TESTS,
      rules: {
        'no-restricted-syntax': ['error', LISTING_SYNTAX, EMPTY_CATCH_SCRIPT_SYNTAX],
      },
    },
  ],
}
