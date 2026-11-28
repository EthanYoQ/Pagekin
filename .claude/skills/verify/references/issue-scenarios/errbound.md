## errbound-scenarios.mjs 的场景（组件出错面板不显示异常原文与组件栈（#916））

场景在 `scripts/redesign/errbound-scenarios.mjs`。出错靠在渲染进程里把技能设置页的技能列表 state 改成 `[null]` 触发，组件真的在渲染时抛 TypeError，不改应用代码。复制按钮点击前把 `navigator.clipboard` 换成页内记录，不写系统剪贴板。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `errbound-settings-crash` | 设置「写作 Skills」页渲染出错：面板标题「设置页渲染失败」，说明「已保存的内容不受影响…」，有「重试」「复制诊断信息」，面板文本不含 TypeError、异常原文与组件栈（`errbound-settings-crash-panel`）；点复制后按钮变「已复制」，复制内容含异常原文与组件栈 | 设置出错面板（中文），最终截图为已复制 | 否 | #916 |
| `errbound-settings-crash-en` | 同上，英文界面：标题「Settings failed to render」，按钮「Retry」「Copy diagnostics」，复制后「Copied」（`errbound-settings-crash-en-panel`） | 设置出错面板（英文），最终截图为已复制 | 否 | #916 |
