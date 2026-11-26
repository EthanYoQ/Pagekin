# AI 助手动作必须通过项目事实与工作流 seam

AI 写作助手的普通文件写入只产生助手文件产物，不得以同名 Markdown 暗示已经修改项目事实；故事架构、结构化角色名单、章节蓝图和章节创作必须分别通过既有领域提交或创作工作流 seam。工作流工具只有在前置条件通过、运行被真实注册并能返回绑定项目会话的工作流启动收据后才能报告成功。保留语义目标不允许由通用文件工具覆盖；未来如需导入自由文本，必须采用显式的候选事实、预览校验和原子提交流程，而不是后台反向解析 Markdown。这样牺牲通用文件工具对领域数据的表面灵活性，换取 Agent、编辑器、任务面板和 SQLite 事实源对“成功”的一致理解，并消除导航动作或游离文件被误报为领域变更的故障类别。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/agent-generation.ts`

- `editorContext`：选区与上下文只是显式输入，永远不能替代项目的规范事实（原文：Explicit editor selection/context, never a replacement for canonical project facts.）
- `current`：读取投影是新读到的，历史 ACK 不能覆盖渲染端更新的编辑（原文：Fresh read projection; historical ACK must not overwrite newer renderer edits.）
- `protocolText`：主进程只重建被接受的协议文本，隐藏推理绝不带上（原文：Main reconstructs only the accepted protocol; hidden reasoning is never included.）

### `src/shared/agent-response-protocol.ts`

- `direct`：带标签的调用历史上保留未知工具名，让宿主回「未知工具」观察；解析从不授予工具权限（原文：Tagged calls historically retain unknown names so the host can return the existing unknown-tool observation. Parsing never grants tool authority.）
- 内层包装不能证明外层控制块完整，所以直接判不完整（原文：An inner wrapper cannot prove that an outer control block was complete.）
- 缺开标签的推理没有可证明的可见前缀，所以清空（原文：A missing opening reasoning tag leaves no proven visible prefix.）
- `parseAgentResponseProtocol`：这个解析针对已落定的响应和冻结注册表，不是流式前缀投影，不完整的原始调用仍可能变成动作（原文：Parse a settled response against a frozen registry. This is not a streaming prefix projection: an incomplete raw call may still turn into an action.）
- `cleanAgentProtocolVisibleText`：清理已选中可见响应时保留正文间距（原文：Preserve prose spacing when cleaning an already selected visible response.）
- `projectInterruptedAgentVisibleText`：终止中断可保留正文，但绝不把部分调用升级为工具动作，歧义的原始 JSON 与名字前缀会被扣住（原文：A terminal interruption may retain prose, but never promotes a partial call to a tool action. Ambiguous raw JSON/name prefixes are held back.）

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/services/agent/agent-engine.ts`

- `MAX_TOOL_ROUNDS`：ReAct 循环最大次数（防止死循环）
- `ConfigImpactBlueprintProposal`：字段来历：这是从一次性的小说配置影响预览里选出的单个蓝图差异，接口名只说是蓝图提案（原文：One optional blueprint diff selected from a transient novel-config impact preview.）
- `LLMGenerateFn`：LLM 生成函数签名（由 agent-store 提供实际实现）
- `observationParts`：依次执行每个 tool_call。配置影响预览中明确选择的蓝图差异会在 配置写入成功后插入此轮，并继续走同一条确认与工具执行路径。
- 现行规则：等待确认的卡片已代表这次调用，开始执行后的完成更新同一张卡而不再追加第二张（原文：The waiting confirmation card already represents this call. Its completion below updates that same card instead of appending a second one when execution begins.）
- 现行规则：不需要确认的 Tool 也要有一张可见的生命周期卡片（原文：Non-confirming tools still need one visible lifecycle card.）
- `observation`：将所有 tool 结果作为 user role 的 observation 注入 加上明确提示，防止 LLM 误以为这是用户新发言
- 现行规则：已派发的写入同样只等有限的前台时间，但报告为结果未知而不是已取消或可重试（原文：A dispatched write gets the same finite foreground wait, but is reported as unknown rather than cancelled/retryable.）

### `src/services/agent/context-builder.ts`

- Agent 智能上下文构建器 采用三级注入策略管理 Token 消耗： - L0 始终注入（~500 token）：项目名称/类型/进度/一句话大纲 - L1 编辑器感知（~800 token）：当前打开的 Tab 信息 - L2 按需获取：通过 Tool 调用获取详细数据 这是 Agent 理解用户上下文的核心模块。
- `outline`：截取前 300 字符，避免 Token 爆炸

### `src/services/agent/tool-registry.ts`

- Vela Agent Tool 注册表 统一管理所有 Agent 可调用的工具（内置 Tool / MCP Tool / Skill Tool）。 参考 Claude Code 的 Tool 系统设计，但针对小说创作场景做了精简。 设计要点： 1. 统一的 AgentTool 接口 — 无论来源，Agent Engine 只看到这一个接口 2. requiresConfirmation 字段控制安全性 — 只读工具自动执行，写入工具需用户确认 3. source 字段标识来源 — 方便 UI 渲染不同的视觉标记
- `runId`：现行规则：工作流产物本身就是可观察的启动回执（原文：A workflow artifact is itself an observable launch receipt.）
- `commitState`：现行规则：持久写入结果与传输或界面层的成败正交，单独成字段（原文：Persistent write outcome; orthogonal to transport/UI success.）
- `resultOffset`：content 是该工具完整结果从这个字符位置起的部分；带此字段的工具接受 offset 参数续读。
- `agentToolAction`：现行规则：动作凭证由宿主签发，模型参数永远不提供生成谱系（原文：Host-issued action proof; model arguments never supply generation lineage.）
- `agentGeneration`：字段边界：仅主进程的 Agent 生命周期适配器，由当前会话宿主挂上（原文：Main-only Agent lifecycle adapter, attached by the active conversation host.）
- `selectedModelId`：现行规则：本轮模型由作者明确选定并在 LLM 工具参数之外捕获，模型回复不能选择计费模型（原文：Model explicitly selected for this Agent turn. It is captured outside of LLM tool arguments so a model response cannot choose a billable model.）
- `abortSignal`：现行规则：每次 Tool 调用有自己的取消信号，写入类工具在跨过提交点之前检查它（原文：One tool call's cancellation signal; write tools check it before crossing their commit point.）
- `markSideEffectStarted`：字段用途：标记此后传输失败不能再报告成干净回滚的那个时间点（原文：Marks the point after which a transport failure cannot be reported as a clean rollback.）
- `name`：唯一标识符（MCP Tool 使用 mcp__serverId__toolName 命名空间）
- `description`：Tool 用途描述（Agent 凭此决定何时调用）
- `requiresConfirmation`：是否需要用户确认后才执行（写入型操作 = true）
- 注销某个来源的所有 Tool（例如 MCP 断开连接时）

### `src/services/agent/tools/index.ts`

- 内置 Tool 汇总注册 将所有内置 Tool 注册到 ToolRegistry。 在 Agent 初始化时调用 registerBuiltinTools()。
- 只读 Tool（自动执行）
- 行动 Tool（需确认）
- `registerBuiltinTools`：注册所有内置 Tool 在 Agent 模块初始化时调用

### `src/services/agent/tools/project-context.ts`

- `assertAgentToolActive`：位置约定：这是渲染端在 Agent Tool 开始可观察副作用之前的最后一道关（原文：Last renderer-side gate before an Agent tool starts an observable side effect.）

### `src/services/agent/tools/read-drafts.tool.ts`

- 默认查询回来是按 version 倒序排列的

### `src/services/agent/tools/safe-path.ts`

- 路径安全校验工具 防止路径遍历攻击（../../ 等），确保所有文件操作都在项目根目录内。
- `segments`：拆分路径段并手动 resolve（不依赖 Node path 模块，因为运行在渲染进程）

### `src/stores/agent-store.ts`

- `mainGenerationHandle`：现行规则：这是精确的持久 Agent 导航，渲染端不持有候选镜像（原文：Exact durable Agent navigation; no renderer-owned candidate mirror.）
- `modelId`：当前会话使用的模型 ID（null 表示使用默认）
- `conversations`：所有会话列表（最新的排在前面）
- `resumeGeneration`：现行规则：显式恢复原来的 Agent 回合，包括它持久化的 Tool 调用（原文：Explicitly recover the original Agent turn, including its durable tool calls.）
- `modelId`：现行规则：modelId 为 null 表示运行开始时用一次默认模型，运行时再在整个 ReAct 循环里冻结所选租约（原文：Null means “use the default once when a run starts”; the runtime then freezes the selected lease across the entire ReAct loop.）
- /status → 直接将 read_project_state 的结果展示 不拦截，作为普通消息让 Agent 处理（它会调用 read_project_state）
- P1-8: 清理所有等待确认的 Promise，防止内存泄漏

### `src/stores/mcp-store.ts`

- `isReadOnly`：MCP Tool 默认需要确认（保守策略）

### `src/stores/workflow-store.ts`

- `agentWorkflowRegistration`：现行规则：主进程校验过的 Agent Tool 登记，与模型可编辑的意图分开（原文：Main-validated Agent tool registration, separate from model-editable intent.）
- `generationModelId`：现行规则：草稿工作流的模型选择由渲染端持有，绝不能从 LLM 工具参数填充（原文：Renderer-owned model selection for a draft workflow. It must never be populated from LLM tool arguments.）
- `requiresConfirmation`：现行规则：即使工作流自动运行也要作者显式确认（原文：Explicit author action is required even when the workflow runs automatically.）

## 界面组件口径（注释清理 #852 第 5 个 PR，src/components）

### `src/components/panels/agent/ArtifactCard.tsx`

- ArtifactCard — 产物卡片 当 Agent 创建/修改文件或触发工作流时， 显示可点击的产物卡片，用户可直接跳转到对应资源。

### `src/components/panels/agent/ConfirmCard.tsx`

- ConfirmCard — 操作确认卡片 当 Agent 调用需要确认的 Tool 时显示此卡片。 用户可以批准或拒绝操作。

### `src/components/panels/agent/MentionMenu.tsx`

- `query`：搜索关键词（@ 后面的文字）

### `src/components/panels/agent/SlashCommandMenu.tsx`

- `query`：搜索关键词（/ 后面的文字）
