## setdel-scenarios.mjs 的场景（原记在「重排模型配置与回退小字（#279 R3）」）

场景在 `scripts/redesign/setdel-scenarios.mjs`。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `setdel-edit-during-delete` | 主进程删除被挂起时连确认两次删除再点「编辑」；放行后表单关掉、列表只剩默认模型，`llm:delete-model` 收到 2 次且无报错弹窗，模型没被存回 | AI 模型页 | 有 | #279 |
