## 定稿加速（#702）

场景在 `scripts/redesign/fspeed-scenarios.mjs`，夹具正文在 `finalize-quality-fixture.mjs`（第 3 到 23 章，每章预埋 3 条关键事件，部分章预埋人物状态变化）。`FSPEED_CHAPTERS` 选章（`3-10` 或 `3,5,7`），`FSPEED_LOG` 每章追加一行 JSON。夹具每章只有两三百字，计时要接近真实章节长度时用 `FSPEED_TEXT` 指向一个导出 `CHAPTERS`（或 `PROBE_CHAPTERS`）的正文模块，换了正文就不按预埋项初筛。修前对照用 `--app-root` 指向修前构建。`measured.summary` 给只读、可写下一章、后处理全部结束三个中位数，和按关键词初筛漏掉的事件与状态；漏项要人逐条看 `notesText`、`characterText` 复核。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `fspeed-finalize` | 默认定稿第 3 到 6 章，每章记从点「确认定稿」到「已定稿，只读」、到运行结束各发了哪些 `fs:` IPC（`fsBeforeReadOnly`、`fsBeforeRunEnd`），修后两者都没有写作 Skill 快照的 `fs:check-exists`；每章两次对话请求，后处理步骤 attempts 为 1 | 正文（中文） | 是 | #702 |
| `fspeed-still-processing` | 假模型闸门卡住第 3 章定稿后处理，去第 4 章点「写作此章」：不起运行，提示是「第 3 章已定稿，后台还在整理这一章，很快就好，请稍后再试。」，不是「处理失败」（`fspeed-still-processing-notice`）；放行后第 3 章后处理跑完 | 正文（中文） | 是 | #702 |
| `real-fspeed-finalize` | 真实模型逐章定稿（默认 3 到 23 章），记计时、每次对话请求的 `enable_thinking`、`reasoning_effort`、思考字数和可见回复全文，以及步骤结果与重试；用于开关思考的质量门禁与修前修后交替计时 | 正文（中文） | 真实 | #702 |
