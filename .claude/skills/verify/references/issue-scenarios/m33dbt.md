## 叙事线写进作品库失败时不露 SQLite 原文（#844 M33 db 第 3 组）

场景在 `scripts/redesign/m33dbt-scenarios.mjs`。示例作品定稿第 3、4 章，带一条第 3 到 5 章的线索「父亲的旧信」；建好后在作品库 `narrative_thread_assignments` 上加一个 `BEFORE INSERT` 触发器，让真实写入路径报 `database disk image is malformed`，场景结束删掉触发器。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `m33dbt-defer-write-failed` | 第 5 章「本章要处理 1 条线索」弹层里点「延后一章」，提示写「线索还在本章任务里。延后没保存上，再点一次试试。」，线索仍是本章到期；作品库里线索收束章仍是第 5 章，章节任务没有新增。master 上界面显示同一句，原文只在通道返回值里 | 延后失败后的写作选项弹层 | 否 | #844 |
