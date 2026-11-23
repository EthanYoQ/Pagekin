## 打开作品时同一本书的预览（#702，open-readonly）

场景在 `scripts/redesign/oro-scenarios.mjs`。书房有《灯塔》《雾港》两本，经主进程处理器交替打开没开着的那本，发出打开后隔 70–130 ms 再发同一本的预览，对应作者用菜单「打开作品」或 Ctrl K 打开、打开还没完成就点封面。不截图。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `oro-open-then-peek` | 200 轮（`ORO_ROUNDS` 可改）打开全部成功；每轮盯预览 scratch 里的 `snapshot.db`，在打开完成前出现的才算有效轮，有效轮少于四分之一（`ORO_MIN_EFFECTIVE` 可改）即失败。预览间隔用 `ORO_MIN_DELAY`、`ORO_MAX_DELAY` 改（默认 70、130 ms）。修复前本机 200 轮有 4 轮在 connect 一步报 `SQLITE_READONLY` | 无 | 否 | #702 |
