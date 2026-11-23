## 重复定稿修复后重试本章后处理（#279）

场景在 `scripts/redesign/rbk-scenarios.mjs`。种子是示例作品。先在角色页把林岚的「当前位置」改成作者写的值，假模型用 `fake.replyCharacterState` 给这个字段报新值，`fake.dropCharacterState(1)` 让第 3 章首跑的角色状态断流。重启前用 `rbk-inject-duplicate.cjs` 给第 2 章造一条重复定稿，打开作品时的修复把连续性世代加一、从第 2 章起作废。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `rbk-stale-notes-retry` | 第 3 章首跑：章节要点成功、角色状态失败（`rbk-9-ch3-character-state-failed`）。重启并修复后，第 3 章的要点行停在旧世代。点一次「重试失败步骤」：各步都成功，章节要点与角色状态各多发一次请求，要点行写到当前世代，作者写的位置留成待确认项（`rbk-10-ch3-retried-once`）。世代、作废起点、要点行世代和待确认字段从作品库只读读出，写进 `measured` | 重试后的第 3 章 | 是 | #279 |
