## 坏审修循环不挡导出，留在存档外并指明章节（#702）

场景在 `scripts/redesign/cch-scenarios.mjs`，书用 `perf702-scenarios.mjs` 的 `buildByReviewCycle` 走真实审修循环造，不存性能检查点。跑法：`PERF702_BLUEPRINTS=2`。成功提示里的哈希每次不同，断言按 64 位十六进制匹配。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `cch-export-damaged` | 定稿两章，冷重启前在应用外改坏第 2 章的审稿证据；设置 → 项目备份 → 导出本地存档，存档写出，成功提示是「本地存档已导出：<哈希>。第 2 章「远航之2」有条审稿记录损坏，没放进存档。正文和其他审稿内容都在。」（`cch-1-zh`）；界面切到日本語再导出，前半句是面板的英文文案，后半句为日文（`cch-2-ja`）；切到 English 再导出，章名用直引号（`cch-3-en`） | 项目备份（English） | 是 | #702 |
| `cch-export-multi` | 同上造书，改坏第 1、2 章：中文提示后半句是「第 1 章「远航之1」、第 2 章「远航之2」有审稿记录损坏，没放进存档。正文和其他审稿内容都在。」（`cch-5-multi-zh`）；English 是「Damaged review records in Chapter 1 "远航之1", Chapter 2 "远航之2" were left out of the archive. The text and other reviews are included.」（`cch-6-multi-en`） | 项目备份（English） | 是 | #702 |
| `cch-trash-damaged` | 同上造书，改坏第 1 章：在第 1 章「更多操作」点「删除正文…」并确认，移到回收站；回项目备份导出成功，后半句指「回收站里第 1 章「远航之1」」（`cch-4-trash`） | 项目备份（中文） | 是 | #702 |
| `cch-export-sealed-ledger` | 同上造书，冷重启前给第 2 章的审稿根加一条绑定读不出、带尝试的兄弟运行，并把各根标成暂停（静止树，打开时不封存）；导出前的全量进门在主进程封存它，导出成功，提示后半句同 `cch-export-damaged`（`cch-8-sealed-ledger`）。进门没在主进程跑时这里报库校验失败 | 项目备份（中文） | 是 | #702 |
| `cch-export-still-fails` | 同上造书，改坏第 2 章的审稿证据，再清空这条根的预算：去掉循环仍过不了投影，红字是「作品没有改动。第 2 章「远航之2」有条审稿记录损坏，存档没生成。请把这条提示反馈给我们。」，没写出存档（`cch-7-still-fails`） | 项目备份（中文） | 是 | #702 |
| `ec-review-overflow` | 导入 3 章各约 3 MiB 的定稿，再建超过 8 MiB 的第 4 章草稿；点「AI 审稿」，运行侧栏报「正文没有改动。本章正文连同你填的要求太长，超过 AI 一次能处理的上限，没有生成。缩短本章正文或你填的要求后重试；还不行，请把这条提示反馈给我们。」，不请求模型（`ec-2-review-overflow`）。前文不再计入上限：只有 3 章大定稿、第 4 章草稿短时，这条提示不出现。修复前提示叫作者精简前文、设定、蓝图 | 第 4 章（中文） | 是 | #702 |
| `export-skip-leftovers` | 建 1 章定稿的书，冷重启前往 `.ai-novel` 里放 `desktop.ini`、`Thumbs.db`、`.DS_Store`，再插一张没归到任何角色、文件和库里哈希对不上的旧头像；导出成功，提示是「本地存档已导出：<哈希>」（`export-skip-1-exported`）；用这份存档恢复副本，提示「已恢复新副本 …」，副本的 `.ai-novel` 里没有这三个文件和这张头像，副本能打开。修复前导出失败，红字分别是「作品文件夹里有不认识的文件或链接」和「一张没归到任何角色名下的旧头像文件坏了或不见了」 | 项目备份（中文） | 是 | #702 |
| `perf702-export-held` | 建 1 章定稿的书，导出目录里先放一份 `盐湖.md`，驱动进程以 r+ 打开它，再选「合并 Markdown」点「选择目录并导出」：红字是「文件没有改动。目标文件正被其他程序打开，关掉它后再点「选择目录并导出」。」，原文件内容不变、没有临时文件（`held-target`）；关掉后再点，提示「已导出到：…/盐湖.md」，文件里是第 1 章（`released-target`）。修复前红字是「外部文件授权操作失败。」。场景在 `perf702-scenarios.mjs` | 导出对话框（中文） | 是 | #702 |
| `fw723-fullwidth-title` | 建书，导入一章标题为「为什么？真相：开始」的定稿，再按定稿后处理的写法把正文导入知识库，文档名「第1章 为什么？真相：开始.txt」；冷重启后导出本地存档，提示「本地存档已导出：<哈希>」（`fw723-1-exported`）；用这份存档恢复副本，提示「已恢复新副本 …」（`fw723-2-restored`），副本的定稿稿件名和知识库文档名与原作品一致，副本能打开。修复前导出失败，红字是原码 PORTABLE_KNOWLEDGE_INVALID 或 PORTABLE_PATH_UNSAFE | 项目备份（中文） | 是 | #723 |
| `ec-restore-not-archive` | 建 1 章定稿的书，在项目备份点「从本地存档恢复副本」，选一个没下载完的 `.ainovel`（不是完整 zip）；红字是「没有新建副本。所选文件不是完整的书童存档，可能坏了或没下载完。请换一个存档，再点「从本地存档恢复副本」。」，所选文件夹里什么都没留下（`ec-4-restore-not-archive`）。修复前红字是原码 PORTABLE_ARCHIVE_INVALID | 项目备份（中文） | 是 | #702 |
| `ec-cloud-endpoint` | 同上造书，WebDAV 地址填 `http://` 开头的地址，点「连接并绑定」；红字是「没有连接。WebDAV 地址要是 https:// 开头的完整网址，不能带 ?、# 或用户名密码。请改好地址，再点「连接并绑定」。」，不发网络请求（`ec-6-cloud-endpoint`）。修复前红字是原码 CLOUD_BACKUP_FAILED | 项目备份（中文） | 是 | #702 |
| `errl3-cloud-newer-zh` | 造 1 章定稿的书；假服务端口上挂一个本机 WebDAV，只放一个云端世代，它的存档来自更新版本的书童（清单结构版本 99）。填本机 WebDAV 地址点「连接并绑定」，「刷新云端世代」，选中它点「恢复所选云端世代为副本」：红字是「没有新建副本。这个云端世代来自更新版本的书童。请先升级书童，再点「恢复所选云端世代为副本」。」，所选文件夹里什么都没留下（`errl3-cloud-newer-zh-CN`）。修复前红字是「云端存档已下载，但没能恢复成副本……请把这条提示反馈给我们。」。场景在 `errl3-scenarios.mjs` | 项目备份（中文） | 是 | #702 |
| `errl3-cloud-newer-en` | 同上，界面切到 English：红字是「No copy was created. This cloud generation was made by a newer version of Pagekin. Update Pagekin, then click Restore selected cloud generation as a copy again.」（`errl3-cloud-newer-en-US`） | 项目备份（English） | 是 | #702 |
