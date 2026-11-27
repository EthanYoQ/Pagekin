## 审稿清单写进作品库失败时不露 SQLite 原文（#844 M33 db 第 2、5、6 组）

场景在 `scripts/redesign/m33dbr-scenarios.mjs`。示例作品第 3 章带一份审稿报告；建好后在作品库 `reviews` 上加一个 `BEFORE INSERT` 触发器，让真实写入路径报 `database disk image is malformed`，场景结束删掉触发器。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `m33dbr-review-confirm-write-failed-en` | 打开第 3 章审稿报告，界面切到英文，点「Revise with 1 note」（先确认审稿清单再修稿）。提示写 `The draft text was not changed. This review or annotation could not be saved to the project. Try again.`，不含 SQLite 原文 | 确认失败后的审稿报告 | 是（不调用，只为有可选的修稿模型） | #844 |
