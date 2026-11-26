# 剧情树是可重建的只读派生快照

剧情树从情节大纲、章节蓝图、已定稿章节摘要及人工确认的叙事线索中归纳主线、支线和章节事件。它只用于可视化与来源导航，不参与正文提示词，也不反写大纲、蓝图、叙事线索或定稿事实。

快照保存在项目数据库中，可以清空或重新生成。每个事件必须引用当前项目中存在的蓝图、定稿章节或叙事线索；完整结构在持久化前统一校验。模型调用或结构校验失败时保留上一次成功快照；来源内容版本与快照不一致时只提示需要刷新，不自动调用模型。

这一边界避免把 AI 归纳变成第二套项目事实源。未来若允许从图上编辑剧情，应先把编辑动作路由到现有权威事实，再重新生成快照，而不是直接修改派生图。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/plot-tree.ts`

- `MAX_PLOT_TREE_CHAPTER_NUMBER`：不可变快照的安全上限，与项目当前来源范围无关（原文：Immutable snapshot safety ceiling, independent of the project's current source range.）
- `storedSnapshotInvalid`：损坏或结构不安全的已存快照被隔离而未删除（原文：A corrupt or structurally unsafe stored snapshot was isolated without deleting it.）
- `hasUsablePlotTreeEventSource`：当且仅当至少一条当前事实能合法支撑剧情树事件才为真（原文：True only when at least one current fact can legally support a plot-tree event.）
- 拒绝超出当前权威来源域的模型控制的轨道范围（原文：Rejects model-controlled track ranges that exceed the current authoritative source domain.）
- 校验已持久快照，不要求其历史来源仍存在（原文：Validates a persisted snapshot without requiring its historical sources to still exist.）
- 对照项目当前来源校验新生成的快照（原文：Validates a newly generated snapshot against the project's current sources.）
