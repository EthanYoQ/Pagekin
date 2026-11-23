## 打开时封存了读不出的生成记录（#702）

场景在 `scripts/redesign/sealed702-scenarios.mjs`，书用样例书，不需要环境变量。每次冷启动停在书房还是作品里都记下来，应当都是书房：`sealed702-open-notice-*` 冷启动两次，记在数组 `measured.landings`；`sealed702-after-load-error-zh`、`sealed702-switch-before-ack-zh` 与 `sealed702-switch-still-opening-zh` 只冷启动一次，记在 `measured.landed`。数提示前都等每个提示层渲染出对话框，挂载点先挂上、内容稍后才渲染，早数会数漏。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `sealed702-open-notice-zh` | 造样例书后冷重启，重启前在应用外插入两个读不出的生成根（共四格）；从书房打开，弹出「有 AI 生成记录读不出」，正文报「2 条」（数生成不数格子），不叫作者重新生成，只请反馈（`sealed702-zh-first-open`）；点「知道了」后再冷重启打开同一本书，这次让打开后读最近作品失败一次，关掉报错框、它那一层脱离且各层渲染完时没有封存提示，库里封存的根仍是 2（收尾截图） | 正文（中文） | 是 | #702 |
| `sealed702-open-notice-en` | 同上，界面 English：标题与正文是英文，条数 2 用复数「records … were disabled」（`sealed702-en-first-open`）；再打开不提示 | 正文（English） | 是 | #702 |
| `sealed702-open-notice-ja` | 同上，界面日本語：提示是日文「2 件」，按钮「了解」（`sealed702-ja-first-open`）；再打开不提示 | 正文（English 外壳） | 是 | #702 |
| `sealed702-after-load-error-zh` | 同上造书，冷重启后让打开后读最近作品失败一次；从书房打开，先只弹「项目已打开，部分数据加载失败」，这时只有它一层提示（`sealed702-order-1-load-error`）；点「确定」后才弹「有 AI 生成记录读不出」，报错框已关（`sealed702-order-2-notice`） | 正文（中文） | 是 | #702 |
| `sealed702-switch-before-ack-zh` | 同上造书，另建一本「雾岛」；冷重启后让打开后读最近作品失败一次，从书房打开样例书，报错框开着时按 Ctrl+O 打开雾岛；雾岛打开后样例书的报错框自己撤走，雾岛上一层提示都没有，也不弹封存提示，样例书库里封存根仍是 2（`sealed702-switch-no-notice`） | 设定（中文，雾岛） | 是 | #702 |
| `sealed702-switch-still-opening-zh` | 同上造书与「雾岛」；报错框开着时拦住下一次 `project:open`，按 Ctrl+O 选雾岛，等它停在主进程；关掉报错框，样例书仍是当前书，弹出它的封存提示「2 条」（`sealed702-still-opening-1-notice-on-sample`）；放行后雾岛打开，样例书的封存提示撤走，雾岛上一层提示都没有（`sealed702-still-opening-2-other-book`） | 设定（中文，雾岛） | 是 | #702 |
| `r702-restored-review` | 示例作品第 4 章 AI 审稿后导出本地存档、恢复成新副本；副本第 4 章主按钮直接是「重新审稿」，动作条说明这份审稿是恢复前做的，没有「按 N 项意见修稿」（`r702-3-restored-review`）；点「重新审稿」后按新意见修稿能生成修稿（`r702-3-fresh-revise`） | 正文（中文） | 是 | #702 |
| `r702-restored-merge` | 示例作品第 4 章审稿（同 `x2-recheck`，带正文证据的本章目标意见，合并后需要复验）、修稿后稍后再合并，导出并恢复；副本里合并这份恢复前的修稿，合并照常，合并视图不说会复验，合并后假模型只收到审稿、修稿两次请求，不留失败运行，提示指向「重新审稿」（`r702-3-restored-merge`） | 正文（中文） | 是 | #702 |
| `r702-rereview-old-revision` | 同 `r702-restored-merge` 留下恢复前的待合并修稿；副本里稍后再合并，改正文并保存，点「重新审稿」，再把正文改回原样保存，恢复前的修稿又能合并。合并视图按这份修稿自己的循环，不说会复验（显示的是新审稿）；合并后假模型只收到审稿、修稿、重新审稿三次请求，不留失败运行（`r702-4-rereview-old-revision`） | 正文（中文） | 是 | #702 |
| `uxr-setup-filled` | 示例作品写满长设定（无 AI 标记）：设定页从上到下是基本设定、设定细则、核心大纲，设定页没有一个输入框要在框里滚动；首屏与滚到底各截一张（`uxr-setup-filled-top`、`uxr-setup-filled-bottom`），核心大纲字数与 `countUnits` 期望值一致 | 设定（中文） | 否 | #702 |
| `uxr-setup-new` | 示例作品清空设定后只留文风一项作者原文：新书六项细则里五项「未填」、文风无标记，底栏与流程脊都是还差 3 项（`uxr-setup-new-empty`）；选类型、目标读者、写核心大纲后「AI 补全其余设定」，文风标「AI 扩写」、其余补上的标「AI 填写」，表头计数与行内标记一致，补全已写进库、底栏不出「保存」（`uxr-setup-new-filled`）；冷重启再打开，标记与计数不变（`uxr-setup-new-reopened`） | 设定（中文） | 是 | #702 |
| `uxr-bp-long` | 112 章、第 5 章长蓝图：卡片没有一个输入框要在框里滚动，列表「112 章」、选中行与卡片章号一致（`uxr-bp-long-top`）；滚到底再换章卡片回顶、要点编辑态收起；底部与要点编辑态各一张（`uxr-bp-long-bottom`、`uxr-bp-long-notes-edit`） | 蓝图（中文） | 否 | #702 |
| `uxr-bp-new` | 示例作品第 6 章：钩子、指导、要点为空，空要点直接是输入框（`uxr-bp-new`） | 蓝图（中文） | 否 | #702 |
| `uxr-bp-switch-bench` | 112 章蓝图按固定顺序来回换 20 次章，先热身一轮再测 5 轮，返回点击到提交、到排版、到两帧后的中位与最大耗时和长任务数；每次都换到点的那一章。无截图，结果在场景 JSON | 蓝图（中文） | 否 | #702 |
| `merge-pick-tab-switch` | 示例作品第 4 章审稿、修稿（假模型回三段修稿），合并视图里第 1、3 段选用修稿（`merge-pick-tab-switch-1-picked`）；点第 3 章标签再点回第 4 章，合并视图仍是「已选 2 处用修稿」（`merge-pick-tab-switch-2-returned`）；完成合并后库里草稿正文含第 1、3 段修稿、不含第 1 段原稿（`merge-pick-tab-switch-3-merged`） | 正文（中文） | 是 | #752 |
| `merge-pick-merge-later` | 同 `merge-pick-tab-switch`，离开方式换成「稍后再合并」后点「打开修稿合并」（`merge-pick-merge-later-*`） | 正文（中文） | 是 | #752 |
| `bs702-cycle12` | 假模型按审稿、修稿、合并复核、定稿写 12 章，库版本 12、36 条审修证明都是 v2；导出再恢复两轮，副本里仍是 v2、条数不变；在副本里打开第 12 章（`bs702-cycle12-restored`） | 正文（中文） | 是 | #702 |
| `bs702-upgrade-open` | 要 `PERF702_FIXTURE`（库版本 10 的书）。从书房点封面预览、再打开，分别记耗时与主进程最长阻塞，任一段超过 500 ms 即失败；打开等待中截 `bs702-upgrade-opening`（`bs702-upgrade-library`、`-preview`、`-opened`）；库升到 12 后写第 113 章并开一次审稿，新证明是 v2（`bs702-upgrade-review`） | 书房、正文（中文） | 是 | #702 |
| `bs702-upgrade-perf` | 要 `PERF702_FIXTURE`。不截图，只量：先预览、打开库版本 10 的书（升级），重启后再预览、打开同一本（已是 12），四段的耗时与主进程最长阻塞写进结果，任一段超过 500 ms 即失败 | 书房（中文） | 否 | #702 |
| `real-bs702-112` | 同上夹具接真实模型：升级打开后写第 113 章、审稿、修稿、合并（`real-bs702-merged`），新证明是 v2 | 正文（中文） | 是 | #702 |
