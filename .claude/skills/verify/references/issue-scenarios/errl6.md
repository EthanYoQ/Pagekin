## 打开作品失败时说真正的原因（#702，err-l6）

场景在 `scripts/redesign/errl6-scenarios.mjs`。先建《灯塔》，退出应用，冷启动前把作品弄坏或占住，再从书房点「打开《灯塔》」。`-en` 的场景点打开前切到英文界面。`locked`、`denied` 只在 Windows 上跑。修复前三类都弹「打开项目失败」，正文是「发生错误：」加原文：坏库是 `SqliteError: database disk image is malformed`，占用是带作品路径的 `EBUSY: resource busy or locked`，没有权限是带作品路径的 `EPERM: operation not permitted`。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `errl6-damaged` | `project.db` 尾部截掉一半（worker 报 `SQLITE_CORRUPT`）：弹「打开作品失败」，正文是「作品文件已损坏，打不开。导出过存档的，可以在设置的「项目备份」里点「从本地存档恢复副本」。」，不露码和英文。点「确定」后从书房进设置的「项目备份」，「从本地存档恢复副本」能点。另存 `errl6-damaged-dialog` 截弹窗 | 设置「项目备份」 | 是 | #702 |
| `errl6-damaged-en` | 同上，英文界面：标题 Couldn’t open the book，正文指向 Settings > Project backup 与 Restore a copy from local archive | 书房上的失败提示（英文） | 是 | #702 |
| `errl6-locked`、`errl6-locked-en` | PowerShell 以不共享方式打开 `project.db`（worker 读快照报 `EBUSY`）：正文说作品文件正被别的程序占用，下一步是稍等几秒再点「打开《灯塔》」（英文 Open “灯塔”） | 书房上的失败提示 | 是 | #702 |
| `errl6-denied`、`errl6-denied-en` | `icacls` 拒绝当前用户读写 `project.db`（worker 报 `EPERM`），收尾还原：正文说没有权限读取作品文件，检查文件夹权限或把文件夹移到有权限的位置 | 书房上的失败提示 | 是 | #702 |
