# 共享界面原语与面板的契约

2026-11-27，注释清理（#852）第 5 个 PR（src/components）。

## 背景

`src/components/ui/**`、`panels/**`、`dialogs/**`、`settings/**` 与 `ErrorBoundary.tsx` 提供对话框、提示条、弹层、菜单、分段控件、侧页、通知与 Agent 面板等原语。它们的注释写着焦点如何还、Portal 为何要挂在纸墨根、Esc 在哪一层生效、浏览器怪癖怎么绕，这些前提在 JSX 与 hook 里看不出原因。

## 决定

菜单、弹层与危险确认这类组件内浮层 Portal 到最近的 .paper-ink 根，取纸墨令牌与深色主题，不被滚动容器裁切；命令式弹窗与通知例外，它们挂在 body 下自带 .paper-ink 的共享宿主（ink-overlay）里，由宿主跟随主题并负责 .pi-prompt-layer 的叠放。受控打开的对话框自己记下焦点并在关闭时还回去，不依赖 Radix 的 Trigger。键盘与读屏行为尽量由原生控件提供，需要自绘时按 aria-pressed、aria-current、aria-expanded 的约定表达，不只靠颜色区分。危险操作先确认，影响较小的就地确认，可撤销的不用危险色也不先确认。旧组件沿用的变体与颜色变量在渲染时由桥接层换成纸墨写法，新代码不再写旧变体。下面按文件列出各条口径。

## 界面组件口径（注释清理 #852 第 5 个 PR，src/components）

### `src/components/ErrorBoundary.tsx`

- `fallback`：自定义的出错界面，替代默认的错误详情与重试按钮；传函数时拿到重试（清掉错误、重新渲染子树）。
- `ErrorBoundary`：全局 Error Boundary — 防止单个组件崩溃导致整个 React 树卸载

### `src/components/__tests__/icon-contract.test.ts`

- `componentFiles`：渲染进程里作者能看到界面文字的全部组件（不含测试）。图标只能来自 Lucide，不能用 Emoji 或字符充当。

### `src/components/dialogs/__tests__/import-novel-resume.browser.tsx`

- `shownIcons`：选中项只露对勾，不与「参考小说」的书本图标挤在一起；没选中的露自己的图标

### `src/components/dialogs/config-generation.ts`

- `configFieldsToExpand`：已有作者内容的长字段：AI 填充会保留原文并追加，开始前要让作者确认扩写。
- `startConfigGeneration`：按创作脑洞与当前规模在后台启动 AI 填充配置。规划环节没有可用模型、与正在运行的任务冲突时不启动，返回 false。 设定页的 AI 补全与单项生成用它。
- 后台执行 LLM 调用，由 WorkflowEngine 接管并显示运行状态。

### `src/components/dialogs/use-new-project-form.ts`

- `useNewProjectForm`：新建作品：名称与保存位置，创建后其余设定在设定页填写。

### `src/components/editor/RelationshipGraph.tsx`

- `RelationshipGraph`：不变式：关系投影用稳定 id 且有界，布局状态不出这个组件（原文：Stable-ID, bounded relationship projection. Layout state never leaves this component.）
- 图谱框窄时（1024 宽窗口的角色名单页约 385px）：工具条不越出画布框，中心人物让位给按钮，人物侧栏跟着收窄

### `src/components/editor/__tests__/planning-launch-entrypoints.browser.tsx`

- `outlineMarkFromPremisePage`：从前提文档页打开生成对话框，返回情节大纲那一行的标记。未确认的节默认勾选，已确认的默认保留。

### `src/components/editor/outline-recovery-view.ts`

- `phase`：editable：作者可以保存；saved：已保存，只能复制；waiting：生成还在进行；blocked：要重新生成、已续写过或读不出，不能写回。

### `src/components/panels/agent/AgentHeader.tsx`

- `skills`：Skill 列表（每次渲染重新读取，避免异步加载完成后仍展示旧列表）

### `src/components/panels/agent/AgentInputBox.tsx`

- 先重置为 0px，让 scrollHeight 正确反映内容高度，避免 flex 布局拉伸导致计算出很大的初始高度
- 监听尺寸变化以重新计算高度，避免刚挂载时宽度未稳定导致的 placeholder 异常换行撑起高度
- 让菜单组件通过 window 事件处理

### `src/components/panels/agent/__tests__/agent-locale.browser.tsx`

- 图标按钮悬停时仍有提示：空对话时「新建」为什么不能点，只写在提示里。
- 「更多选项」展开一块下拉，是展开按钮，不是开关。

### `src/components/settings/ModelNameField.tsx`

- `emptyHint`：列表还没拉到时由状态行说明原因；这里只说明输入的名称没有匹配的候选。
- 列表随文档流展开，收起会让下面的控件上移。鼠标按下引起的失焦要等这次点击完成再收起， 否则按下与松开落在不同位置，点击会丢。
- 获取期间按钮会禁用，焦点留在上面会丢。

### `src/components/settings/PromptSettings.tsx`

- 强制刷新用（保存/恢复后 getPromptSource 的结果会变）

### `src/components/stage/InkDialog.tsx`

- `footer`：底部按钮，主操作放最后。
- `keepOnOutsideClick`：点对话框外面不关闭：两步之间高度会变的对话框，双击第二下可能落到外面。Esc 与按钮照常关闭。
- `InkDialog`：不涉及危险的对话框（新建作品、移除书架记录、更新拦截）。危险操作用 ui/DangerConfirm。 与 DangerConfirm 一样 Portal 到最近的 .paper-ink 根，取到纸墨令牌与深色主题。

### `src/components/stage/ModelMissingNotice.tsx`

- `ModelMissingNotice`：未配置模型时的首次使用引导：书房与设定页同一句说明，并给出去设置添加的入口。

### `src/components/stage/ProgressRing.tsx`

- `ratio`：0 到 1。
- `ProgressRing`：进度环：底轨加按比例填充的弧，从十二点钟方向顺时针增长；半径取 size / 2 - stroke 与画板一致。是状态指示，不是图标。

### `src/components/stage/lazy-page.tsx`

- `FAILED_MODULE_URL`：Chromium 动态导入失败的消息：Failed to fetch dynamically imported module: <地址>。
- `lazyPage`：书房冷启动用不到的整页（设定页、设置页）拆成单独的代码块，外壳空下来后预先载入。 不用 React.lazy：它首次渲染一定挂起，Suspense 的揭示节流会让页面晚出现（见 RD-3 的 f89bc700）； 这里载入完成前什么也不画，预载入后打开页面时代码已在手里，直接渲染。 entry 是页面入口代码块的文件名前缀（构建产物为 `<entry>-<hash>.js`，开发时为 `<entry>.tsx`）。
- `attemptLoad`：Chromium 记住失败的动态导入，同一地址再 import 不会重新读文件；重试时给失败的入口地址加查询串，换一个模块记录。 失败的若是入口依赖的代码块，入口在这次会话里没法再载入，只按原路重试并保持失败态。
- `preload`：载入失败时清掉 pending，重试或下次打开页面会重新载入，而不是一直拿着失败的结果。

### `src/components/ui/ActionToast.tsx`

- ActionToast：带操作按钮的通知，例如工作流完成后的「打开查看」「忽略」。 与普通通知进同一个纸墨提示栈（ToastStack），只多了动作按钮。 用法： actionToast.show({ type: 'success', message: '草稿已生成', actions: [{ label: '打开查看', onClick: () => openDraft() }] })
- `onClick`：点击回调（点击后通知自动关闭）
- `variant`：按钮风格：次按钮（primary）或文字按钮（ghost）
- `actions`：操作按钮列表（最多 2 个）
- `duration`：自动消失时间（毫秒），设 0 表示不自动消失。默认 8000

### `src/components/ui/AlertDialog.tsx`

- 弹窗报错：需要作者明确知晓的关键错误（项目加载失败、文件读写错误等）。 渲染为纸墨提示框（InkPrompt），跟随主题。 用法： alertError('不是有效的项目目录', { title: '打开项目失败' })
- `alertError`：显示弹窗报错，返回 Promise（作者确认后 resolve）。也可以不 await。 @example await alertError('不是有效的项目目录', { title: '打开项目失败' })

### `src/components/ui/Check.tsx`

- `kind`：复选框用于勾选列表，开关用于立即生效的设置。
- `Check`：基于原生 checkbox，键盘与读屏行为由浏览器提供；开关形态加 role="switch"。

### `src/components/ui/Confirm.tsx`

- 异步确认对话框，替代 window.confirm()，返回 Promise<boolean>。 渲染为纸墨提示框（InkPrompt）；danger 时进场焦点落在「取消」上。 用法： const ok = await confirm('确定要归档吗？', { title: '归档' })

### `src/components/ui/DangerConfirm.tsx`

- `consequence`：后果，例如「将删除全部章节、蓝图与设定」。
- `recoverability`：能否恢复，例如「删除后无法恢复，项目备份不受影响」。
- `typeToConfirm`：删除整部作品时要求输入作品名，输入一致才可确认。
- `DangerConfirm`：不可逆、影响作品数据的操作用的危险确认对话框。 Portal 到最近的 .paper-ink 根而不是 body，才能取到纸墨令牌与深色主题； 原地的空 span 只用来找到这个根。 调用方都是受控打开、没有 Dialog.Trigger，Radix 关闭时无处还焦点，所以打开时自己记下焦点、关闭时还回去。
- `DangerConfirmBody`：输入框的值放在随对话框挂载的组件里：父组件不经 onOpenChange 直接关闭再打开，也从空白开始。

### `src/components/ui/Icon.tsx`

- `LucideProps`：Vela Icon 组件 统一 lucide-react 图标封装，提供标准化的尺寸系统。 图标尺寸规范： - 12px: 状态栏、徽章指示器 - 14px: 按钮图标前缀、树形项目图标 - 16px: 菜单项图标 - 18px: 工具窗口栏图标 - 22px: 活动栏图标 用法： import { Icon } from '@/components/ui/Icon' import { Sparkles } from 'lucide-react' <Icon icon={Sparkles} size={14} /> <Icon icon={Settings} size={18} />

### `src/components/ui/InkPrompt.tsx`

- `InkPromptKind`：alert：报错，带警示印、只有「确定」；notice：告知一件已经办完的事，不带警示印、只有「确定」；confirm：取消加确认；danger：后果用朱批排、确认为实心朱印，进场焦点落在取消上。
- `signal`：提示所属的事已经不在了（例如作者换了书）：撤回它，结果按取消算。
- `result`：第一次的决定。关掉后要淡出 140ms，这期间内容还在、按钮还点得到，后点的不能改写它。
- 关掉后 Radix 等 140ms 淡出走完、内容卸载才触发它（减少动态效果时立即），这时才把结果交给调用方
- `openInkPrompt`：在纸墨宿主里渲染一次性的对话框；关闭后卸载挂载点，再以用户的选择 resolve。

### `src/components/ui/InlineConfirm.tsx`

- `message`：写明后果与能否恢复，例如「清空后无法恢复这 12 条日志」。
- `returnFocusRef`：打开确认条的按钮，关掉后焦点回到它。确认条出现时这个按钮常常已经失焦：禁用了（Electron 里禁用的按钮立即失焦）， 或者被确认条替换掉了，所以由调用方指给它，不靠确认条出现那一刻的焦点。
- `InlineConfirm`：侧页内影响较小的危险操作用的就地确认条。出现时焦点落在取消上，Esc 取消。 确认条一消失焦点就丢了：还给 returnFocusRef，按钮已不可用（清空后无日志可清）或已移除时落到最近的可聚焦祖先。

### `src/components/ui/Input.tsx`

- `Input`：通用 Input 组件 type="number" 的增强行为： - 编辑中允许清空输入框（不会阻止删除操作） - 失焦时若为空值，自动恢复为 min 属性值（若设置）或 "0" - 自定义 onBlur 在兜底之后才被调用，只能在其后再改值，不能阻止兜底先触发 change
- `nativeSet`：通过 nativeInputValueSetter 触发 React onChange

### `src/components/ui/Lifecycle.tsx`

- `steps`：按顺序排列的步骤名，章节为写作、审稿、修稿、定稿。
- `current`：当前步骤下标；等于 steps.length 表示全部完成。
- `Lifecycle`：章节生命周期：已完成为墨色，当前为黛蓝并标 aria-current，未开始为浅线与说明色文字。

### `src/components/ui/MarkdownContent.tsx`

- `parseThinkSegments`：将内容按 <think>...</think> 标签拆分为段落 支持流式场景下未闭合的 <think> 标签

### `src/components/ui/Menu.tsx`

- `tone`：危险分组放在最后，与普通分组之间有分隔线，项目为危险色。
- `label`：触发按钮的可访问名称；只给图标时也作为 aria-label。
- `trigger`：文字触发按钮的内容与样式，例如顶栏的作品名加下拉箭头；label 仍作为可访问名称。
- `onClick`：键盘触发的 click（Enter、空格）detail 为 0，此时打开后把焦点移到第一项。

### `src/components/ui/Notice.tsx`

- `Notice`：页面内的提示条（继续上次、可恢复的草稿、建议等），不打断当前操作。

### `src/components/ui/Popover.tsx`

- `title`：弹层标题，同时是弹层的可访问名称。
- `Popover`：锚定在触发按钮下方的非模态弹层，打开时焦点进入弹层，Esc 关闭并回到触发按钮。

### `src/components/ui/SegmentedControl.tsx`

- `SegmentedControl`：互斥的少量选项；选中项 aria-pressed 为 true。整组只占一个 Tab 停靠点（落在选中项上），方向键与 Home/End 换选并移动焦点。
- 带修饰键的组合留给系统与外层快捷键（如 Alt+← 后退、Shift+方向键选字）。

### `src/components/ui/Sheet.tsx`

- `tabs`：侧页分页；给出时 children 是当前分页的内容。segmented 是标题下一条分段胶囊，underline 是下划线页签。
- `Sheet`：内容区右侧的按需侧页。由所在布局决定位置，侧页本身不遮挡正文。 非模态：打开时焦点移到标题，Tab 可以离开侧页；点在侧页空白处时焦点落在侧页自身（tabIndex=-1），Esc 仍然有效。 关闭时若焦点随侧页一起消失，就还给打开前的元素。
- StrictMode 会重跑 effect，那时焦点已在标题上；只记录本次打开前的元素。

### `src/components/ui/Toast.tsx`

- `ToastTone`：全局通知：轻量、非阻塞的操作反馈（成功、警告、普通信息、错误）。 关键错误请使用 alertError()，见 AlertDialog.tsx。所有通知进同一个纸墨提示栈（ToastStack）。 用法： toast.success('保存成功') toast.warning('字数超出限制')

### `src/components/ui/Tooltip.tsx`

- Vela Tooltip 组件 基于 @radix-ui/react-tooltip 封装，自动适配深色/浅色主题。 深色主题下显示浅色 Tooltip，浅色主题下显示深色 Tooltip。 用法： import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from '@/components/ui/Tooltip' <TooltipProvider> <Tooltip> <TooltipTrigger asChild> <button>悬停查看</button> </TooltipTrigger> <TooltipContent>提示文字</TooltipContent> </Tooltip> </TooltipProvider>
- `TooltipProvider`：全局 Provider（建议在 App.tsx 包裹一次即可）

### `src/components/ui/focus-return.ts`

- `rememberFocus`：记下此刻的焦点，返回把焦点放回去的函数。打开它的元素已被移除或已禁用时， 落到 container 最近的、仍在文档里的可聚焦祖先（带 tabindex 的侧页、内容区等），不让焦点掉到 body。 给了 openerRef 时还给它在那一刻指着的元素，不看记下时的焦点。
- `useDialogFocusReturn`：受控打开、没有 Dialog.Trigger 的 Radix 对话框用：Radix 关闭时只把焦点还给 Trigger，没有就落到 body。 remember 在 onOpenAutoFocus 里调（此时焦点还在打开它的按钮上），onCloseAutoFocus 直接交给 Content。 Radix 卸载后隔一个 setTimeout(0) 才调 onCloseAutoFocus：这期间确认动作可能已经把焦点交给别处（自动弹出的写作弹层）， 只有焦点还在对话框里或掉到了 body 时才还。

### `src/components/ui/ink-overlay.ts`

- `inkOverlayHost`：body 下唯一的纸墨宿主。挂在 body 上的浮层碰不到外壳根的 .paper-ink，所以宿主自带 .paper-ink 与 data-theme， 并跟随主题切换；它是 display: contents，不画底色、不建层叠上下文。
- `toasts`：提示栈的挂载点随宿主一起建并且是 live region：Radix 模态用 hideOthers 把其余节点标 aria-hidden 时放过已有的 [aria-live]， 模态开着时到达的通知读屏仍读得到
- `createInkOverlayMount`：宿主里放一个独立的挂载点，命令式弹窗用完即删。它是一层 .pi-prompt-layer，后弹出的整层画在先弹出的上面。
- `useInkOverlayHost`：组件里取纸墨宿主：渲染期不建节点，提交后在布局 effect 里取（同 use-paper-ink-root）。 取到之前为 null，调用方先不渲染 Portal（Radix 的 Portal 没有容器时会挂到 body）。
- 宿主要在提交后才建（渲染期不写 DOM），取到后在绘制前再渲染一次，和 use-paper-ink-root 同理

### `src/components/ui/use-anchored-layer.ts`

- `tabbablesIn`：浏览器按 Tab 会停的控件：折叠的 <details> 里、display:none 与 visibility:hidden 的控件不算。
- `useAnchoredLayer`：Menu 与 Popover 共用：浮层 Portal 到最近的 .paper-ink 根，按触发按钮位置 fixed 定位， 不被侧页等滚动容器裁切。下方放不下且上方更宽裕时向上展开，高度不超过所在一侧的视口空间，再多就在浮层内部滚动。 点击外部、焦点移到外部、触发按钮被滚动带走、改变窗口大小时关闭； Esc 关闭并把焦点还给触发按钮；Tab 离开浮层时先回到触发按钮，再由浏览器继续移动焦点。
- `placedAt`：定位时外层锚点的位置，滚动时与它比。量锚点不量按钮：按钮展开后有下沉 1px 的过渡，会被误当成被滚动带走。
- 打开时才找 Portal 的根：书架上每本书都有一个菜单，挂载时逐个查找会让每个菜单多渲染一次。
- `onFocusIn`：鼠标打开时焦点留在触发按钮上，Tab 会直接走到页面下一项，浮层不能还开着
- `onScroll`：只看外层锚点动没动：别处的滚动区（跟到最新一行的运行日志）滚动时浮层不必关

### `src/components/ui/use-paper-ink-root.ts`

- `usePaperInkRoot`：浮层（菜单、弹层、危险确认）Portal 的目标：离挂载点最近的 .paper-ink 根。 挂到 body 会脱离纸墨令牌与深色作用域；留在原处会被滚动容器裁切， 也会被带 transform、filter、contain 的祖先改掉 fixed 定位与层叠。 返回 undefined 表示尚未挂载，null 表示不在纸墨作用域内。
