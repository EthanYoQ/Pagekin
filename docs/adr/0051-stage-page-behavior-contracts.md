# 分阶段界面各页的行为与布局契约

2026-11-27，注释清理（#852）第 5 个 PR（src/components）。

## 背景

`src/components/stage/**` 里的书房、设定、架构、蓝图、单章视图、角色、版本历史、知识库、剧情、运行侧页、设置与回收站等页面，把 ADR-0021 的分阶段流程落成具体界面。这些页面的注释写着「为什么这样排」「哪些状态只属于这次打开」「焦点与 Esc 归谁」「读失败时界面该显示什么」，函数体与 JSX 只能看到结果，看不到这些前提和取舍。

## 决定

页面只呈现，数据与动作来自对应的 hook 或工作流，页面不自行判断运行状态。所有只属于一次打开的状态（回收站确认、清空确认、写作请求、选区）随作品会话冻结，换作品即失效。读失败不当成「没有」：空列表、计数与进度都要先看这份数据是否真读到过。浮起的侧页、设置页、对话框与输入法组字各自决定 Esc、Tab 与快捷键归谁，外壳快捷键在模态层开着时不再开新层。界面上能提示作者怎么做的地方，写保住了什么与能怎么办，不暴露异常原文。下面按文件列出各条口径。

## 界面组件口径（注释清理 #852 第 5 个 PR，src/components）

### `src/components/stage/ExitGuardDialog.tsx`

- `ExitGuardDialog`：关窗时还有未保存内容或运行中的任务。判定与处理在 useWindowCloseGuard，这里只是呈现。 挂在命令式弹窗所在的纸墨宿主里、自成一层 .pi-prompt-layer：退出确认与错误提示谁后弹出谁在上面。

### `src/components/stage/RunCapsule.tsx`

- `RunCapsule`：顶栏运行胶囊：这部作品有运行时显示进度；没有运行时，若这部作品最近一次结束的运行是完成、且结束不到 1.8 秒，显示「运行已完成」。 完成态由这次运行的结束时间推出，接着又有运行、运行失败或换了作品时自然不再显示。
- `DoneCapsule`：按 until 重新挂载：挂载时已过期（这条完成运行进入历史时就晚了）直接不显示，否则到点收起。

### `src/components/stage/StageRoot.tsx`

- `StageFallback`：外壳渲染出错：已打开的页面与没保存的内容还在内存里，重试重新显示界面；关窗时退出确认照常问保存。
- `StageRoot`：外壳的根：纸墨作用域、渲染出错兜底与退出确认。 退出确认挂在外壳之外，外壳渲染出错后关窗仍能保存或放弃未保存的内容。

### `src/components/stage/StageShell.tsx`

- `openedWork`：这一次打开的作品；同一路径重开会换租约，也算另一次。
- `settingsOpen`：设置页属于打开它时的书房或作品；在书房与作品之间切换时收起。

### `src/components/stage/StageSpine.tsx`

- `settingsOpen`：设置页开着时只有「设置」是当前位置。
- 章节列表可能晚于当前章出现（打开作品时草稿索引后到），列表出现时也要把当前章滚进来

### `src/components/stage/StageTabMenu.tsx`

- `CloseTabsConfirm`：一次关几个标签时，有未保存修改的那几个合在一起问一次（没修改的已经关上）。 由内容面板挂在标签条外面：关掉没修改的之后只剩一个标签时标签条会收起，确认不能跟着它卸掉。
- `StageTabMenu`：标签条右端的菜单：列出已打开的页面供跳转（F-184），并能关闭当前、其他、右侧或全部标签（F-183）。

### `src/components/stage/StageTabs.tsx`

- `StageTabs`：内容区标签条。只有一个标签时由外壳收起；←→ 在标签间移动，Delete 关闭当前聚焦的标签。
- 标签条隐藏了滚动条，激活标签在可视区外时作者看不到它，也没有可拖的滚动条

### `src/components/stage/StageTopBar.tsx`

- `crumbs`：位置面包屑，最后一项为当前页。
- `focusTitle`：沉浸写作时左侧显示的当前页：正文章节显示章号与章名，其余显示标签名。

### `src/components/stage/StageWorkspace.tsx`

- `TabContent`：每种标签对应的页面。架构文档（含大纲恢复稿与角色名单全文）沿用 ArchFileViewer。
- `floatingSheet`：侧页浮起（stage-panel.css 的容器查询）时才盖住内容区右侧；以样式为准，不在这里重复浮起的宽度阈值。
- `moveFocusOffSheet`：浮起时焦点不停在被侧页整个盖住的控件上（内容区与设置页都算；Tab、方向键、程序化 focus、窗口变窄都算）： 顺着焦点移动的方向跳到下一个看得见的，后面没有了就进侧页，前面没有了就停在所在区域本身（可聚焦时）或进侧页。
- `follows`：方向键换选的分段按钮在换选前还是 tabIndex -1，不在 Tab 序列里，所以按文档位置而不是序列下标找下一个
- `closeFloatingSheet`：浮起的侧页盖着内容区，焦点在内容区时 Esc 也收起它；并排时 Esc 只在侧页里有效，与原来一样。 打字处（输入框、正文编辑器）与输入法组字时的 Esc 属于输入，设置页与对话框的 Esc 归它们自己。
- `sheetMounted`：窗口变窄让侧页浮起时没有焦点事件，焦点可能还停在刚被盖住的控件上：主区域尺寸变化时查一次。
- `showTabs`：设置页盖在内容区上，标签内容保持挂载（编辑器的撤销历史、滚动位置不丢），运行侧页照常在右侧。

### `src/components/stage/__tests__/stage-spine.browser.tsx`

- 用户决定 B（#394 §6）：已有蓝图时架构没写完不拉回架构，落点跳到下一个未完成的阶段。
- `written`：已有正文就落在写作位置：没有蓝图（大纲没写完或已写完）也不落到空的蓝图页。
- 用户决定（#407 第 2 轮）：几章都在写时落在最后一章在写的。

### `src/components/stage/architecture/ArchitectureGenerateDialog.tsx`

- `ArchitectureGenerateDialog`：生成架构的确认对话框。表单与校验沿用 ArchitectureConfirmDialog 的 useArchitectureConfirmForm，这里只换成纸墨样式。

### `src/components/stage/architecture/StageArchitecture.tsx`

- `StageArchitecture`：架构阶段：故事前提、角色名单、世界观、情节大纲四节。编辑一节打开它的文档标签，角色名单打开名单页； 数据与操作来自 useArchitectureOverview。
- `filled`：页头计数与主按钮只数已确认的节（徽标「已确认」）：部分完成、不完整、待处理都不算。
- 清空确认打开时冻结的会话：确认时作品已换就什么也不写。

### `src/components/stage/architecture/architecture-sections.ts`

- `SectionBadge`：一节的状态徽标。「已确认」即 overview.confirmed（流程脊用同一判定，见 checkArchConfirmed）； 其余几种是这节虽有或没有内容、但需要作者处理的情况。
- `kind: 'partial'`：大纲分批生成，已覆盖到第 coveredTo 章。
- `kind: 'incomplete'`：大纲有一批被打断或正在生成；前提、世界观有内容但还不到确认门槛。
- `kind: 'candidate'`：还没有正式内容，只有一份未完成候选。
- `kind: 'attention'`：角色名单需要显式修复或采用。
- 有内容但不到确认门槛（作者写的短内容）：与生成对话框的状态文字一致，叫「不完整」而不是「待生成」。
- `synopsisStarted`：大纲有内容但还没写到第 1 章以后：不到确认门槛的短大纲算不完整；只有第 0 章序章算还没开始（与生成对话框同一判定）。
- `ArchitectureMainAction`：架构阶段唯一的主操作：一节都没确认时生成架构，有缺口时继续生成，四节都已确认时进入蓝图。
- `excerpt`：卡片上的一句摘要：取正文去掉标题行与 Markdown 标记后的开头；只有标题时退回标题文字。省略号随界面语言（「……」或「…」）。

### `src/components/stage/blueprint/BatchWriteDialog.tsx`

- `BatchWriteDialog`：批量创作：按蓝图连续写几章。每次打开都是新的实例，上一次选的模型不会带到下一次。

### `src/components/stage/blueprint/BlueprintAiCheckParts.tsx`

- `BlueprintAiSummary`：这次点按钮的总结，页面级，因为结论常常不在当前选中的章。

### `src/components/stage/blueprint/BlueprintCard.tsx`

- `BlueprintCard`：单章蓝图：标题、定位、出场人物、主角小目标、冲突与转折、悬念钩子、作者微操指导、章节要点。章号是稳定标识，只读。
- 正在输入的人名只属于当前这一章；换章时清空，不重建整张卡片（几百章换章要快）。
- `cardRef`：卡片不随换章重建，换章时滚回顶上。
- `Notes`：编辑态按章号重新挂载：换走再换回仍是排版。
- 从空白开始写也留在输入框里，不在打出第一个字时换成排版。

### `src/components/stage/blueprint/BlueprintPlanList.tsx`

- `PlanItem`：单独记忆每一行：换章或改一章时，几百章的列表只重画变了的那几行。

### `src/components/stage/blueprint/BlueprintRecovery.tsx`

- `BlueprintRecovery`：蓝图恢复稿（F-054）：上次生成中断后恢复出的蓝图文本。作者补齐后选「保存到第几章」，只把连续完整的章节写进蓝图，不调用模型； 也可以接着生成缺少的章节。原始候选随时可展开对照。

### `src/components/stage/blueprint/GapNotice.tsx`

- `GapTrash`：缺口段在回收站里的那一项；null 是确认不在，unknown 是回收站还没读到。
- `unsaved`：单章视图只读已保存的蓝图：这一章蓝图还没保存时不给写作入口。

### `src/components/stage/blueprint/GenerateBlueprintsDialog.tsx`

- `showExisting`：指定范围只从接着的那一章往后补，从不覆盖已有蓝图，所以这时不给覆盖选项。

### `src/components/stage/blueprint/StageBlueprint.tsx`

- `StageBlueprint`：蓝图阶段：章节规划列表与单章蓝图编辑。主操作是写下一章（拆分按钮带写作弹层）；没有可写的章时主操作是 AI 生成蓝图。 数据来自 useChapterBlueprints；未保存提示只在顶栏，⌘S 走同一个退出前保存。
- 「已记下」和它的撤销只属于当前这一章，换章后不再显示。
- 写作请求只由那一章的写作按钮接手：下一章在本页，缺口章在它的单章视图。那一章现在写不了时丢掉请求，免得以后突然弹出。
- `generate`：确认框不叠在生成对话框上：先收起对话框再问。作者取消时对话框原样回来，不当作错误；启动失败时回来并写明原因。
- 只有第一次读取（含换作品）才整页换成读取中；之后的重新加载保留页面、打开的弹层与对话框，作者的输入不丢。

### `src/components/stage/chapter/ChapterHead.tsx`

- `ChapterHead`：章节头：大号章号、「第 N 章 · 定位」、标题与右侧的版本切换器，下面是生命周期条。沉浸写作时只留标题。

### `src/components/stage/chapter/ChapterPlan.tsx`

- `ChapterPlan`：待写章的单章视图：本章蓝图只读展示，主按钮「写作此章」按蓝图写，箭头弹层只改本次模型与指导。 这一章有了稿（写完了，或在别处写好）就在这个标签的位置换成那一稿。
- `writeRequest`：没有蓝图就没有写作按钮来接手写作请求；留着它，等这一章补上蓝图后会在蓝图页突然弹出写作弹层。页面开着之后才到的请求也一样。

### `src/components/stage/chapter/ChapterView.tsx`

- `syncStickyTopVar`：条高会随审稿读完出现、纸面宽窄变化；chapter.css 的 scroll-padding-top 与搜索面板 top 读这个变量。
- `ChapterView`：正文单章视图：章节头、生命周期、章节动作条、版本切换器与纸面正文。待写章显示本章蓝图与写作此章。 审稿报告是视图里的侧页，修稿合并在纸面上逐段选择，定稿后显示后处理四步；全程不需要离开这个标签。
- `sheetBeforeDock`：批注坞顶掉的侧页，批注用完放回；作者已另开别的则不动。
- `reviewReady`：数据没读全就摆动作条会闪别的主按钮，还会重置清单状态。
- 请求只交给看得见的编辑器；被合并视图或批注审阅盖住时留在 store，露出后再交。交接后清掉，重挂不会重开气泡。
- 换稿从点击到新稿换上之间锁住正文：期间发起的批注修改会随旧稿一起卸载。

### `src/components/stage/chapter/LaterBlueprintSuggestions.tsx`

- `pendingOnly`：只留没处理的卡和这次刚处理的卡，处理过的旧卡不再占地方。

### `src/components/stage/chapter/MergeView.tsx`

- `sameLabel`：一个未改动片段在合并视图里只占一行说明；空行锚点不显示。
- `MergeView`：修稿合并（ThreeWayMerge 的数据逻辑）：每处改动选用原稿、用修稿或手动编辑，也可以全部用原稿、全部用修稿。 完成合并交出的正文就是按选择拼出的文字；稍后再合并只收起视图，修稿仍待合并。

### `src/components/stage/chapter/VersionSwitcher.tsx`

- `VersionSwitcher`：章节标题旁的版本切换器：列出这一章的各稿，已归档的收在「显示已归档」后面。 选中另一稿时在当前标签的位置换上那一稿；这一稿有未保存的修改时先问作者保存还是放弃，不会静默丢掉。
- `disabled`：批注修改还在等作者处理，或正在换稿：换稿会卸载正文，审阅里的修改会丢。
- `onSave`：保存这一稿的修改；失败时抛出，切换随之取消。
- 保存期间又有输入，或保存被会话守卫跳过：修改还没落盘，不切换。

### `src/components/stage/chapter/chapter-lifecycle.ts`

- `ChapterStage`：单章视图所处的一步，决定主按钮：待写写作此章，草稿 AI 审稿，已审稿按意见修稿，有待合并修稿完成合并，已修稿定稿。 与流程脊同一个 chapterPhase；另有已归档的旧稿，只读。
- `STAGE_STEP`：生命周期条上当前高亮的一步：0 写作、1 审稿、2 修稿、3 定稿、4 全部完成。

### `src/components/stage/chapter/use-chapter-blueprint.ts`

- `useChapterBlueprint`：这一章的蓝图：读到之前为 undefined，没有蓝图为 null；读取出错时 failed 为 true、蓝图仍是 undefined， 不当成没有蓝图（那会清掉写作请求、提示去规划）。蓝图资源刷新或 reload 时重读。

### `src/components/stage/characters/CharacterProfile.tsx`

- `CharacterProfile`：角色档案：基础设定、当前状态、关系图谱三个视图，保存与删除。数据与操作沿用 CharacterEditor 的 useCharacterProfile。
- 保存后名单重读时档案会重新挂载，展开状态放在这里才不会被收起。
- 说明条不显示时清掉所选章，否则保存会写到界面上看不到的章。

### `src/components/stage/characters/CharacterSuggestions.tsx`

- `failed`：原始报错是主进程包过一层的 IPC 异常，不给作者看。失败可能发生在一次已提交的接受之后，所以只说可以重读，不断言名单状态。
- 失败说明放在列表外：收起列表后作者仍要知道有一部分没读出来。

### `src/components/stage/characters/StageCharacters.tsx`

- `useRefreshSpineOnRosterChange`：名单保存、删除或采纳建议后修订号前进；流程脊上架构的完成数含「角色名单」一节，随之重读。
- `StageCharacters`：角色名单：架构阶段「角色名单」一节的完整页面。上方是待处理的角色建议，左侧名单，右侧档案与关系图谱。

### `src/components/stage/history/RevertDialog.tsx`

- `source`：要回退到的那一稿，例如「草稿 v1」。
- `current`：回退前的当前稿，例如「草稿 v2」。
- `RevertDialog`：回退不删除也不覆盖任何一稿，所以用普通对话框而不是危险确认，写明会新建哪一稿。

### `src/components/stage/history/use-version-history.ts`

- `VersionComparison`：一次对比的两边正文。current 为 null 表示读不到当前稿：这一章还没有稿，或最新一稿刚被删掉。
- `LoadedVersions`：某一章各稿的读取结果：读到的各稿，或读取失败（稿还在数据库里，只是这次没读出来）。session 为读取时的作品会话。
- `useVersionHistory`：版本历史的数据：章节列表、所选章的各稿，以及读取对比两边与回退。版本历史页用它。 回退不覆盖任何一稿，而是用旧稿的正文新建一稿，返回新稿的版本号。
- 各稿按章号与会话记下：再点当前章不必清空，换章或重新打开作品后还没读到的就是「正在读取」。
- `loadVersions`：读这一章的各稿；只有最后一次读取写进列表，连续点几章时先点那章的结果晚到也不会盖住后点的。
- `sessionLease`：同一部作品重新打开（新的会话）时重读：旧会话的读取作废，不重读的话这一章会一直停在「正在读取」。
- `readComparison`：读出这一稿与这一章最新一稿的正文；这一稿已不存在时返回 'missing'，会话已切换时返回 null，读取出错时抛出。空正文照常对比。
- `createRollbackDraft`：用这一稿的正文新建一稿（回滚草稿），原有各稿都保留；正文为空的旧稿照样回退成一份空稿。没有新建（会话已切换、旧稿不存在）时返回 null； 已新建时返回数据库分配的版本号，重读列表失败、读不到版本号时 version 为 null。
- `refreshed`：版本号在数据库事务里分配，估算值可能被同时写入的稿占掉，以刷新后的列表为准。

### `src/components/stage/knowledge/KnowledgeIndexSection.tsx`

- `KnowledgeIndexSection`：设置「检索模型」页里的索引检查与重建。知识库页不放这项实现细节（ia.md「实现细节不进入创作界面」）。

### `src/components/stage/knowledge/StageKnowledge.tsx`

- `StageKnowledge`：知识库：左列资料（导入的与定稿章节分开），中列所选资料的项目副本，右列在资料里查找。 存储与检索方式不在这里出现；检索模型与索引检查在设置的检索模型页。 所选资料与未保存的改动存在标签上：切走标签不丢，关标签与退出前走外壳统一的确认与保存。
- 与正文编辑器一样，注册在页面卸载后仍保留，关标签时由编辑器仓库移除。
- `documentsKnown`：最近一次读资料列表失败时，空列表与计数都不能当真。

### `src/components/stage/library/NewWorkDialog.tsx`

- `NewWorkDialog`：新建作品：起名、选保存位置。创建后打开作品，落在设定页。

### `src/components/stage/library/ShelfBook.tsx`

- `kicker`：封面左上角的小字，当前作品写类型。
- `figure`：封面底部的旧式数字，当前作品写「定稿 / 规划」。
- `ShelfBook`：书架上的一本书：点封面只预览，双击或菜单里打开；更多操作在封面下的菜单里。

### `src/components/stage/library/StageLibrary.tsx`

- `EmptyLibrary`：第一次打开：书架是空的，唯一的主操作是新建作品。
- `StageLibrary`：书房：开始、书架与右侧的作品概览。点封面只预览，不会打开作品。
- `listed`：最近项目读到之前不下「书架是空的」的结论，老用户启动时不会先闪一下空书房。
- `next`：流程脊数据按这次打开载入完之前，不猜下一步，只回到作品。

### `src/components/stage/library/shelf-format.ts`

- `shelfTime`：书架上的时间：今天写时刻，昨天、一周内写相对天数，更早写月日，跨年加年份。无效时间返回空串。
- `COVER_TONES`：封面色调：按书名稳定地取一种，同一本书每次都是同一种颜色。

### `src/components/stage/library/shelf-progress.ts`

- `StageBar`：概览卡上一个阶段的进度条：完成为完成色，进行中按比例填强调色，未开始为轨道色。
- `ratio`：进行中时的完成比例，0 到 1。
- `barsFromStages`：当前作品：与流程脊同源，阶段状态完全一致。
- `barsFromOverview`：只预览、未打开的书：设定按主进程返回的必填是否齐全（与流程脊同一口径，只说齐没齐）， 架构按四节，蓝图有 1 章即完成，正文写定稿章数与规划章数，定稿达到规划章数即完成（同流程脊）。
- `nextStep`：「继续写作」去哪：第一个未完成的阶段；到了正文就是该写的那一章。

### `src/components/stage/library/use-shelf-overview.ts`

- `useShelfOverview`：书架与作品概览。当前作品读 `project:overview-current`（带摘录），其他书只用 `project:peek-overview` 预览，不正式打开。 书房用这份数据。
- 当前作品与预览各占一格：预览别的书不会冲掉当前作品已读到的概览，回到当前作品时直接显示。
- `activeSelection`：预览的书被移出最近项目后，选择随之作废，概览回到当前作品。
- `selectedId`：正在预览的书；为空时概览显示当前作品。

### `src/components/stage/palette-filter.ts`

- `meta`：右侧的说明，例如章节状态或阶段进度。
- `chapter`：章节号，用旧式数字显示，也用于按章号查找。
- `paletteItem`：调用处不必为分组字面量写 as const。
- `chapterQuery`：「3」「第3章」「第 3 章」「chapter 3」都指第 3 章。
- `filterPalette`：按输入过滤并排序。结果按分组顺序排列，与面板的分组显示一致，上下键才按看到的顺序移动； 组内章号完全相同的章排最前，其次是标签以输入开头的项。

### `src/components/stage/plot/PlotThreads.tsx`

- `PlotThreads`：伏笔线索：左列线索计划与各自的埋设、推进、解决路线；右列把定稿里的变化记进线索，以及按蓝图请 AI 建议伏笔。 新建与编辑线索在对话框里完成；删除线索在每行的「更多」里，走危险确认。

### `src/components/stage/plot/PlotTimeline.tsx`

- `PlotTimeline`：剧情树：轨道为行、章为列的只读时间轴，一页 6 章。快照来自蓝图、定稿与线索计划的整理， 页面顶部写明它不参与写作；清除剧情树在「更多」里，走危险确认。

### `src/components/stage/plot/StagePlot.tsx`

- `GenerationRecords`：整理记录：剧情树与 AI 候选的每次生成都留有记录，可以恢复、继续、取消或保存原结果。
- `StagePlot`：剧情与伏笔：剧情树与伏笔线索合为一页，用分段切换。清除剧情树与删除线索都先危险确认。
- `pinnedRecords`：生成进行中（可以取消）或剧情树生成完却没保存上（来源变化、被取消）时记录自动展开，此时不能收起；其余时候从「更多」打开。

### `src/components/stage/plot/plot-shape.ts`

- `chapterWindow`：一页显示的章：请求的起点优先，否则让当前章落在这一页中间；不超出末页。
- `threadRoute`：线索路线的三站：埋设、推进、解决。已确认的定稿事件让对应一站变成已发生，章号取事件所在章； 没有推进事件时推进站不显示；计划已逾期时，下一个未到的站标为逾期。

### `src/components/stage/run/RunDiagnostics.tsx`

- `RunDiagnostics`：诊断分页（宽版侧页）：日志与 AI 调用记录，只用于排查问题。

### `src/components/stage/settings/AppearanceSection.tsx`

- `Row`：一行设置：左边标题与说明，右边控件与标题对齐；children（示例句、错误）占整行，放在下面。
- `ThemeChoice`：浅色与深色两张卡片的单选组：整组一个 Tab 停靠点，方向键换选并移动焦点（与 SegmentedControl 一致，带修饰键时不接管）。

### `src/components/stage/settings/ModelsSection.tsx`

- `ModelsSection`：一类模型的列表与编辑：生成用的「AI 模型」或知识库用的「检索模型」。删除要先确认。

### `src/components/stage/settings/ProxySection.tsx`

- `ProxySection`：网络代理：开关、类型、主机与端口，保存后所有 AI 请求都走代理。

### `src/components/stage/settings/StageSettings.tsx`

- `useRequiredState`：必需页的标签状态，非必需页为 null。配置载入前不下结论，只标「必需」。
- `SettingsLink`：导航按钮的名字只是页名（读屏和按名定位都靠它），必需与否放进描述里读出。
- `isTyping`：打字的地方的 Esc 属于输入（撤销联想、清空搜索），不关闭设置页；下拉框、开关、复选框、按钮上的 Esc 照常关闭。
- `StageSettings`：设置页：左侧按常用、高级、其他分组，右侧是当前一页。占满内容面板，书房与作品里都能打开； 「返回」或 Esc 回到打开前的页面，有没保存的输入时先确认。当前分区记在 layout-store，书房与作品之间切换重挂后仍停在原处。

### `src/components/stage/settings/settings-pages.ts`

- `required`：不配置就有功能用不了的页：导航与页头标「必需」；missing 为真时标「未配置」。
- `SETTINGS_GROUPS`：ia.md 的三组：常用、高级、其他。

### `src/components/stage/setup/setup-fields.ts`

- `REQUIRED_NAMES`：必填项的名字，与流程脊「还差 N 项」同一组。
- `ONE_MISSING_HINT`：只缺一项时，提示直接说怎么补齐。
- `SheetField`：aiField：可单独让 AI 生成的字段。
- `SHEET_FIELDS`：顺序与 AI 来源标记的字段表一致。

### `src/components/stage/shortcut-keys.ts`

- `isLetter`：拉丁布局按 key 判断（Dvorak 等布局字母位置不同），非拉丁布局（俄文、希腊文等）按物理键位 code 判断。
- `isCommand`：平台的命令键加一个字母：macOS 只认 ⌘，其余平台只认 Ctrl，带 Alt 或 Shift 的组合不算。 macOS 上 Ctrl K、Ctrl P 是编辑器的行内命令（删到行尾、上一行），不能被外壳抢走。
- `isComposing`：输入法正在组字时，回车、方向键与 Esc 属于输入法（例如拼音选词），快捷键与列表都不接管。
- `isModalOpen`：界面上有模态层：旧的全局对话框（开关记在 layout-store）或页面上任何对话框、确认框、提示框。 设置是页面而不是弹窗，不算模态层。 模态层开着时外壳快捷键不在它下面再开层，否则新开的层被盖住，Radix 又抢走焦点，界面像冻住了一样。

### `src/components/stage/stage-text.ts`

- `CHAPTER_PHASE_TEXT`：章节状态在流程脊与 Ctrl K 里的说明：写出下一步，定稿章写「定稿」。
- `PAGE_TAB_NAMES`：阶段、资料页与角色名单的标签用固定的名字（阶段与资料页取流程脊上的名字），同一个页面只有一个名字。
- `stageTabName`：标签显示的名字。正文、审稿报告与恢复草稿等标签沿用各自的名字。

### `src/components/stage/tab-close.ts`

- `focusContent`：被关掉的标签带走了焦点（标签条可能随之收起），下一帧把焦点交给内容区，键盘不会落到页面之外。 这一帧里焦点已经落到页面里别处（例如又打开了标签菜单）就不抢。
- `requestCloseTab`：关闭标签：没有未保存修改就直接关；有修改时先请作者确认放弃。标签条与 ⌘W / Ctrl W 都走这里。
- `closeCleanTabs`：一次关几个标签（标签菜单的关闭其他、右侧、全部）：没有未保存修改的直接关， 返回有未保存修改、要作者确认后才能放弃的那些。
- `discardAndCloseTabs`：作者确认放弃后，丢掉这些标签的未保存修改并关掉；作品已换就什么也不做。

### `src/components/stage/use-stage-shortcuts.ts`

- `useStageShortcuts`：外壳的全局快捷键（macOS 用 ⌘，其余平台用 Ctrl）：K 搜索与跳转，P 查找章节，W 关闭当前标签（设置页开着时关设置页），S 保存当前页；Esc 退出沉浸写作（设置页开着时先关设置页）。 W 一律拦下（包括输入法组字时）：应用菜单的「关闭」绑了 CommandOrControl+W，页面不拦就会关窗。 Esc 与 S 在冒泡阶段处理并尊重 defaultPrevented：编辑器的搜索框、补全与 Radix 对话框先用掉 Esc，CodeMirror 自己保存时 S 已被拦下。
- 设置页盖在沉浸写作上面时 Esc 归设置页（它的监听注册在后，跳过已处理的事件），这里不拦。
- 设置页盖在标签上面，作者看不到当前标签，Ctrl S 不替它保存。

### `src/components/stage/write/SplitAction.tsx`

- `SplitAction`：拆分主按钮：主按钮直接执行，箭头打开一个小弹层改本次选项（写作此章的模型与指导、审稿的检查维度、修稿的模型）。 弹层的开关由调用方的 useAnchoredLayer 持有，调用方可以自己打开（写作请求）或在开始后关掉它。
- `busy`：主操作进行中：主体保持上墨并画加载墨线（aria-busy），箭头半边不带，刻痕占着它的 ::before。

### `src/components/stage/write/use-chapter-thread-tasks.ts`

- `useChapterThreadTasks`：写前弹层的线索：挂载时就读，主按钮旁的小字才有数。读不出来只是不显示，不挡开写。
- `threadReads`：只认最后一次发出的请求：刚点完延后，先发的列表请求晚到也不能盖掉新结果。
