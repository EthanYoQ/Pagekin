# 版本化项目嵌入空间

每个项目同一时刻只激活一个有版本的嵌入空间，空间身份包含模型指纹、向量维度、比较语义和索引代际；同一向量集合不得混入不同空间的数据。写入前必须验证批次数量、统一维度和全部有限数值，首次向量按实际维度创建 schema。模型或维度变化时不得追加、删除旧表或静默转换，而是保留旧代际、维持全文检索并标记需要重建；新代际完成验证后才能原子切换为 active，避免跨模型语义污染和用户数据损坏。

## 界面组件口径（注释清理 #852 第 5 个 PR，src/components）

### `src/components/pages/knowledge-rebuild-presentation.ts`

- `getVectorRebuildPresentation`：规则：确认主进程有可用嵌入模型之前故意不出现重建动作，状态检查本身从不联系该服务商（原文：The rebuild action is intentionally absent until the main process confirms that a usable embedding model is configured. The status check itself never contacts that provider.）
