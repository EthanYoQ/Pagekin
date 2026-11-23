## 重新打开已定稿的章（#516 第 2、3 块，ADR-0024）

场景在 `scripts/redesign/reopen-scenarios.mjs`。种子是示例作品去掉第 4 章草稿：第 1、2 章导入定稿，第 3 章在场景里定稿，第 4–12 章只有蓝图。假模型用 `fake.replyCharacterState(characterStateReply)`（来自 `f491-scenarios.mjs`）回角色状态。驱动包一层主进程的 `project:open` 记下界面打开作品的会话，用它读知识库；重启之后的数据在场景最后由驱动自己打开作品读。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `reopen-refinalize` | 第 3 章定稿后重开第 2 章（`reopen-1-final-reopen-button`、`reopen-2-banner`），末尾加一句、直接修稿、全部用修稿合并后定稿。确认框预览「第 3 章写于这次修改之前，第 4–12 章只有蓝图」和状态来自后续章节的林岚（`reopen-3-finalize-preview`），后处理全部成功；本章顶部「第 2 章已修改」（`reopen-4-impact-notice`），第 3 章有「写于第 2 章修改之前」（`reopen-4b-later-chapter`），v1 标为已被替换的定稿（`reopen-5-superseded`）。点「知道了」后两处一起消失，导入时发布的旧正文文件已删；第 4 章照常能写；重启后不再提示。再重开替换一次（`reopen-6-second-replacement`）：预览含刚写的第 4 章，上一份定稿的知识库文档和正文文件在新的导入之后删掉，提示重新出现；库里 v1、v2 已被替换，v3 是权威定稿 | 驱动读库后的页面 | 是 | #516 |
| `reopen-refinalize-edited-txt` | 第 3 章定稿后重开、改一句再放弃修改：版本、正文文件、知识库都和重开前一样，横幅消失（`reopen-7-discarded`）。手改它的正文文件后重开替换：「删除旧版本的正文文件」失败并写出保留的文件名，其余各步成功，旧知识库文档照常删除，手改的文件原样保留，新定稿另起带后缀的文件，本章仍可再重开（`reopen-8-edited-txt-kept`） | 后处理结果 | 是 | #516 |
| `reopen-refinalize-cards-failed` | 第 3 章定稿后重开第 2 章、末尾加一句，角色状态请求改回非 JSON 再定稿：「角色状态更新」失败，本章顶部照样出现「第 2 章已修改」并列出第 3 章与第 4–12 章（`reopen-9-cards-failed-notice`）。影响列表随定稿完成事件重读，不靠角色状态那一步发的刷新 | 定稿后的本章 | 是 | #516 |
