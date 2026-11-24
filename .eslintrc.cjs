const LANCEDB_SYNTAX = {
  selector: "ImportExpression[source.value='@lancedb/lancedb'], CallExpression[arguments.0.value='@lancedb/lancedb']",
  message: '经 electron/lance-database.ts 打开 LanceDB，新表格式钉在那里。',
}
const IPC_HANDLE_SYNTAX = {
  selector: "Identifier[name='ipcMain'], MemberExpression[computed=true] > Literal.property[value='ipcMain']",
  message: '不要直接拿 ipcMain，注册 IPC 处理器改用 electron/ipc/handle.ts 的 handle()：没登记的失败只进主进程日志，渲染端拿通用码。',
}
const LISTING_MESSAGE = '测试列仓库源码改用 test/helpers/repo-source-files.ts 的 repoSourceFiles()，列临时目录改用 test/helpers/temporary-directory.ts 的 listTemporaryDirectory()。'
const LISTING_PRIMITIVES = ['readdir', 'readdirSync', 'opendir', 'opendirSync', 'glob', 'globSync', 'readDirectory']
const LISTING_MODULES = ['glob', 'fast-glob', 'globby', 'tinyglobby']
const listingModule = `/^(?:${LISTING_MODULES.join('|')})$/`

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
        'no-restricted-syntax': ['error', LANCEDB_SYNTAX, IPC_HANDLE_SYNTAX],
      },
    },
    {
      // 存量直接注册 IPC 的文件只减不增（test/ipc-handle-guard.test.ts 核对），迁到 handle() 后从名单删掉。
      files: ['electron/ipc/handle.ts', ...require('./electron/ipc/direct-handle-baseline.json')],
      rules: {
        'no-restricted-syntax': ['error', LANCEDB_SYNTAX],
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
        'no-restricted-syntax': ['error', {
          selector: `ImportSpecifier[imported.name=/^(?:${LISTING_PRIMITIVES.join('|')})$/], CallExpression[callee.name='require'][arguments.0.value=${listingModule}], ImportExpression[source.value=${listingModule}]`,
          message: LISTING_MESSAGE,
        }],
      },
    },
  ],
}
