## 恢复稿写进作品库失败时不露 SQLite 原文（#844 M33 db 第一组）

场景在 `scripts/redesign/m33db-scenarios.mjs`。示例作品带一份第 5 章「潮汐表」的原始候选；建好后在作品库 `recovery_candidates` 上加一个 `BEFORE UPDATE` 触发器，让真实写入路径报 `database disk image is malformed`，场景结束删掉触发器。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `m33db-discard-write-failed` | 运行侧页恢复卡片点「放弃…」再点「放弃」，提示写「恢复稿没能写进作品，原来的内容没有改动。请再试一次。」，卡片仍列着。修复前提示是 SQLite 英文原文 | 放弃失败后的运行侧页 | 否 | #844 |
