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
