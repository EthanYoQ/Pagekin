## 角色卡写进作品库失败时不露 SQLite 原文（#844 M33 db 第 4、8 组）

场景在 `scripts/redesign/m33dbc-scenarios.mjs`。示例作品建好后在作品库 `character_identity_approvals` 上加一个 `BEFORE INSERT` 触发器，让真实的角色名册提交在事务里报 `database disk image is malformed`，场景结束删掉触发器。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `m33dbc-roster-save-failed-en` | 架构页打开角色名单，选林岚，界面切到英文，改「Background」后点「Save character」。提示写 `Could not save the character cards. The character cards were not changed. This change could not be saved to the project. Try again.`，不含 SQLite 原文，编辑框里的修改还在 | 保存失败后的角色档案 | 否 | #844 |
