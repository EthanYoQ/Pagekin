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
