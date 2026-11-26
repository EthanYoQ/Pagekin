# 渲染端入口、Store 协调与编辑器标签的约定

2026-11-27，注释清理（#852）第 4 个 PR（src 其余，不含 shared、components、services/workflows）。

## 背景

`src/main.tsx`、`src/services/project-service.ts`、`src/stores/project-store.ts`、`editor-store.ts`、`editor-unsaved.ts` 等文件把渲染端的启动顺序、跨 Store 联动、项目配置草稿与编辑器标签的未保存状态串在一起。它们的注释解释了「为什么样式只在入口引入」「为什么后台草稿账本不进 tabs」「并发的作者编辑为什么仍是脏草稿」这类决定，代码本身只看得到调用顺序。

## 决定

样式只在入口引入，原语组件不带样式副作用，Node 侧打包才能引用它们。组件不自行加载数据、不监听 window 事件，跨 Store 联动都经过 ProjectService，Store 只暴露纯数据与操作方法。编辑器后台草稿账本是技术状态，不是用户文件，不混入可关闭的 tabs；只有用户修改才让标签变脏，AI 生成完成后的刷新与打开文件的同步都静默进行。项目配置里只有提交的字段才成为正式数据，并发的作者编辑仍是脏草稿，调用方不能用旧的完整配置替换它。下面按文件列出各条口径。

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/main.tsx`

- 纸墨样式只在入口引入：原语组件不带样式副作用，Node 侧打包（如真实供应商资格脚本）才能引用它们。
- 外壳样式同样只在入口引入，排在全局样式之后，颜色桥接才能覆盖 index.css 里的 --color-*。

### `src/services/project-service.ts`

- `EventPayloadMap`：ProjectService — 项目生命周期与跨 Store 协调的单例调度层 职责： 1. 项目打开/关闭时统一初始化/清空 Layer 2 Store（character、draft） 2. 监听 EventBus 事件，驱动 Store 数据刷新 3. 同步 editor-store 中已打开 Tab 的内容（定稿后磁盘文件已变更的场景） 设计原则： - 组件不再自行 useEffect 加载数据、不再监听 window 事件 - 所有跨 Store 联动都经过此 Service - Store 只暴露纯数据 + 操作方法，不包含生命周期逻辑

### `src/stores/editor-store.ts`

- `busy`：保存或更新检索在途。放在标签上，页面切走再切回也认得出。
- `savedContent`：架构文档已持久化的基准内容，用于跨 Tab/项目切换后恢复脏状态。
- `narrativeThreadViewRequest`：重复打开同一叙事线 Tab 时递增，确保本次视图请求生效。
- `chapterSelectRequest`：章节蓝图页按 chapterNumber 选中一章的请求次数；只有带章号打开时才递增，重复打开同一章也会重新选中。
- `knowledgeDraft`：知识库标签的所选资料与未保存的改动；页面随标签切换卸载后靠它留住。
- `draftLedgers`：编辑器后台草稿账本。 账本是技术状态，不是用户文件，不能混入可关闭的 tabs。
- `updateTabContent`：更新 Tab 内容（标记 dirty） 仅在「用户修改」时调用，会亮起未保存指示灯。
- `syncTabContent`：静默同步 Tab 内容（不标记 dirty，也不清除 dirty） 用于「AI 生成完成后刷新」、「打开文件刷新」等非用户编辑场景。
- `removeEditorExitSaveHandlers`：现行规则：编辑器组件在活动 Tab 卸载后仍保留注册，store 自己的移除路径才是处理器生命周期的边界（原文：Editor components keep their registrations across active-tab unmounts. These store-owned removal paths are the handler lifetime boundary.）
- `editorSaveHandler`：标签自身的保存入口：与退出前保存共用各编辑器注册的处理器；编辑器没有注册时为 null。
- `idOnly`：diff 类型每次内容不同，只按 id 精确匹配（不走 filePath 去重） 其他类型（含 review-report）按 filePath + type 去重

### `src/stores/editor-unsaved.ts`

- `countUnsavedEditorItems`：统计真正独立的未保存编辑项。可见 Tab 与其后台账本采用同一个键去重， 因此更新门禁既不会漏掉暂时不可见的跨项目草稿，也不会重复计数。
- `countUnsavedEditorItemsForProject`：只统计关闭指定项目时会被清理的可见 Tab 与后台草稿。

### `src/stores/project-store.ts`

- `setAiSources`：下次保存时随设定落库。
- 主进程已经写进库的设定字段，发布到界面并记为已保存。 keepUnsavedEdits：作者在设定页改过、还没保存的字段保持作者的值（仍算未保存）；否则一律换成库里的值。
- `publishSavedNovelConfig`：keep：'none' 全按库里的值；'unsaved-edits' 作者改过还没保存的字段保留作者的值；'current' 这些字段都保留界面上的值，只把它们记为已保存基准。
- `commitGeneratedNovelConfig`：现行规则：主进程校验冻结的来源并写入之后才把生成的字段发布到界面（原文：Main validates frozen sources and writes before publishing generated fields to the UI.）
- `persistEffect`：现行规则：已有的受保护主进程效果（如导入回执）替代直接的核心写入，可返回它实际保存的字段（原文：Existing guarded main effect, such as an import receipt; replaces the direct core write and may return the fields it actually saved.）
- `aiSources`：AI 写入后的来源标记，与设定在同一事务里落库。
- `removeRecentProject`：只移除最近项目记录，不删除项目目录或数据
- `saved`：现行规则：只有提交的字段成为正式数据，无关的作者编辑保持脏状态（原文：Only the submitted fields became formal data; unrelated author edits stay dirty.）
- 现行规则：正式效果成功后并发的作者编辑仍是脏草稿，调用方不能运行会用旧完整配置替换它的回调（原文：The formal effect succeeded. A concurrent author edit remains a dirty draft, and callers must not run callbacks that replace it with an older full config.）
