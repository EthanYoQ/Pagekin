## prh1-scenarios.mjs 的场景（#845 PR-H1）

| 场景 | 内容 | 截图 | 模型 | 来源 |
|---|---|---|---|---|
| `prh1-merge-failure-en` | 中文界面审稿、修稿、稍后再合并；换英文界面后把主进程的 `db:revision-merge` 换成返回登记码 `REVISION_NOT_PENDING`，点「Finish merge」：通知是「Could not merge the revision.」加上该码的英文说明，不夹中文、不露码 | 合并失败通知 | 是 | #922 |
| `prh1-prompt-unreadable-en` | 项目 `.ai-novel/prompts/consistency_check.json` 只有 key（主进程只核对 key 与语言会放行，渲染端判为结构不对）；英文界面点「AI review」：运行卡片给文件路径加目录文案「The prompt file has an invalid structure.」。坏 JSON 会先在主进程失败成通用句，走不到渲染端诊断，解析器原文由 node 测试 `项目提示词读不出时显示目录说明，不显示解析器原文` 覆盖 | 运行卡片 | 否 | #845 |
