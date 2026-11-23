## rbk-scenarios.mjs 的场景（原记在「重复定稿修复后重试本章后处理（#279）」）

场景在 `scripts/redesign/rbk-scenarios.mjs`。种子都是示例作品。`rbk-stale-notes-retry` 先在角色页把林岚的「当前位置」改成作者写的值，假模型用 `fake.replyCharacterState` 给这个字段报新值，`fake.dropCharacterState(1)` 让第 3 章首跑的角色状态断流。重启前用 `rbk-inject-duplicate.cjs` 给第 2 章造一条重复定稿，打开作品时的修复把连续性世代加一、从第 2 章起作废。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `rbk-stale-notes-retry` | 第 3 章首跑：章节要点成功、角色状态失败（`rbk-9-ch3-character-state-failed`）。重启并修复后，第 3 章的要点行停在旧世代。点一次「重试失败步骤」：各步都成功，章节要点与角色状态各多发一次请求，要点行写到当前世代，作者写的位置留成待确认项（`rbk-10-ch3-retried-once`）。世代、作废起点、要点行世代和待确认字段从作品库只读读出，写进 `measured` | 重试后的第 3 章 | 是 | #279 |
| `rbk-rollback-refinalize` | 第 3 章（预置一份草稿 v2）、第 4 章先后定稿（`rbk-1-ch3-finalized`、`rbk-2-ch4-finalized`）。版本历史里对第 3 章「草稿 v1」点「回退到此版本…」（`rbk-3-revert-dialog`），新建回滚草稿 v3（`rbk-4-reverted-v3`），第 3 章回到草稿阶段；再定稿第 3 章，后处理全部成功、章节行是定稿（`rbk-5-ch3-refinalized`）；版本历史把旧定稿标为「已被替换的定稿 v2」（`rbk-5b-history-superseded`），打开 v2 时切换器写「本章版本：已被替换的定稿 v2 · …」、提示「已被替换的定稿，只读」（`rbk-5c-chapter-superseded`）；第 5 章能开始写（`rbk-6-write-ch5`），权威序列连续、下一章是第 5 章 | 驱动重开作品后的界面，看命名截图 | 是 | #516 |
| `rbk-history-revised-name` | 第 3 章预置一份标为已合并修稿的 v2，版本历史里该节点名以「修稿已合并 v2」开头，与版本切换器一致（`rbk-8-history-revised-name`） | 版本历史 | 是 | #516 |
| `rbk-legacy-duplicate-repair` | 重启前用 `rbk-inject-duplicate.cjs` 给第 2 章造两行定稿，从书房打开：提示框写「第 2 章：保留 v2 作为定稿，v1 改为「已被替换的定稿」」（`rbk-7-repair-notice`），点「知道了」后权威序列连续、下一章是第 3 章；再重启打开一次不再提示，修复结果与第一次相同（幂等） | 驱动重开作品后的界面，看命名截图 | 是 | #516 |
