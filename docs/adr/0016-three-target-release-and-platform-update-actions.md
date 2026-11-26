# 三目标正式发布与平台更新动作

正式 GitHub Release 从同一个冻结源码 SHA 提升 Windows x64、macOS ARM64 和 macOS x64 三个资格产物。每个目标先在 GitHub Actions 独立构建和验收，正式发布只能提升已验证的同字节产物；本机不得替代云端资格构建或上传官方安装包。精确工作流、资产名称、保留期、验收回执和签名披露由 [`.release/release-profile.json`](../../.release/release-profile.json) 维护。

Windows 和 macOS 共享 GitHub 最新正式 Release 作为版本源，但执行不同更新动作。Windows 发现新版后只进入可用状态，用户明确点击下载才启动后台下载；下载完成后继续使用未保存内容、运行中任务和重启安装保护。macOS 只显示新版提醒并打开固定的官方最新 Release 页面，不在应用内下载、替换或安装程序，也不接收远端提供的任意跳转地址。

资格构建与正式发布保持分离，正式提升需要明确授权。发布说明必须按资格回执如实披露签名和公证状态；不得因为某一平台成功就发布缺少其他受支持目标的正式版本。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/ipc-channels.ts`

- `updatePreferences`：更新检查和提醒延后的本机偏好，持久化到 ~/.vela/config.json。

### `src/shared/update-types.ts`

- `UpdateReleaseInfo`：可跨主进程、预加载与渲染进程传递的应用更新数据契约。 此文件不能依赖 Electron 或任何主进程服务，避免渲染进程类型定义反向依赖主进程实现。
- `lastAutomaticCheckDate`：最近一次成功自动检查对应的本地日历日，成功检查每天最多一次。
- `availableUpdate`：已确认高于当前版本的正式更新；重启后只恢复“可继续准备”，不伪造已下载状态。
- `reminder`：仅延后当前版本的提示；不会永久忽略更新。
- `UpdateErrorPhase`：哪个面向用户的更新操作产生了错误（原文：Which safe, user-facing update operation produced the error.）
- `UpdateErrorReason`：稳定分类，原始更新器与网络错误绝不跨过 IPC 边界（原文：Stable classifications; raw updater/network errors never cross the IPC boundary.）
- `SafeUpdateTechnicalDetails`：白名单诊断，可安全保留与渲染，不含凭据或路径（原文：Allowlisted diagnostics that are safe to retain and render without credentials or paths.）
- `UpdateState`：只包含可安全发送至渲染进程的值，不携带 Error 或更新器对象。

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/services/update-presentation.ts`

- `getUpdatePresentation`：将更新服务的状态转换成书房更新卡与设置「关于与更新」可观察的展示状态。 自动检查始终保持静默；只有用户主动检查时才展示“无更新”或错误反馈。

### `src/stores/editor-discard.ts`

- `discardAllEditorChanges`：放弃更新门禁统计到的全部未保存内容。 更新会退出整个应用，因此这里按所有项目清空，而不是只清当前项目。先通过各 领域 store 恢复当前可见项目的保存基准，再强制清空三类后台账本；损坏账本也 会被替换为空账本。最后关闭所有 dirty Tab，固定 Tab 恢复保存内容。
