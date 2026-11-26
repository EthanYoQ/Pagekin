# 跨进程契约：IPC 频道、项目会话、事件总线与启动确认

2026-11-26，注释清理（#852）第 3 个 PR（src/shared）。

## 背景

`src/shared/ipc-channels.ts`、`event-bus.ts`、`project-session-context.ts`、`project-storage.ts`、`startup-contract.ts` 等文件是渲染进程与主进程之间的类型安全契约。字段上的注释记录了哪些值由主进程签发、哪些由渲染端提供、哪些只作显示。

## 决定

渲染进程只携带授权标识、冻结的会话与受限相对路径，不携带外部绝对路径，也不自行证明来源；身份、来源哈希与预算归主进程。事件与工作流一律带冻结的项目会话，同路径重开后的旧事件必须丢弃。不可变快照用于结算，不回读数据库覆盖编辑器。频道名与参数、返回类型都登记在 `ipc-channels.ts`。下面按文件列出各条口径。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/character-avatar.ts`

- `MAX_CHARACTER_AVATAR_INPUT_BYTES`：项目级角色头像的跨进程契约（原文：Cross-process contract for project-scoped character avatars.）

### `src/shared/desktop-api.ts`

- `AiNovelAPI`：唯一的桌面桥由 preload 暴露，项目授权留在主进程（原文：The single desktop bridge exposed by preload. Project authorization stays in main.）

### `src/shared/event-bus.ts`

- 全局事件总线 — 统一解耦业务层（Service/Command/Workflow）与视图层（React/Zustand） 所有跨模块事件都通过此总线分发，组件不再直接使用 window.dispatchEvent。 事件由 ProjectService 统一消费，驱动 Store 更新，组件只需订阅 Store 数据。
- --- 架构文件单步更新（每步生成完触发） ---
- --- 定稿完成（替代原 vela:finalize-complete） ---
- --- 章节删除收据变化（包括待人工确认和部分清理失败） ---
- --- 规划恢复稿的去留变了（作者放弃了一份） ---
- --- 选区建议的回执送达主进程，运行侧页的恢复列表要重读 ---
- `projectPath`：事件生产者开始操作时冻结的项目路径（只作显示/定位，不是身份）。
- `projectSession`：完整冻结身份；同路径重新打开后旧事件必须被丢弃。
- `projectPath`：启动工作流时冻结的项目路径（只作显示/定位，不是身份）。
- `projectSession`：启动工作流时冻结的完整项目会话。
- `runId`：唯一工作流运行身份，用于排除同项目内的其他并发任务。
- `tabId`：触发定稿的编辑器 Tab；完成事件只能结算这个冻结目标。
- `projectPath`：定稿工作流启动时冻结的项目路径。
- `projectSession`：触发定稿时冻结的项目会话，防止同路径重开后的旧结果落到新会话。
- `draftId`：SQLite 事务中提交的草稿和定稿身份。
- `snapshotContent`：绝不从数据库回读来替换编辑器；只用这个不可变快照结算。
- `source`：定稿来源；批量任务不应弹出单章的“下一章创作”对话框

### `src/shared/ipc-channels.ts`

- IPC 频道定义 — 渲染进程与主进程的类型安全通信契约 所有 IPC 调用都通过此文件定义频道名和参数/返回值类型
- `window:notify-stage`：写作、审稿、修稿、定稿结束时调用；窗口在后台且设置开着时才弹系统通知。
- `autoOpenNextChapterAfterFinalize`：定稿与后处理成功后，打开下一章的创作窗口（默认关闭）。
- `backgroundStageNotifications`：书童在后台时，阶段结束弹系统通知（缺省为开）。
- `ExpectedDraftSource`：渲染端捕获的源草稿契约，由主进程写事务重新校验（原文：Renderer-captured source draft contract revalidated by the main-process write transaction.）
- `exportId`：原样回送在进度事件里：同一窗口可能有上一次导出还没停，界面只认自己这次的。
- `PortableExportPhase`：导出与云备份打包的阶段，按顺序：读取作品、检查、整理、打包。资料被改时整次重来，阶段会从头再走一遍。
- `aiSources`：与 novelConfig 并列，只给设定页用。
- `AppPromptTemplate`：固定 app-data 服务使用的提示词数据；文件位置不由渲染进程决定。

### `src/shared/latest-request-gate.ts`

- `LatestRequestGate`：为同一资源的并发读取提供单调请求序号。 每次 begin 都会使之前的 token 失效，因此较早发起、较晚返回的请求 无法覆盖较新的结果。

### `src/shared/official-homepage.ts`

- `OFFICIAL_HOMEPAGE_URL`：唯一经渲染端批准的外部目的地，绝非渲染端提供（原文：The only renderer-approved external destination. It is never renderer supplied.）
- `getOfficialHomepageOpenError`：失败的固定主页意图的渲染端文案放在共享层，使打包资格能证明确切的用户可见回退，而不是在渲染契约外复制一份字符串（原文：Renderer-facing copy for a failed fixed homepage intent. Keeping this shared lets the packaged qualification prove the exact user-visible fallback rather than reproducing a second string outside the renderer contract.）

### `src/shared/project-overview.ts`

- `revision`：不透明的事实修订号，绝不是文件系统路径（原文：Opaque fact revision. It is never a filesystem path.）
- `setupReady`：设定四项必填（核心大纲、类型、篇幅、目标读者）是否齐全，与流程脊的「设定完成」同一口径。
- `plannedChapters`：规划总章数；0 表示还没定。
- `excerpt`：仅当主进程读取已打开的当前项目时才有（原文：Present only when main reads the already-open current project.）

### `src/shared/workflow-resource-claims.ts`

- `resourceKeys`：此工作流可能改动的资源（原文：Resources this workflow may mutate.）
- `readResourceKeys`：此工作流只读、因此可与其他读者共享的资源（原文：Resources this workflow only reads and therefore may share with other readers.）
- `workflowResourceClaimsConflict`：读者可共存，任何写者与同一逻辑资源的其他读者或写者冲突（原文：Readers may coexist. Any writer conflicts with every other reader or writer of the same logical resource.）
