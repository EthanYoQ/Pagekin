export interface GuardTest {
  file: string
  kind: 'scan' | 'named'
  why: string
}

export const GUARD_TESTS: readonly GuardTest[] = [
  { file: 'test/guards.test.ts', kind: 'scan', why: '遍历全部测试文件，核对扫源码的测试都已登记' },
  { file: 'electron/repositories/__tests__/character-continuity-writers.test.ts', kind: 'scan', why: '遍历 electron 源码，写角色状态或关系表的文件只能是登记过的写入方' },
  { file: 'electron/repositories/__tests__/generation-ledger-sql-guard.test.ts', kind: 'scan', why: '遍历 electron 与 src 源码里的 SQL 字面量，跨记录解析的账本 JSON 列必须在进门清单里' },
  { file: 'electron/utils/__tests__/remembered-dialog.test.ts', kind: 'scan', why: '遍历 electron 源码，主进程的文件对话框都要走 remembered-dialog' },
  { file: 'scripts/__tests__/journey-project-schema-version.test.ts', kind: 'scan', why: '遍历 scripts 下的旅程脚本，不许写死项目库版本号' },
  { file: 'scripts/redesign/__tests__/modifier-keys.test.mjs', kind: 'scan', why: '遍历 scripts 下的驱动脚本，不许写死 Control+ 组合键' },
  { file: 'src/__tests__/semantic-status-text-source-contract.test.ts', kind: 'scan', why: '遍历 src 的 tsx 与 css，状态文字不用固定的 Tailwind 色板类' },
  { file: 'src/components/__tests__/icon-contract.test.ts', kind: 'scan', why: '遍历组件与编辑器源码，作者看得到的文字不含 Emoji 或充当图标的符号' },
  { file: 'src/i18n/__tests__/error-catalog-locale-callers.test.ts', kind: 'scan', why: '遍历 src 与 electron 源码，ErrorDisplayLocale 只能在界面语言的来源处造出' },
  { file: 'src/i18n/__tests__/generation-error-codes.test.ts', kind: 'scan', why: '遍历源码里的错误码字面量，每个码都要登记文案或写明不登记的理由' },
  { file: 'src/i18n/__tests__/removed-draft-box-copy.test.ts', kind: 'scan', why: '遍历 src 与 electron 的文案字面量，不再提已删除的草稿箱' },
  { file: 'src/services/__tests__/prompt-project-session.test.ts', kind: 'scan', why: '遍历 src/services/workflows，取提示词模板都要带冻结的项目会话' },
  { file: 'src/shared/__tests__/model-stage-registry.test.ts', kind: 'scan', why: '遍历 src/services 与 electron/services，生成代码发出的每个 operation 都已登记阶段' },
  { file: 'src/shared/__tests__/review-proof.test.ts', kind: 'scan', why: '遍历 electron、src、scripts 源码，审修证明只在 readReviewProof 一处解析' },
  { file: 'electron/__tests__/startup-native-isolation.test.ts', kind: 'named', why: '启动隔离：注册 IPC 时 kb-controller 不得静态导入知识库模块，import type 也算；测试放在 electron/__tests__，改 kb-controller 时按目录找不到它' },
  { file: 'electron/services/__tests__/live-row-sentinel.test.ts', kind: 'named', why: '回收站被删行对全部读取路径不可见；横跨十来个仓库与服务，改其中任何一条读路径都可能让它红' },
]

export const NOT_GUARD_TESTS: readonly Omit<GuardTest, 'kind'>[] = [
  { file: 'scripts/__tests__/release-win-verify.test.ts', why: '遍历的是发版门禁的临时目录；扫中是因为别处有匹配 .mjs 的路径正则' },
]
