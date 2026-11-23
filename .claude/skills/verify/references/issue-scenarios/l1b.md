## l1b-scenarios.mjs 的场景（原记在「定稿加速（#702）」）

场景在 `scripts/redesign/l1b-scenarios.mjs`。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `l1b-kb-rebuild-unregistered` | 设置·检索模型点「检查并重建向量索引」，主进程的 `kb:backfill-vectors` 换成回未登记码 `EMBEDDING_SPACE_VERIFY_FAILED`：提示只有「重建检索失败」，不带码名；渲染端控制台记一行「[app-errors] 未登记文案的错误码：EMBEDDING_SPACE_VERIFY_FAILED」（`l1b-kb-rebuild-unregistered`） | 设置（中文） | 是 | #702 |
