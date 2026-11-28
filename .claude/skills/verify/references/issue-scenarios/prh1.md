## prh1-scenarios.mjs 的场景（#845 PR-H1）

| 场景 | 内容 | 截图 | 模型 | 来源 |
|---|---|---|---|---|
| `prh1-merge-failure-en` | 中文界面审稿、修稿、稍后再合并；换英文界面后把主进程的 `db:revision-merge` 换成返回登记码 `REVISION_NOT_PENDING`，点「Finish merge」：通知是「Could not merge the revision.」加上该码的英文说明，不夹中文、不露码 | 合并失败通知 | 是 | #922 |
| `prh1-prompt-unreadable-en` | 项目 `.ai-novel/prompts/consistency_check.json` 只有 key（主进程只核对 key 与语言会放行，渲染端判为结构不对）；英文界面点「AI review」：运行卡片给出带文件名的说明「The prompt file "consistency_check.json" cannot be read or is malformed…」并指到「Prompt templates」 | 运行卡片 | 否 | #845、#935 |
| `prh1-prompt-bad-json-en` | 同一文件写成坏 JSON；英文界面点「AI review」：主进程生成准入先失败，运行卡片给「The custom prompt for this step cannot be read or is malformed…」并指到「Prompt templates」（抛出过 IPC 只带码，不带文件名），界面不露解析器原文和码 | 运行卡片 | 否 | #935 |
