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

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/services/agent/agent-engine.ts`

- `projectSession`：字段用途：冻结的项目身份用来渲染并执行已确认的领域提案，类型只写了索引访问（原文：Frozen project identity used to render and execute a confirmed domain proposal.）
- `executionContext`：现行规则：一次 agent 运行只用一个不可变的项目身份，循环后段的 Tool 调用不能借用同路径重开后签发的租约（原文：One agent run gets one immutable project identity. Tool calls later in the loop must not silently borrow a lease issued after a same-path reopen.）

### `src/services/agent/skill-registry.ts`

- `projectSession`：项目级 Skill 必须绑定其加载时的完整项目 lease。
- 从当前项目边界内加载 Skills。 项目路径仍须通过项目会话在主进程重新校验。

### `src/services/agent/tool-registry.ts`

- `projectPath`：工具执行时冻结的来源项目路径，仅用于显示和一致性检查，不单独授予权限。
- `projectSession`：产物必须绑定产生时的完整项目会话；旧 lease 产物不能在重开后复用。
- `AgentExecutionContext`：现行规则：agent 循环或直接 Tool 调用前捕获不可变的项目身份，内置项目工具必须用它而不是现查渲染端活动租约（原文：Immutable project identity captured before an agent loop or direct tool call. Built-in project tools must use this context instead of looking up a new renderer active lease while they are executing.）

### `src/services/generation/generation-runtime.ts`

- `projectSession`：现行规则：项目身份由调用方在任何异步租约工作之前捕获（原文：Project identity captured by the caller before any asynchronous lease work.）

### `src/services/ipc-client.ts`

- `invokeWithProjectSession`：工作流/工具在启动处冻结会话后，必须使用此入口而不是重新读取 currentProject。

### `src/services/project-service.ts`

- `isProjectSessionCurrent`：现行规则：项目范围的事件与打开工作归完整冻结的会话所有，不单按路径，重开同一文件夹产生新租约并使旧事件与结果全部成空操作（原文：Project-scoped events and opening work are owned by the complete frozen session, never by a path alone. Reopening the same folder produces a new lease and must make every old event/result a no-op.）
- `onProjectOpening`：主进程已经成功切换项目、renderer 即将发布新的 currentProject 前调用。 先解除角色数组与旧项目的绑定，避免新项目页面短暂复用旧项目数据。
- 正常关闭只清理对应项目，保留其他项目的未保存草稿。
- 数据库状态未知且 renderer 已无项目身份时，不能保留任何可编辑 Tab。
- `disableProjectBindingsPreservingDrafts`：数据库身份异常时解除可写数据绑定，但保留用户尚未保存的标签页和后台草稿。 项目身份被清空后，这些标签页不会进入编辑器；恢复项目后仍可由用户处理。

### `src/services/prompt-templates.ts`

- `clearProjectCustomPrompts`：项目关闭、切换或新加载开始时立即失效，绝不沿用旧 lease 的覆盖。

### `src/stores/__tests__/character-project-context.test.ts`

- 断言前提：B 取得新租约，所以不等 A 的过期身份变更（原文：B obtains a new lease, so it does not wait for A's stale identity mutation.）

### `src/stores/__tests__/explicit-editor-store-dirty.test.ts`

- A 的完成回调已失去 lease，不能替 B 清理或改写 A 的待保存草稿。

### `src/stores/__tests__/project-close-lifecycle.test.ts`

- `projectSession`：现行规则：打开工作必须拿到与后续 IPC 和事件处理相同的不可变身份，单凭路径相同会让同目录重开的新租约接受过期工作（原文：Opening work must receive the same immutable identity that later IPC and event handlers use. A matching path alone would allow a same-directory reopen with a newer lease to accept stale work.）

### `src/stores/character-store.ts`

- `dataProjectKey`：当前 characters 数组实际归属的项目；为空时禁止任何角色写操作。

### `src/stores/draft-store.ts`

- `beginProjectLoad`：现行规则：在发布新打开的项目之前先解除旧项目数据的绑定（原文：Unbind old project data before publishing a newly opened project.）

### `src/stores/editor-discard.ts`

- `discardAndCloseEditorTab`：放弃一个可见编辑器的修改，并在恢复对应已保存基准后关闭它。 后台账本按项目删除；其他项目的草稿不受影响。
- `discardCurrentProjectEditorChanges`：放弃当前项目的全部未保存编辑。 普通 Tab 通过关闭来丢弃组件内状态；不可关闭的固定 Tab 则恢复已保存内容并清除 dirty。角色、配置和章节蓝图的后台账本按项目清理，其他项目草稿保持不变。

### `src/stores/editor-store.ts`

- `projectKey`：伪协议资源所属项目；用于隔离同一路径在不同项目中的编辑草稿。
- `projectSessionLease`：打开/定稿时冻结的项目会话租约；同一路径重开不能复用旧 tab 的完成事件。
- `clearProjectTabs`：只清理指定项目的 Tab 与后台草稿，保留其他项目的未保存内容。

### `src/stores/navigation/stage-store.ts`

- `session`：这份数据属于哪次打开；同一路径重新打开是新的会话，旧数据不能当新的用。

### `src/stores/project-store.ts`

- `withOpeningNotice`：长篇打开要等一会儿，第一次在新版打开还要升级；开得快时不弹，免得提示一闪而过。
- `ProjectNotice`：停用项目的提示要等清理结束才弹出，弹出时才按当时的界面语言写。
- `toPlainProjectData`：从 currentProject 中提取纯净的 ProjectData 字段， 防止 Zustand 状态中混入非序列化属性导致 Electron IPC structured clone 挂起。
- `sameRendererProject`：UI 身份比较可容忍 Windows 路径表现差异；写入授权仍必须依赖 frozen lease。
- `recentProjectsLoaded`：这次启动已经读到过一次最近项目；读到之前空列表不代表书架是空的。
- `projectSessionEpoch`：每次成功打开项目都递增；同一路径重开也属于新的渲染进程项目会话。
- 创建与打开共享同一渲染进程请求序列。若等待工作流退出期间已有更新的 打开/创建请求提交，或当前项目已经变化，旧创建请求不得再切换主进程数据库。
- 作者点的入口已先确认并收起设置页；外部打开请求、新建后自动打开到这里时设置页可能还开着，换作品会卸载它、丢掉输入。 确认完才领请求序号：确认框开着时被拒的请求不能让还在等确认的那个失效。
- 同一路径重开同样会签发新 lease；旧工作流必须先退出，不能因路径相同而漏掉。
- 必须先解除第二层数据与旧项目的绑定，再向界面发布新项目身份。
- 此后渲染进程已经提交返回项目；过期状态只影响派生视图，可以安全退出。
- `leftThisProject`：每个提示框都画在先弹的上面，所以等作者关掉前一个再弹下一个：报错最先看到。 按会话比：换书失败也会推进请求序号而这本书仍开着，同一会话保存也会换对象。
- 读不到也算读过：书房据此显示空书房，而不是一直停在等待里。
- 删除失败后主进程数据库也未能恢复，继续保留可写界面会制造 “看似打开、实际无数据库”的危险半状态。先解除所有项目绑定。
- 任何 currentProject 提交都会同步刷新 IPC 的默认会话；工作流另行持有自己的冻结副本。

### `src/stores/workflow-store.ts`

- `projectSession`：工作流启动时冻结的 IPC 会话，禁止在执行器内重新读取 currentProject。
- `projectSession`：工作流来源会话。缺失、过期或与项目路径不匹配的定义必须在执行前被拒绝， 禁止按路径借用当前项目的新 lease。
- 现行规则：缺少会话的旧定义在加入活跃运行或执行项目级副作用之前就拒绝，绝不按路径匹配借用 currentProject 的租约（原文：Runtime callers can still deserialize a legacy definition that predates the required TypeScript field. Reject it before adding an active run or executing any project-level side effect; never borrow currentProject's lease based on a matching path.）
