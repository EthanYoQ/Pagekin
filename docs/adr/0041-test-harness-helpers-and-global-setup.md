# 测试辅助与全局 setup 的约定

2026-11-26，注释清理（#852）第 2 个 PR（test/）。

## 背景

`test/` 下的 setup 文件和通用辅助函数里，原有若干解释「这个辅助为什么这样做」的注释。具体到某个产品子系统的夹具注释，已并入该子系统的 ADR（0002、0013、0015、0020、0025、0031、0035 的「测试口径」）。本 ADR 收拢与具体子系统无关的部分。

## 决定

### 一、临时目录树的删除

- `removeTemporaryTree(target, parent)` 只删测试自己建的临时目录树。目标的真实路径必须严格位于 parent 的真实路径之下，否则拒绝删除。
- 先摘掉树里的符号链接与 junction，再递归删除。原因：用 Electron 作 Node 跑测试时，Electron 41 的 `fs.rmSync` 会跟进 junction 删掉链接目标，曾删光工作树的 `electron/` 与部分 `node_modules`（#449）。
- 它的测试（`test/helpers/__tests__/remove-temporary-tree.test.mjs`）模拟 r3-native 夹具：临时目录里有一个 junction，指向临时目录外、仍要保留的目录。删除后目录外的内容必须还在。

### 二、worker 的测试构建

- `portable-export-worker.ts` 把 worker 打成测试能跑的 ESM。输出放在仓库里，worker 里的 `createRequire` 才找得到 `better-sqlite3`。
- `electron` 保持外部依赖，测试走的是生产 worker 里的同一个空模块钩子，不另造一套替身。

### 三、全局 setup

- `setup-buffer-equality.ts`：Vitest 的通用相等对 Buffer 逐字节走迭代路径，约 5 ms 每 KB。先后快照项目数据库的测试，会在一条断言里花掉几秒。字节相等结论相同，改用原生比较。
- `setup-locale.ts`：渲染测试默认断言中文优先的产品文案。每个用例前把 locale 重置为 `zh-CN`，使测试基线不随运行机器的操作系统语言变化。
- `setup-paper-ink.ts`、`setup-stage-styles.ts`：与应用入口 `src/main.tsx` 一致，纸墨样式和新外壳样式在浏览器测试里各全局加载一次；原语组件和外壳组件本身不引入样式。

### 四、源码契约测试读源码

- 源码契约测试有意忽略检出的换行：同一份已跟踪源码在 Windows 上可能检出为 LF 或 CRLF。`normalizeSourceEol` 把 CRLF 和孤立 CR 规整为 LF。
- `readNormalizedSource` 读源码走与契约断言、内容哈希同一道换行规整边界，所以断言和哈希在两种检出方式下得到同一个结果。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/__tests__/agent-response-protocol.test.ts`

- 断言前提：历史上 null 或缺失的 arguments 表示无参数，不是原始值载荷，用例里的 value 取值看不出这条规则（原文：Historical null/missing arguments mean no arguments, not a primitive payload.）

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/__tests__/app-workflow-complete.test.ts`

- `notify`：测试口径：取 App 里真实的事件处理函数在新上下文里执行，而不挂载无关面板，函数体只见取文本与执行（原文：Execute the actual App event handler without mounting unrelated application panels.）

### `src/services/__tests__/legacy-roster-generation.test.ts`

- 测试口径：先打开一个已知句柄，再让下一次读取处于取消竞争，步骤顺序看不出这层用意（原文：Open a known handle before enabling the cancellation race on the next read.）

### `src/services/__tests__/prompt-local-qwen-contract.test.ts`

- `filled`：有内容的段落及其标题原样保留；只清掉其中的空条目。

### `src/services/__tests__/safe-call-diagnostic.test.ts`

- `requestBody`：变异意图：诱饵字段证明格式化器不会序列化任意输入字段（原文：Lures prove the formatter never serializes arbitrary input fields.）

### `src/services/agent/__tests__/agent-generation.fixture.ts`

- `AgentHostFixture`：夹具边界：合成的主进程传输只供消费方测试，不证明准入、来源校验、持久计账或真实供应商（原文：Synthetic main transport for consumer tests. It does not prove SQLite admission, main source validation, durable accounting, or real providers.）

### `src/services/agent/tools/__tests__/issue-90-agent-project-actions.repro.test.ts`

- `issuedActions`：夹具边界：这个启动器测试用合成的主进程签发动作，真实来源与动作准入由主进程 SQLite 测试覆盖，启动器、守卫、工作流注册、语言与取消保持真实（原文：This launcher test supplies a synthetic main-issued action. Real source and action admission are covered by the main SQLite tests; the launcher, guards, workflow registration, locale and cancellation below remain real.）
- 测试口径：启动器接缝测试观察期间保持真实工作流处于注册状态（原文：Keep the real workflow registered while this launcher-seam test observes it.）

### `src/services/generation/__tests__/context-length-failure.test.ts`

- `result`：工作流会话替执行器补上调用编号；这里直接接主进程运行时，同样补一个。

### `src/stores/__tests__/appearance-bootstrap.browser.tsx`

- `dependencies`：夹具边界：真实的 Chromium localStorage 与 DOM，只用确定性的主进程传输契约夹具（原文：Real Chromium localStorage/DOM, deterministic main transport contract fixtures only.）

### `src/stores/__tests__/editor-discard.test.ts`

- 取消按钮只关闭确认对话框，不调用 discardAndCloseEditorTab。

### `src/stores/__tests__/project-opening-notice.test.ts`

- `answerOpenAfter`：主进程拒绝打开：这里只看等待提示，回包内容无关。

### `src/stores/__tests__/theme-store.test.ts`

- `waitForMainReady`：夹具边界：确定性的主进程握手夹具，不断言真实桌面启动资格（原文：Deterministic main handshake fixture; does not assert real desktop startup qualification.）

### `src/stores/__tests__/workflow-store-generation-budget.test.ts`

- 工作流夹具显式提供桌面桥接；未知调用仍拒绝，避免掩盖真实 IPC 缺失。

### `src/stores/__tests__/workflow-store-resource-conflict.test.ts`

- 工作流夹具显式提供桌面桥接；未知调用仍拒绝，避免掩盖真实 IPC 缺失。

### `src/stores/navigation/__tests__/chapter-phase.test.ts`

- `hold`：下一次读修稿列表先按当时的记录取好，等它放行才返回。
- `phaseOf`：按数据库里的记录读出这一稿的 facts，再按稿状态判断它走到哪一步，与流程脊、单章视图同一条路径。

## 界面组件口径（注释清理 #852 第 5 个 PR，src/components）

### `src/components/characters/__tests__/CharacterCardImportButton.browser.tsx`

- 等待前提：已有确认对话框在 200 ms 退出动画后才结束，测试里的等待时长看不出来源（原文：Existing confirmation dialogs resolve after their 200 ms exit animation.）

### `src/components/dialogs/__tests__/import-novel-resume.browser.tsx`

- 运行侧页读恢复项：这里都没有。
- 先卸掉 beforeEach 在浅色下开的对话框，按这个主题重新打开，量的才是打开时的颜色而不是换主题的过渡

### `src/components/dialogs/__tests__/workflow-launch-dialogs.browser.tsx`

- `close`：修复角色同步会推一条成功通知；提示栈跨用例保留，关掉它免得盖住下一个用例对话框的按钮
- 大纲对话框按单批上限当场判无效，提交不可点；蓝图对话框在提交时拦。

### `src/components/editor/__tests__/CodeMirrorEditor-generation.browser.tsx`

- `selectLine`：三击选中一行，等选区工具条出现。工具条在下一帧定位后才渲染，不能在 act 里等它：act 结束前 React 不提交渲染。
- 等待前提：气泡定位在动画帧上提交，不能在 act 里等（原文：Bubble positioning commits on an animation frame; do not wait for it inside act.）
- 表单长高后在下一帧绘制前夹紧；量用户看到的那一帧，不量还没排版过的 DOM
- `overlapsColumn`：正文会滚过面板所在高度，所以只看水平方向是否重叠。

### `src/components/editor/__tests__/chapter-card-draft-ledger.test.ts`

- `blueprintHookSource`：蓝图页的数据逻辑在 use-chapter-blueprints.ts，旧外壳的 ChapterCardEditor 与新外壳的蓝图阶段共用。
- 远端尚未返回时，用户继续修改第一章。

### `src/components/settings/__tests__/model-discovery.browser.tsx`

- `AUTO_DISCOVERY_WAIT_MS`：比自动获取的防抖多等一点，确认这段时间里确实没有发请求。
- 浏览器的顺序：pointerdown，按下的默认动作让输入框失焦，pointerup，再 click。

### `src/components/settings/__tests__/writing-skill-settings.browser.tsx`

- text 是稳定函数，切换语言不触发重渲染；重新检查一次让卡片按中文重绘。

### `src/components/stage/__tests__/exit-guard.browser.tsx`

- `GuardedExit`：关窗守卫由 App 在外壳之外持有；测试按 App 的方式把它接到退出确认上。

### `src/components/stage/__tests__/stage-landing.browser.tsx`

- `Spine`：与 StageShell 同样接线：落点与流程脊读同一份视图。
- `open`：像 openProject 一样换上这次打开：主进程签发的会话、新的项目对象（标签已被清掉）。
- `installProject`：第 1 章定稿，第 3 章草稿已有一份审稿：没读到它的记录时只能按稿状态估计成「待审稿」。落点是最后一章在写的： 按参数第 2、4 章也是草稿时落在第 4 章，第 2 章定稿、没有第 4 章的稿时落在第 3 章。第 3 章那一稿第 n 次读审稿记录要等 release(n) 才返回，其余读取立即返回。

### `src/components/stage/__tests__/stage-locale.browser.tsx`

- `readableText`：作者与读屏读到的文字：去掉 aria-hidden 的装饰（顶栏的「墨」字印章在两种语言里一样）。

### `src/components/stage/__tests__/stage-open-chapter.browser.tsx`

- `installDrafts`：主进程的草稿接口：每章一份草稿，按章设定返回前的延迟，或直接失败。

### `src/components/stage/__tests__/stage-press.browser.tsx`

- `pressed`：键盘按住空格就是按下态（:active），不受指针悬停干扰。
- `mousePressed`：鼠标在元素中心按住：:active 而不是 :focus-visible。

### `src/components/stage/__tests__/stage-root.browser.tsx`

- `layer`：Radix 让下层的模态不接指针，elementFromPoint 会跳过它；放开之后取到的才是画在最上面的那一层
- `topLayerAt`：画在元素中心最上面的那一层对话框。Radix 让下层的模态不接指针，elementFromPoint 会跳过它；量的时候临时放开，量完还原。
- `hitOutside`：下层对话框露在上层对话框外面的一点（上沿、下沿或两侧）上画在最上面的元素：上层的遮罩该把它压住，不出重影。 量法同 topLayerAt，临时放开指针。
- 退出确认没弹出时宿主里没有它的节点：Radix 1.1 的 Portal 随 open 挂载，弹出时才排到已有提示之后
- `alerted`：提示写得长，比退出确认高，上下沿露在退出确认外面
- `promptElement`：退出确认弹出后提示所在的层被标 aria-hidden，按角色找不到了；先记下节点

### `src/components/stage/__tests__/stage-sheet-room.browser.tsx`

- `renderAt`：外壳里放工作区的那一栏宽 width：面板右缘留 10px，所以内容面板（侧页与内容区所在处）比它窄 10px。
- `coveredBy`：元素整个落在侧页的横向范围里：侧页浮起时它被完全盖住。
- 夹具里页头动作约 344px 宽：内容区 710px 时标题还有约 246px，放得下「故事的骨架」，动作应与标题同一行并靠右（与 master 一致）

### `src/components/stage/__tests__/stage-shell-work-dialogs.browser.tsx`

- `open`：像 openProject 一样换上这次打开：主进程签发的会话、新的项目对象，正文阶段的标签。

### `src/components/stage/__tests__/stage-shortcuts.browser.tsx`

- `press`：在 target 上派发一次按键，返回事件；一路冒泡到 window，和真实按键经过的监听器相同。

### `src/components/stage/__tests__/stage-spine.browser.tsx`

- `draft`：时间取数据库 datetime('now') 的写法；不给时按版本号排在同一天里。
- `WRITING`：写作中的作品：1、2 章定稿，3 章已审稿（草稿上有一份审稿，还有一份旧草稿归档），4 章已修稿，5 章草稿，6 章正在生成。

### `src/components/stage/__tests__/stage-tab-menu.browser.tsx`

- 下面按坐标找「标签操作」上面压着什么，视口要装得下整条 1280 宽的标签条
- 落点可能是按钮里的图标（SVG 没有 click()），按真实点击派发冒泡的 click

### `src/components/stage/__tests__/stage-visual.browser.tsx`

- `accentPixels`：返回一个函数：截 element 的图，数接近 --accent 的像素（每通道差之和不超过 60）。
- `ringShown`：截图按测试页缩放，像素数不是固定值：拿同一时刻去掉列表项 content-visibility（不裁）的截图当整圈的参照
- 指针可能还停在上一条用例留下的位置，先挪到别处
- 按钮与图标宽度奇偶不同时居中差半像素

### `src/components/stage/architecture/__tests__/architecture.browser.tsx`

- `started`：启动的工作流只含勾选的那几节，步骤 key 就是实际交给后台的节。
- `outlineBody`：按章写好的大纲正文，与主进程逐章生成的格式相同。
- `seedPartialOutline`：已有第 1–16 章大纲（全书 24 章），分批检查点可用。
- 名单快照换了不必再读一遍另三节：打开时一轮，重读名单后也不加。
- 最后一章生成完、候选已齐，正式保存时被来源检查拒绝：检查点仍记着本批未完成，同样只能重新生成。
- 重写第 1–5 章的那一批被打断：检查点记的进度是开跑前的 0，正式大纲仍是第 1–16 章。
- `phase`：刷新会连带流程脊等别处重读同一份数据：第一次刷新发出的都压住，之后的重读挂起，只比这两次刷新的先后。
- 主进程收到请求就同步记下放弃，回复晚一点才到渲染端。
- `repeated`：紧接着的第二次读取返回 superseded，模拟刷新中途恢复稿被补齐。

### `src/components/stage/blueprint/__tests__/blueprint-card-notes.test.tsx`

- `renderChineseCard`：renderToStaticMarkup 读 zustand 的初始状态，卡片直接选的 locale 是加载时按系统语言定的，setState 改不到； 先固定系统语言（Node 20 没有全局 navigator，卡片的依赖加载时还会读 userAgent，所以整体替换），再重新加载组件和语言 store。

### `src/components/stage/blueprint/__tests__/blueprint.browser.tsx`

- 用以 /src 开头的路径：检出路径含空格时（本机 Vibe Coding Project），浏览器模式匹配不到相对路径的模拟。
- `refreshBlueprints`：后台生成提交一段蓝图、定稿、删除或清空之后，蓝图页都会收到这条刷新。
- 视口变化的 resize 事件可能晚于渲染才到，浮层收到 resize 会关闭：先等它派发完。
- `toasts`：「不再恢复」的撤销提示条 8 秒后才消失，留着会和下一个用例的「撤销」重名
- 确认框是模态的，页面其余部分对辅助技术隐藏，直接读选中的那一行。
- `runId`：主进程收到请求就同步记下放弃，回复晚一点才到渲染端。

### `src/components/stage/chapter/__tests__/chapter-fixture.ts`

- `restoredHistory`：修出它的审修循环来自恢复前；unbound 是存档时循环读坏被省略、修稿留着却没有循环。
- `createChapterBackend`：一章的假数据库：草稿、审稿、修稿、复验周期与后处理，按主进程的通道语义回答。 测试改它的状态来摆出各个阶段，再读 calls 里的写入断言界面交给了主进程什么。
- `staleOnAccept`：接受时这些建议的蓝图已被改过，主进程判为过期。
- `now`：和主进程 datetime('now') 同样写法的时间，每次写入往后走一秒，先后可比。
- `reviewFix`：只有按审稿意见修出的稿属于复验周期；直接修稿合并不动周期，也不复验。
- `setCycle`：和主进程一样：AI 审稿开一个复验周期，修稿生成后为 generated，合并提交后为 merge-committed。
- `addRecheck`：和主进程一样：合并后的自动复验另存一份审稿（每项带 findingId，没有自己的复验周期）， 逐项结果写回原审稿的周期，周期记为已复验。

### `src/components/stage/chapter/__tests__/chapter-lifecycle.browser.tsx`

- 用以 /src 开头的路径：检出路径含空格时（本机 Vibe Coding Project），浏览器模式匹配不到相对路径的模拟。
- `openDraft`：按流程脊的方式载入这一章的稿，再打开它的单章视图。
- `toggle`：勾选框藏在纸墨的方框后面，作者点的是整行标签。
- `started`：工作流定义里能比较的字段：类型与标题。
- `second`：第二次审稿留下新的审稿与它自己的复验周期；审稿工作流结束后单章视图重读这一稿的审稿。
- 真实模型给的「未发现客观问题」：几条都是通过或待作者判断，没有一条默认要修。
- `mountWithSpine`：单章视图旁边摆上真实的流程脊，两边读的是同一份作品数据。
- `holdReviewRead`：卡住确认清单读审稿原文的那次 db:review-get-full，返回放行函数。
- `switchTo`：换到另一次打开：作品与会话一起换，作者在新作品里开着运行侧页。
- `openLongMerge`：合并视图共 16 处改动（每十段改一处）。
- 编辑器量完行高、侧页挤窄纸面后正文还会变长，每次重试都重新滚到底。
- 把下一个焦点摆在旧条高之下、新条高之内：只按旧条高让位时浏览器认为它已可见，不滚动
- `frame`：作者按键前至少过了两帧，条高的变化已经画出来
- `failCycleReads`：之后的审修循环读都失败；给了审稿 id 时只让那份审稿的读失败。

### `src/components/stage/chapter/__tests__/chapter-safety.browser.tsx`

- `occupiedToast`：CodeRabbit（#587）：有未保存修改时，审稿和修稿曾先把修改写盘、再说「正文保持原样」。
- `AUTO_FINALIZE_TITLE`：OCR 意见（#587 第 3 条）：第 5–6 章批量自动定稿不占第 3 章，只占定稿要更新的全书共用资料。
- 批次正在写第 6 章时只是预留了共用资料，定稿还没开始。

### `src/components/stage/chapter/__tests__/inline-recovery.browser.tsx`

- `interruptedSelectionRun`：请求发出前关闭应用留下的第 3 章选区润色运行。执行完的视图照实机：状态仍是 running，句柄换成这次打开。
- `withAnnotationReviewBackend`：批注统一修改走另一条运行（runId batch），选区运行沿用前面的夹具。

### `src/components/stage/chapter/__tests__/later-blueprint-check.browser.tsx`

- `graph`：图生成的开跑与执行换成可控的假客户端，读建议和接受仍走章节假后端。

### `src/components/stage/chapter/__tests__/restored-publication.browser.tsx`

- `openChapterThree`：侧栏点第 3 章走的就是 openChapter：没开过就读正文开新标签，开着就切过去。

### `src/components/stage/characters/__tests__/characters.browser.tsx`

- `dialogDescription`：纸墨对话框标题下的说明，也是对话框的无障碍描述。
- `fixtureConsent`：外发确认这一步作者读到的全文：发什么、发给哪个模型与端点、确认前不写名单。
- 宿主 1200 宽；视口比它窄时焦点移到屏外按钮会滚动页面，滚动事件晚一帧到达时会关掉刚打开的菜单。
- `fitCases`：740 与 994 是 1024、1280 宽窗口里角色名单页实测的宽度，600 是 1280 宽窗口开着运行侧页时的宽度（#465）。
- `select`：原生下拉框的箭头画在内容区里：同样样式、只含这一个选项、按内容取宽的副本有多宽，选中它时就要多宽才放得下。
- `crampedInputs`：至少放得下三个汉字。
- `ipcError`：Electron 把主进程的异常包成这样交给页面。
- `profileHeadCases`：角色名单页宽：1024 宽窗口约 738px，1280 宽约 994px（窗口宽减去流程脊与边距）。
- 1024 宽窗口去掉流程脊与边距，角色名单页约 738px：名单 272，档案两侧各留 40，图谱框只剩约 385。
- `unreachable`：只看名单页自己的层：被裁掉的控件在那个点上不会出现，被页内元素盖住时最上面的是别人。别的用例留下的全局通知不算。

### `src/components/stage/history/__tests__/history.browser.tsx`

- `input`：与 DraftRepository.create 一致：版本号在事务里按现有最大版本加一分配，不用调用方传的值。
- 估算出 v3 之后、新建之前，后台运行又给这一章写了一稿 v3。
- `loadingShown`：作者看得见的「正在读取」：在页面上且不透明。

### `src/components/stage/knowledge/__tests__/knowledge.browser.tsx`

- `PAGE_LANG`：应用切换界面语言时会改 <html lang>，按钮的字距跟着 :lang() 变；量宽度的用例要照样设，结束后还原。
- 定稿经 kb:import-text 收入，和导入资料一样有项目副本；只有定稿登记里的章号能把它认出来。
- `visibleWords`：页面上作者能读到的全部文字：正文、可访问名称、提示与占位。
- `wordCollector`：作者在页面与提示里读到的全部文字：每一步收一次页面，再加上弹过的提示。
- `expectExplained`：主进程只交错误码（#474 B3）：更新检索、保存副本与检查重建被拒时，提示按界面语言说明，不露码。
- 旧向量迁移阻断时主进程按系统语言写 error、码放在 errorCode：以界面语言为准。

### `src/components/stage/library/__tests__/library.browser.tsx`

- 书房按桌面宽度排版。默认 414 宽的视口放不下，对话框关闭后焦点回到菜单按钮会横向滚动页面，晚到的滚动把刚打开的菜单关掉。
- 真实应用的最小窗口（electron/main.ts 的 minWidth、minHeight）。

### `src/components/stage/plot/__tests__/plot.browser.tsx`

- 可写的 db 通道由主进程包装层把异常折成 { success: false, error: String(error) }。

### `src/components/stage/run/__tests__/run-sheet.browser.tsx`

- 已经保存的审稿不再标「可恢复」（本批真实模型实测缺陷 4：合并并定稿后仍列为可恢复）。
- `close`：撤销提示条要 8 秒才走，关掉它，下一个用例的提示条才不会并进来

### `src/components/stage/settings/__tests__/settings.browser.tsx`

- `Shortcuts`：与 StageShell 同样接线：外壳的快捷键先于设置页注册，沉浸写作读 stage-store。
- 架构生成没有单独选模型，用的是默认模型 flash。

### `src/components/stage/settings/__tests__/stage-models.browser.tsx`

- Windows 与 Linux 上方向键在收起的下拉里直接换选项并触发 change；macOS 会弹出选项面板，所以这里直接派发 change。

### `src/components/stage/setup/__tests__/setup.browser.tsx`

- 换作品时会话先失效，save 返回 false 就停了，走不到位置比较。
- 上一条用例留下的提示会挡住指针，直接聚焦后用键盘输入。

### `src/components/stage/trash/__tests__/trash-dialog.browser.tsx`

- `broken`：这条通道的 IPC 调用直接 reject，模拟主进程没回话。
- `Harness`：换了作品后回收站变成未知，这里仍挂着对话框，用来测它自己的会话检查。
- 前面用例留下的提示条叠在小视口的对话框上会挡住按钮，给足高度。

### `src/components/stage/write/__tests__/write-popover.browser.tsx`

- 用以 /src 开头的路径：检出路径含空格时（本机 Vibe Coding Project），浏览器模式匹配不到相对路径的模拟。
- `launched`：一次启动交给工作流的全部输入：ChapterInfo、选项，工作流定义里可比较的字段，以及启动途中读写过的作品文件。
- `render`：写作按钮与页面里一样靠右，弹层向左展开。
- 视口变化的 resize 事件可能晚于渲染才到，浮层收到 resize 会关闭：先等它派发完。
- `expectedLaunch`：旧的章节创作对话框在同一蓝图下交给工作流的全部输入（RD-10 删除对话框前从它取得），弹层必须与它一致。

### `src/components/startup/__tests__/RendererStartup.browser.tsx`

- `OLD_SHELL_STORAGE_KEY`：旧版本单独存的界面版本键：迁移不读也不写。
- 夹具意图：修复合成偏好后显式重试，不重建组件（原文：Explicit retry after repairing the synthetic preference, without recreating the component.）
- `luminance`：计算出的颜色的相对亮度（0 黑 1 白）。先画到画布上换成 sRGB，oklch 等写法也能比。

### `src/components/ui/__tests__/color-contrast.ts`

- 测试用的颜色换算：WCAG 相对亮度与对比度，半透明色叠到底色上。
- `channels`：rgb() 的 0–255 通道；color-mix 得出的 color(srgb …) 是 0–1，换算到同一刻度。

### `src/components/ui/__tests__/ink-overlay.browser.tsx`

- `promptClosed`：命令式弹窗关掉后先淡出 140ms，内容卸载后才 resolve。分几段等：一个 act 里的状态更新要等 act 结束才提交， 一口气等 350ms 时淡出结束后的卸载会拖到断言之后。
- `stackPixels`：截 element 所在区域的图；返回按视口坐标取像素与数像素的函数（截图可能按测试页缩放）。
- `clickScrim`：遮罩在对话框底下，点它的左上角才算点在对话框外。
- `clearToasts`：动作失败会再推一条出错通知，所以一轮一轮关到栈空。
- 正在退场的卡片 140ms 后才从栈里拿掉，等它走完再拆宿主
- `backdrop`：卡片背后铺一层纯红：卡片哪里变透明，截图里那里就带红
- `reddish`：卡片里没有字的一段（标题只有「出错 N」，右边留到关闭按钮之前），上下避开圆角边的抗锯齿；文字的彩色抗锯齿边会被当成红
- `bandTop`：栈的上沿（卡片列中间）被淡出带盖着，不是背后的页面
- 滚到顶时上面没有卡片，淡出带消失：栈的上沿与最早一条的圆角外都露出背后的页面，卡片顶上没有盖着东西
- `WorkMenu`：照顶栏作品菜单的接法：菜单项打开受控的旧对话框与清除确认，都没有 Dialog.Trigger。

### `src/components/ui/__tests__/paper-ink-fonts.browser.tsx`

- 本文件只引入纸墨样式，不引入旧外壳的 src/index.css，用来证明 RD-10 删掉旧样式后字体仍然可用。

### `src/components/ui/__tests__/paper-ink-primitives.browser.tsx`

- `expectFocusRing`：焦点环由令牌 --focus-ring 绘制：外圈为强调色。
- 说明文字提亮后不能贴上次要文字，也不能和占位一样淡：相邻两级的对比度至少差 1.25 倍
- Tab 若走出测试文档，Shift+Tab 回到哪里取决于外层页面与浏览器，所以在侧页之后放一个可聚焦元素。
- 排在 useAnchoredLayer 的定位之后：打开的同一次提交里，弹层按旧位置定好，滚动区才把按钮带走
- 用户点的是已经画在屏上的按钮：先等它画出来，展开后按下下沉的过渡才会真的播放
- `ClearLog`：照运行侧页「清空日志…」：确认条出现期间触发按钮禁用，清空后再也不可用。

### `src/components/ui/__tests__/reduced-motion.ts`

- `withReducedMotion`：在「减少动态效果」下跑一段断言，跑完复位成 Playwright 默认的 no-preference。 不能用空的 features 复位：那会退回系统设置，CI 的 Windows Server 关了动画，同一页里之后的用例都会变成减少动态效果。

### `src/components/ui/__tests__/viewport.ts`

- `resizeViewport`：viewport() 返回时尺寸已变，resize 却要等下一次渲染才派发；不等它，它会落在之后打开浮层的那一刻，被 use-anchored-layer 当成窗口变化把浮层关掉。
