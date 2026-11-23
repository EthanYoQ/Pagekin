## chapter-scenarios.mjs 的场景（原记在「打开时封存了读不出的生成记录（#702）」）

场景在 `scripts/redesign/chapter-scenarios.mjs`。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `merge-pick-tab-switch` | 示例作品第 4 章审稿、修稿（假模型回三段修稿），合并视图里第 1、3 段选用修稿（`merge-pick-tab-switch-1-picked`）；点第 3 章标签再点回第 4 章，合并视图仍是「已选 2 处用修稿」（`merge-pick-tab-switch-2-returned`）；完成合并后库里草稿正文含第 1、3 段修稿、不含第 1 段原稿（`merge-pick-tab-switch-3-merged`） | 正文（中文） | 是 | #752 |
| `merge-pick-merge-later` | 同 `merge-pick-tab-switch`，离开方式换成「稍后再合并」后点「打开修稿合并」（`merge-pick-merge-later-*`） | 正文（中文） | 是 | #752 |
