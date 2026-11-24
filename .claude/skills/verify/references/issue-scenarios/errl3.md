## errl3-scenarios.mjs 的场景（原记在「坏审修循环不挡导出，留在存档外并指明章节（#702）」）

场景在 `scripts/redesign/errl3-scenarios.mjs`。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `errl3-cloud-newer-zh` | 造 1 章定稿的书；假服务端口上挂一个本机 WebDAV，只放一个云端世代，它的存档来自更新版本的书童（清单结构版本 99）。填本机 WebDAV 地址点「连接并绑定」，「刷新云端世代」，选中它点「恢复所选云端世代为副本」：红字是「没有新建副本。这个云端世代来自更新版本的书童。请先升级书童，再点「恢复所选云端世代为副本」。」，所选文件夹里什么都没留下（`errl3-cloud-newer-zh-CN`）。修复前红字是「云端存档已下载，但没能恢复成副本……请把这条提示反馈给我们。」。场景在 `errl3-scenarios.mjs` | 项目备份（中文） | 是 | #702 |
| `errl3-cloud-newer-en` | 同上，界面切到 English：红字是「No copy was created. This cloud generation was made by a newer version of Pagekin. Update Pagekin, then click Restore selected cloud generation as a copy again.」（`errl3-cloud-newer-en-US`） | 项目备份（English） | 是 | #702 |
