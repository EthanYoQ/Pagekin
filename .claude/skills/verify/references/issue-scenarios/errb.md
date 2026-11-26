## 参照导入失败只按码说明（#844 PR-B）

场景在 `scripts/redesign/errb-scenarios.mjs`。主进程的 `kb:import-reference-text` 被换掉，每章返回旧 error 字段装异常原文、errorCode 与 failure 都是 `EMBEDDING_SPACE_BUSY` 的失败。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `errb-reference-import-failure` | 中文界面导入两章参照文本。运行侧页「导入参照文本与构建知识库」步骤和「工作流未完成」下都写「检索索引正在建立，请稍后再试。」，整个侧页没有 `database is locked`、`SqliteError`、`EMBEDDING_SPACE_BUSY`。修复前步骤说明是旧 error 字段的原文 | 运行侧页的失败步骤 | 是 | #844 |
