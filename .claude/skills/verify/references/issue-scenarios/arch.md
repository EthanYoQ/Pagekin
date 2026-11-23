## arch-scenarios.mjs 的场景（原记在「定稿加速（#702）」）

场景在 `scripts/redesign/arch-scenarios.mjs`。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `orui-outline-recovery` | 假模型让第 3 章两次都回整本的阶段大纲，从架构页点「编辑恢复稿」：恢复稿页页头是「补齐中断的大纲」，保存终点 2、继续（停用）与主按钮「保存恢复大纲」在同一行，提示写「第 1–2 章已写好，第 3 章没写成」「保存后可继续生成。待完成第 3 至 5 章」「第 3 章那次的回复在「原始候选」里」，正文没有第 3 章的回复（`orui-outline-recovery-stopped`，运行侧页并排时另截 `orui-outline-recovery-sheet`，展开原始候选另截 `orui-outline-recovery-original`）；不改一个字直接保存后，正式大纲有第 1、2 章，提示「本次恢复已保存，后续修改仅供复制。」，保存与终点停用，主按钮换成「继续生成缺少的章节」（`orui-outline-recovery-saved`） | 架构（中文） | 是 | #702 |
| `orui-outline-recovery-continue` | 同一份恢复稿打开后不删任何内容，直接「保存恢复大纲」，再点「继续生成缺少的章节」：正式大纲写满第 1–5 章 | 架构（中文） | 是 | #702 |
| `orui-outline-recovery-blocked` | 同一份恢复稿打开后改模型设置，点「重新读取恢复状态」：提示「不能保存，也不能继续生成」并叫作者从第 1 章重新生成，保存与继续都停用，页上没有主按钮，提示文字用满整页宽度（`orui-outline-recovery-blocked-page`）；运行侧页的恢复卡只写「请从第 1 章重新生成」，不再同时写「缺第 3–5 章」（`orui-outline-recovery-blocked-sheet`） | 架构（中文） | 是 | #702 |
| `orui-outline-recovery-en` | 同一份恢复稿切到英文界面：页头、按钮与提示没有中文，提示写「Chapters 1–2 are written; chapter 3 is not」；运行侧页并排时页头折行、不横向溢出（`orui-outline-recovery-en-sheet`） | 架构（英文） | 是 | #702 |
