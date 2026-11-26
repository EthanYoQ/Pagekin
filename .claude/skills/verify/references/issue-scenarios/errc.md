## 英文界面的蓝图生成失败不带 code= 与裸码（#844 PR-C）

场景在 `scripts/redesign/errc-scenarios.mjs`。示例作品规划 16 章，先在外观页把界面语言切成英文，再生成第 13～16 章蓝图；假模型回正文，生成失败并留下恢复稿。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `errc-blueprint-generation-failure-en` | 英文界面。运行侧页「Generate blueprints」失败步骤写 `Chapter-blueprint generation failed. Please try again.`，整个侧页没有 `code=`、`reason=`、`finishReason` 和大写下划线裸码 | 运行侧页的失败步骤 | 是 | #844 |
