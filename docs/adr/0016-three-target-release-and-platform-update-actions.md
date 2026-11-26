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

## 界面组件口径（注释清理 #852 第 5 个 PR，src/components）

### `src/components/stage/StageUpdate.tsx`

- `InstallBlockedDialogs`：重启更新被拦下时的两种对话框：有任务只能返回处理；有未保存修改时返回保存，或放弃修改后重启。
- `UpdateActions`：当前状态下可做的事。主操作只有一个，延后提醒是次要的文字按钮。
- `LibraryUpdateCard`：书房里的更新提示：只在发现新版本、下载中、待重启或出错时出现。检查更新与官方主页在设置的「关于与更新」。

### `src/components/updates/UpdateNotifier.tsx`

- `UpdateNotifier`：规则：本渲染会话内发现的每个版本显示一条持久的全应用提示（原文：Shows one persistent, app-wide notice for each release discovered in this renderer session.）

### `src/components/updates/update-install-discard.ts`

- `discardChangesThenRequestInstall`：更新安装前先同步放弃编辑状态。 即使安装请求失败或应用没有退出，放弃操作也已经完成，不会重新出现伪 dirty 状态。

### `src/components/updates/use-update-install-guard.ts`

- `useUpdateInstallGuard`：重启更新前的拦截：有创作任务时只能返回处理任务；有未保存修改时返回保存，或明确放弃后再重启。 书房的更新卡与设置里的「关于与更新」共用。
- 活跃任务集合中标记为已完成或失败的任务，也可能正处在最终落盘和移入历史之间， 因此不能只检查运行中、已暂停或等待中的状态。
- 用户停留在未保存确认框期间也可能启动任务，最终安装动作前必须再次检查。
- `dismiss`：只关掉指定的拦截：确认放弃后重查到任务时已换成任务拦截，随后确认框自己的关闭不能把它也关掉。
