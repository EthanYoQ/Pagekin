## 导入停下的说明随导入运行语言（#844 PR-F）

场景在 `scripts/redesign/errf-scenarios.mjs`。参照导入 15 章，第 2 批蓝图派发卡在门上时把累计时长推到上限，导入停在 `ROOT_BUDGET_EXHAUSTED`。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `errf-stop-zh` | 中文界面开始导入。失败步骤写「蓝图推演失败：这次导入的模型请求累计时长已到上限……」，不露错误码 | 运行侧页的失败步骤 | 是 | #844 |
| `errf-stop-en` | 英文界面开始导入。失败步骤写「Blueprint inference failed. This import used up its time allowance for model requests……」，没有中文、没有错误码；界面切回中文后同一步骤的说明逐字不变。修复前英文句首带括号里的内部码，如「Blueprint inference failed (root_budget).」（不变式测试在 master 上的输出） | 英文界面与切回中文后的运行侧页 | 是 | #844 |
