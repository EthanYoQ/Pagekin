## 英文界面下章节重开失败不露 SQLite 原文（#844 M33 章节生命周期）

场景在 `scripts/redesign/m33chap-scenarios.mjs`。示例作品建好并打开第 2 章后（打开作品时会核对库结构，所以不能提前加），在作品库 `drafts_all` 上加一个 `BEFORE INSERT` 触发器，让重开写重开稿的真实路径报 `database disk image is malformed`；界面切到英文，场景结束删掉触发器。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `m33chap-reopen-failed-en` | 第 2 章点「Reopen to edit」再确认，提示写「Could not reopen chapter 2: That action did not finish because something unexpected went wrong. Try again; if it keeps happening, send us this message.」，不露 SQLite 原文，第 2 章仍是定稿。master 上提示接的是 `database disk image is malformed` | 重开失败后的第 2 章 | 否 | #844 |
