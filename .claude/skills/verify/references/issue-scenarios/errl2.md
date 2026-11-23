## errl2-scenarios.mjs 的场景（原记在「定稿加速（#702）」）

场景在 `scripts/redesign/errl2-scenarios.mjs`。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `errl2-export-inside-source` | 设置·项目备份把存档存进作品自己的文件夹，点「导出本地存档」：中文提示「作品没有改动。存档不能放进作品自己的文件夹……换到作品文件夹以外的位置。」，切英文再导出给对应英文；不露 PORTABLE_TARGET_INSIDE_SOURCE，作品文件夹里没有写出存档（`errl2-1-export-inside-zh`、`errl2-2-export-inside-en`） | 设置（中文、英文） | 是 | #702 |
| `errl2-restore-archive-moved` | 先导出一份存档，点「从本地存档恢复副本」选好存档后、选恢复位置时存档被移走：界面说「没有新建副本。找不到所选存档。请再点「从本地存档恢复副本」重新选一次。」，切英文再恢复给对应英文；不露英文原文和路径，主进程日志里有原来的 ENOENT，恢复位置没有建出副本（`errl2-3-restore-moved-zh`、`errl2-4-restore-moved-en`） | 设置（中文、英文） | 是 | #702 |
| `errl2-source-unreadable` | 用 icacls 拒读作品的 project.json 后点「导出本地存档」：中文提示「作品没有改动。作品文件读不了，可能正被同步盘或杀毒软件占用。请稍后再点「导出本地存档」。」，不叫作者换位置，主进程日志有原来的 EPERM，没有写出存档；拒读所选存档后恢复：提示「所选存档读不了」，恢复位置没有建出副本；切英文再导出给对应英文（`errl2-5-export-source-unreadable-zh`、`errl2-6-restore-archive-unreadable-zh`、`errl2-7-export-source-unreadable-en`）。只在 Windows 上跑 | 设置（中文、英文） | 是 | #702 |
| `errl2-restore-mid-install` | 先导出一份存档，再点「从本地存档恢复副本」，在主进程里让往副本放文件的 link 依次报 ENOSPC（project.json）、EPERM（安装标记）、EBUSY（project.db）：三次提示分别是「所选文件夹写不进去……」「所选文件夹没法安全写入……」「恢复时出了意外错误……」，都说「里面可能留下没恢复完的副本文件夹，可以删掉」，不再说「没有新建副本」，所选位置每次多一个没装完的副本文件夹；切英文再报 ENOSPC 给对应英文（`errl2-8-restore-mid-install-unwritable-zh`、`errl2-9-restore-mid-install-unsafe-zh`、`errl2-10-restore-mid-install-failed-zh`、`errl2-11-restore-mid-install-unwritable-en`） | 设置（中文、英文） | 是 | #702 |
