# 渲染端入口、Store 协调与编辑器标签的约定

2026-11-27，注释清理（#852）第 4 个 PR（src 其余，不含 shared、components、services/workflows）。

## 背景

`src/main.tsx`、`src/services/project-service.ts`、`src/stores/project-store.ts`、`editor-store.ts`、`editor-unsaved.ts` 等文件把渲染端的启动顺序、跨 Store 联动、项目配置草稿与编辑器标签的未保存状态串在一起。它们的注释解释了「为什么样式只在入口引入」「为什么后台草稿账本不进 tabs」「并发的作者编辑为什么仍是脏草稿」这类决定，代码本身只看得到调用顺序。

## 决定

样式只在入口引入，原语组件不带样式副作用，Node 侧打包才能引用它们。组件不自行加载数据、不监听 window 事件，跨 Store 联动都经过 ProjectService，Store 只暴露纯数据与操作方法。编辑器后台草稿账本是技术状态，不是用户文件，不混入可关闭的 tabs；只有用户修改才让标签变脏，AI 生成完成后的刷新与打开文件的同步都静默进行。项目配置里只有提交的字段才成为正式数据，并发的作者编辑仍是脏草稿，调用方不能用旧的完整配置替换它。下面按文件列出各条口径。

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/App.tsx`

- `unsubActionToast`：C) 工作流完成时弹出 ActionToast 通知（不依赖任何面板状态）
- App 卸载时销毁 ProjectService（开发环境 HMR 时会触发）

### `src/hooks/useOutsideClick.ts`

- `useOutsideClick`：点击目标元素外部时触发 handler @param ref 需要检测的目标元素 ref @param handler 点击外部时的回调 @param enabled 是否启用（默认 true）。可传入 showMenu 状态，菜单关闭时暂停监听以减少 document 事件开销 使用示例： ```tsx const menuRef = useRef<HTMLDivElement>(null) const [open, setOpen] = useState(false) useOutsideClick(menuRef, () => setOpen(false), open) ```

### `src/main.tsx`

- 纸墨样式只在入口引入：原语组件不带样式副作用，Node 侧打包（如真实供应商资格脚本）才能引用它们。
- 外壳样式同样只在入口引入，排在全局样式之后，颜色桥接才能覆盖 index.css 里的 --color-*。

### `src/services/project-service.ts`

- `EventPayloadMap`：ProjectService — 项目生命周期与跨 Store 协调的单例调度层 职责： 1. 项目打开/关闭时统一初始化/清空 Layer 2 Store（character、draft） 2. 监听 EventBus 事件，驱动 Store 数据刷新 3. 同步 editor-store 中已打开 Tab 的内容（定稿后磁盘文件已变更的场景） 设计原则： - 组件不再自行 useEffect 加载数据、不再监听 window 事件 - 所有跨 Store 联动都经过此 Service - Store 只暴露纯数据 + 操作方法，不包含生命周期逻辑
- `initProjectService`：初始化 ProjectService — 注册所有事件监听 应在 App 挂载时调用一次
- config_generation 类型只需要轻量刷新（避免不必要的文件扫描）
- 章节创作完成 → 刷新草稿 + 角色卡（定稿后处理会更新角色状态）
- 架构生成完成 → 角色卡可能被提取
- `onProjectOpened`：项目打开后的初始化 — 并行加载所有 Layer 2 数据 由 project-store.openProject 成功后调用
- `onProjectClosed`：项目关闭时的清理 — 重置所有 Layer 2 Store 由 project-store.closeProject 调用
- `disposeProjectService`：销毁 ProjectService — 清理所有事件监听 通常在 App 卸载时调用

### `src/services/workflow-guards.ts`

- 工作流前置校验工具 每个生成步骤启动前需要校验上游数据是否就绪， 以防用户在配置不完整的状态下浪费 AI Token。 校验失败时返回 GuardResult { ok: false, message }， 由调用方选择展示方式（弹窗提示 / 日志输出）。

### `src/stores/draft-store.ts`

- `reset`：重置为初始状态（项目关闭时由 ProjectService 调用）
- `invalidateChapter`：清除指定章节的缓存（下次访问时重新加载）

### `src/stores/editor-store.ts`

- `busy`：保存或更新检索在途。放在标签上，页面切走再切回也认得出。
- `savedContent`：架构文档已持久化的基准内容，用于跨 Tab/项目切换后恢复脏状态。
- `narrativeThreadViewRequest`：重复打开同一叙事线 Tab 时递增，确保本次视图请求生效。
- `chapterSelectRequest`：章节蓝图页按 chapterNumber 选中一章的请求次数；只有带章号打开时才递增，重复打开同一章也会重新选中。
- `knowledgeDraft`：知识库标签的所选资料与未保存的改动；页面随标签切换卸载后靠它留住。
- `draftLedgers`：编辑器后台草稿账本。 账本是技术状态，不是用户文件，不能混入可关闭的 tabs。
- `updateTabContent`：更新 Tab 内容（标记 dirty） 仅在「用户修改」时调用，会亮起未保存指示灯。
- `syncTabContent`：静默同步 Tab 内容（不标记 dirty，也不清除 dirty） 用于「AI 生成完成后刷新」、「打开文件刷新」等非用户编辑场景。
- `markTabSaved`：标记 Tab 已保存（清除 dirty 标记） 在保存成功后调用，使警示灯、Tab 圆点消失。
- `removeEditorExitSaveHandlers`：现行规则：编辑器组件在活动 Tab 卸载后仍保留注册，store 自己的移除路径才是处理器生命周期的边界（原文：Editor components keep their registrations across active-tab unmounts. These store-owned removal paths are the handler lifetime boundary.）
- `editorSaveHandler`：标签自身的保存入口：与退出前保存共用各编辑器注册的处理器；编辑器没有注册时为 null。
- `idOnly`：diff 类型每次内容不同，只按 id 精确匹配（不走 filePath 去重） 其他类型（含 review-report）按 filePath + type 去重

### `src/stores/editor-unsaved.ts`

- `countUnsavedEditorItems`：统计真正独立的未保存编辑项。可见 Tab 与其后台账本采用同一个键去重， 因此更新门禁既不会漏掉暂时不可见的跨项目草稿，也不会重复计数。
- `countUnsavedEditorItemsForProject`：只统计关闭指定项目时会被清理的可见 Tab 与后台草稿。

### `src/stores/project-store.ts`

- `withTimeout`：给 Promise 包裹超时保护，防止 IPC 调用永远不返回
- `setAiSources`：下次保存时随设定落库。
- 主进程已经写进库的设定字段，发布到界面并记为已保存。 keepUnsavedEdits：作者在设定页改过、还没保存的字段保持作者的值（仍算未保存）；否则一律换成库里的值。
- `publishSavedNovelConfig`：keep：'none' 全按库里的值；'unsaved-edits' 作者改过还没保存的字段保留作者的值；'current' 这些字段都保留界面上的值，只把它们记为已保存基准。
- `commitGeneratedNovelConfig`：现行规则：主进程校验冻结的来源并写入之后才把生成的字段发布到界面（原文：Main validates frozen sources and writes before publishing generated fields to the UI.）
- `persistEffect`：现行规则：已有的受保护主进程效果（如导入回执）替代直接的核心写入，可返回它实际保存的字段（原文：Existing guarded main effect, such as an import receipt; replaces the direct core write and may return the fields it actually saved.）
- `aiSources`：AI 写入后的来源标记，与设定在同一事务里落库。
- `removeRecentProject`：只移除最近项目记录，不删除项目目录或数据
- `saved`：现行规则：只有提交的字段成为正式数据，无关的作者编辑保持脏状态（原文：Only the submitted fields became formal data; unrelated author edits stay dirty.）
- 现行规则：正式效果成功后并发的作者编辑仍是脏草稿，调用方不能运行会用旧完整配置替换它的回调（原文：The formal effect succeeded. A concurrent author edit remains a dirty draft, and callers must not run callbacks that replace it with an older full config.）

## 界面组件口径（注释清理 #852 第 5 个 PR，src/components）

### `src/components/editor/arch-file-refresh-policy.ts`

- `ArchReloadGate`：最后一次 reload 才算数；编辑、保存调用 invalidate() 作废在途 reload。

### `src/components/editor/chapter-card-draft-ledger.ts`

- `updateEditableChapterBlueprintField`：章节号是跨草稿、正文、摘要和向量数据的稳定键，本轮普通编辑不可修改。 即使调用方绕过类型约束传入 chapterNumber，运行时也恢复原章节号。
- `mergeChapterCardDraftWithRemote`：以 dirtyChapterNumbers 作为本地修改集合合并最新数据库蓝图。 脏章节采用本地值；未修改章节及远端新增章节采用 remote； 尚未进入 remote 的本地新增脏章节继续保留。
- `refreshChapterCardDraftFromRemote`：等待远端期间允许用户继续编辑；远端返回后才读取最新账本，并在同一同步执行段内 完成项目校验、三方选择和提交，避免旧 projectDraft 覆盖刚发生的本地编辑。

### `src/components/editor/clear-arch-section.ts`

- `clearArchSection`：清空一节故事架构文本（调用前已由作者确认），并让已打开的这一节标签同步为空且不算未保存。 写入失败返回 false；写入后项目会话已切换时不动标签。

### `src/components/editor/merge-segments.ts`

- `mergeChoicesKey`：修稿记录 id 只在同一作品里唯一（自增不复用），所以键要带项目 id。
- `useMergeSegments`：修稿合并的数据：段落对齐后的片段、每处改动的选择与每段的合并文字。 单章视图的合并视图用它；合并结果就是各段文字按顺序以换行连接。

### `src/components/project-delete-action.ts`

- `deleteCurrentProject`：确认之后的删除；书房先用危险确认（输入作品名），之后走这里。

### `src/components/run/use-model-calls.ts`

- `copySafeDiagnostic`：复制一条调用的安全诊断（不含正文与密钥），结果用提示告诉作者。

### `src/components/run/use-now.ts`

- `useNow`：每秒刷新的当前时间，所有显示时长的地方共用一个时钟，同屏的数字才一致。只在显示时长的小组件里用。

### `src/components/settings/unsaved-settings.ts`

- `unsaved`：设置页里还没保存的输入：各页用 useUnsavedSettings 登记，离开设置页或换页前由 leaveSettings 统一确认。
- `useSettingsLeave`：等作者确认放弃修改的离开动作；为空时没有确认框。stay 在作者选继续编辑或确认框随设置页卸载时调用。
- `settleSettingsLeave`：关掉确认框：放弃就执行离开动作，否则通知发起方作者留下了。
- `useSettingsLeaveHost`：设置页卸载时，还开着的放弃确认按作者留下结算。
- `leaveSettings`：确认框开着时再来的离开请求（快捷键不受模态框拦）当作作者留下：确认框问的仍是原来那一个， 新请求立即收到 stay，原请求由作者的回答结算，每个请求都恰好结算一次。作者按了却没反应会以为没按到，所以提示他先处理确认框。
- `leaveSettingsThen`：会让设置页收起的导航（去别的阶段、回到书房、打开或新建作品）：有没保存的输入时先确认，取消就不走； 确认后先收起设置页再执行，之后的自动落点（打开作品后落到哪一步）不会再问一次。
- `openProjectFolder`：打开作品（作品菜单、命令面板、Ctrl O）：先确认放弃输入，再选文件夹，选到了才收起设置页去打开； 选文件夹时取消，设置页与输入原样留着。
- `confirmLeaveSettings`：不经作者点击的自动导航（导入完成后、或任何时候 openProject 遇到设置页开着）用：有没保存的输入时先问。left 时设置页已收起； stayed 是作者选了继续编辑；busy 是另一个放弃确认还开着，这次不问也不走。 书房与作品里的设置页是两个实例，作品一提交书房里那个就卸载，所以要在提交之前问。

### `src/components/stage/use-model-missing.ts`

- `useModelMissing`：这个环节按分工模型解析不出可用的生成模型，和启动生成时的门槛同一套规则。模型配置载入前不下结论。

### `src/components/startup/RendererStartup.tsx`

- `RendererStartup`：规则：主进程与渲染端存储写入方都确认就绪之前，不导入业务模块（原文：Business modules are not imported until main and the renderer storage writer acknowledge readiness.）
- 规则：App 挂载前没有作者编辑器，之后由 App 持有自己的脏稿守卫（原文：No author editor exists before App mounts. After that App owns its dirty-work guard.）
- 规则：之后偏好写入失败不能卸载编辑器或丢掉内存里的作者工作（原文：A later preference write failure must not unmount editors or discard in-memory author work.）
