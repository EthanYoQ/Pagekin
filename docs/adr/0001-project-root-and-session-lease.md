# 项目根目录与项目会话租约

项目身份由稳定的项目 ID、经真实路径解析的项目根目录和每次打开新发放的项目会话租约共同构成；裸路径只表示位置，不再授予写入或删除权限。所有项目级 IPC、工作流、知识库、文件操作和删除请求必须关联主进程签发的有效租约，同一路径重新打开也会使旧租约失效。打开现有项目必须先执行无副作用探测，只有具备有效项目清单或符合受控旧项目迁移条件的目录才能成为项目根目录；删除只接受已验证项目的当前租约，绝不接受任意路径。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/ipc-channels.ts`

- `ProjectSessionContext`：一次打开项目时由主进程签发并冻结的跨进程会话身份。 projectPath 仅用于主进程的规范根目录校验，不能单独授予访问权限。
- `sessionLease`：主进程签发；仅与 id 组合为会话凭据，path 不是授权。

### `src/shared/project-format.ts`

- `CANONICAL_PROJECT_DIRECTORY`：清单、物理存储与 SQLite schema 版本是三个独立契约（原文：Manifest, physical storage, and SQLite schema versions are separate contracts.）

### `src/shared/project-paths.ts`

- 项目目录结构常量 全量 DB 化后，项目根目录只剩下： 1. 定稿后的 .txt 投影文件 2. .ai-novel 隐藏目录（包含数据库与模板）
- `CoreResourceKey`：虚拟 DB 资源不是文件系统能力，旧输入只读（原文：Virtual DB resources are not filesystem capabilities. Legacy input is read-only.）

### `src/shared/project-session-context.ts`

- `isProjectSessionContext`：冻结的项目会话在 IPC 与工作流状态间传输的运行时边界，授权仍归 ProjectAccess（原文：Runtime boundary for a frozen project session transported across IPC and workflow state. Authorization remains the responsibility of ProjectAccess.）
- `projectPathKey`：Renderer 侧的 Windows 路径身份键。 这里刻意不访问文件系统：它只消除 UI 状态中大小写、分隔符、`.`/`..` 与尾部分隔符 带来的等价路径漂移。真正的符号链接/短路径/磁盘大小写规范化仍由主进程 ProjectAccess 的 canonical root 校验负责。
- Windows 扩展长度路径与普通路径语义相同，去掉设备前缀后保留 UNC，权威 IO 规范化仍归主进程（原文：Windows extended-length paths are semantically the same project path for renderer-state comparison. Preserve regular UNC paths after removing the device prefix, while leaving the main process to perform authoritative IO canonicalisation.）
- `protectedSegments`：UNC 共享根不能被词法 .. 越过（原文：A UNC share root is `\\server\\share`; do not let a lexical `..` escape it.）
- `setActiveProjectSessionContext`：Renderer 唯一的当前会话登记处；写入时复制并冻结，避免异步任务借用后续会话。

### `src/shared/project-storage.ts`

- `MIGRATION_IDS`：仅业务 ID，数字 PRAGMA 版本属于 electron/migrations/registry（原文：Business IDs only. Numeric PRAGMA versions belong to electron/migrations/registry.）
- `assertDistinctStorageRoots`：证明必须来自主进程的 realpath、reparse 与能力探测，绝非渲染端断言（原文：Proofs must come from main's realpath/reparse/capability probe, never renderer assertions.）
- `sourceCurrent`：允许的内容来源须从恢复的资产重新校验，不是旧的执行收据（原文：Exact allowed content source revalidated from restored assets, not an old execution receipt.）
- `reservedTokens`：未知派发保留其旧负债，恢复从不释放或重发（原文：Unknown dispatch retains its old liability; restore never releases or resends it.）
- `mayReplayTransferredExecution`：导入的历史不是模型、正式提交、outbox、导入或发布能力（原文：Imported history is not a model, formal-commit, outbox, import or publication capability.）
- 每个导入的执行无论记录状态都保持不可重放（原文：Every imported execution remains non-replayable, regardless of its recorded status.）
