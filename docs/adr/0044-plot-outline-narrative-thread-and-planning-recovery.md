# 情节大纲分批、叙事线索排期与规划恢复稿的共享规则

2026-11-26，注释清理（#852）第 3 个 PR（src/shared）。

## 背景

`plot-outline-contract.ts`、`plot-outline-checkpoint.ts`、`planning-recovery.ts`、`narrative-thread.ts` 等纯函数同时被主进程与渲染端使用，注释里写着分批续写、覆盖说明、恢复稿去留与线索排期的判定规则。

## 决定

情节大纲按章标题分批生成，正式大纲决定下一批从哪里续、会替换哪几章；检查点只用来认出被打断或正在生成的一批，不用它的覆盖章号判断进度。大纲被手动编辑后续批必须 fail-closed 并引导重新生成。规划恢复稿是否还要给作者，由一条共用判定回答。叙事线索的任务在开写时冻结，恢复与审稿读冻结值。下面按文件列出各条口径。

## 共享层口径（注释清理 #852 第 3 个 PR，src/shared）

### `src/shared/architecture-recovery-navigation.ts`

- `architectureRecoveryHandle`：架构恢复检查点只存导航，实际运行与来源由主进程校验（原文：This checkpoint stores navigation only; main validates the actual run and sources.）

### `src/shared/generation-owner-contract.ts`

- `PlanningDraftStanding`：一份情节大纲或章节蓝图恢复稿还算不算可恢复：superseded 是它还缺的章后来都有了正式内容（开跑之后写的）， dismissed 是作者放弃了它。生成还在进行的那份总是 open。

### `src/shared/ipc-channels.ts`

- `narrativeThreadDormantChapterThreshold`：项目级章数阈值：活跃叙事线索多少章后标为休眠（原文：Project-scoped chapter count before an active narrative thread is marked dormant.）

### `src/shared/narrative-thread-generation-pure.ts`

- 只用于证明已存的图谱效果与其原始过滤下标（原文：Only for proving already stored graph effects with their original filtered indices.）
- 只用于证明已存的图谱效果与其原始过滤下标（原文：Only for proving already stored graph effects with their original filtered indices.）

### `src/shared/narrative-thread.ts`

- `NarrativeThreadAssignment`：resolve：写前延后到第 N 章的历史，延后时回收章已直接改成 N，排期不读它。advance：作者指定第 N 章推进，不动回收章。
- `NarrativeThreadSchedule`：线索相对某一章的排期。注入正文时按正在写的章算，线索页按最大定稿章算。 区间数据不可用（导入或手改写坏）时返回 null，调用方只跳过这一条。
- `ChapterThreadTask`：写第 N 章时到期、逾期或作者指定的线索，开写时冻结进章节信息，作为本章硬任务。 恢复和审稿都读冻结值，开写后作者改计划不影响本轮。
- `chapterThreadPanel`：movedHere 是写这一章时本次会话里延后过的线索（线索 id → 延到哪章）。延后前的回收章只有会话知道， 所以只有它们能撤销；作者在别处改过回收章的不再算。
- `parseChapterThreadTasks`：读回冻结的任务，键序与开写时一致，恢复时逐字比对才能对上。格式不对返回 null。
- `writtenChapterThreadTasks`：写稿运行绑定（RunBinding 的 JSON）在作者输入「draft:chapter-info」里冻结的线索任务。没有记录是空列表，记录写坏返回 null。

### `src/shared/planning-recovery.ts`

- `planningRecoverable`：运行侧页、蓝图页横幅与架构页的大纲提示共用的一条判定：这份规划恢复稿还要不要给作者。 续写已完成、本批已原样在正式大纲里、还缺的章后来都有了正式内容、作者放弃了，都不再给。

### `src/shared/plot-outline-checkpoint.ts`

- `SynopsisCheckpoint`：partial_arch.json 里情节大纲的分批检查点字段。
- `synopsis_result`：情节大纲：已确认覆盖至 synopsis_covered_to 的纯正文（不含批次进度行）。
- `synopsis_incomplete`：上一次生成在本批范围内被中断；synopsis_result 为已完成部分。
- `synopsis_covered_to`：最近一次成功批次的结束章（== totalChapters 时全书大纲完成）。
- `synopsis_range`：当前/上次生成批次的范围；断点续写恢复时沿用。
- `synopsis_db_hash`：上次写入 DB 的大纲全文指纹；用于检测大纲是否被手动编辑（防续批覆盖用户修改）。
- `synopsis_body_hash`：与 synopsis_result 精确绑定；旧检查点缺失时由 DB 逐字等价校验兼容。
- `MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS`：少于该字符数视为无保存价值的零碎输出，不落盘、不提供续写。
- `SYNOPSIS_INCOMPLETE_MARKER_ZH`：落库时追加在未完成大纲末尾的可见标记（帮助用户识别与编辑器提示）。
- `synopsisFactsFingerprint`：轻量确定性指纹：绑定大纲赖以生成的源事实，防止旧检查点被续到新上下文。
- `assertCheckpointDbMirrorCurrent`：续批/恢复前校验 DB 中的大纲是否仍是上次生成写入的内容。用户可能直接在 编辑器手动修改大纲（保存只更新 DB）：此时若按检查点前缀拼接会覆盖用户的 修改，必须 fail-closed 并引导显式重新生成。
- `OutlineProgress`：情节大纲写到了哪里：流程脊、架构页的徽标、页头计数与主按钮、生成对话框的默认勾选共用这一个判定。 写到第几章按主进程开跑时的同一判定（plotOutlineNextChapter 内部即 plotOutlineConfirmedPrefix）：正式大纲能紧接第 k 章续写才算只写到第 k 章。 不用检查点的 synopsis_covered_to：重写中间几章后它记的是本批终章，与正式大纲对不上。检查点只用来认出被打断或正在生成的一批。
- `kind: 'interrupted'`：有一批被打断或正在生成；正式大纲还是开跑前的样子。
- `kind: 'partial'`：正式大纲写到第 coveredTo 章，全书 total 章。
- `kind: 'unresumable'`：正文末尾还带着分批说明，却不能从它接着写：检查点没了，或说明与正文对不上（比如末尾多了换行、手动改过）。
- 只有第 0 章序章：正文再长也还没开始生成。

### `src/shared/plot-outline-contract.ts`

- `rejectedReply`：停下那一章最后一次的回复（自动生成没写成的那份），不在正文里，只在「原始候选」里给作者看和复制；没有回复时为 null。
- `inFormalOutline`：本批生成完的整段内容现在原样在正式大纲里。来源变了以后，正常保存过的一批与正式保存被拒的一批在游标和写回状态上一模一样， 只有看正式大纲才知道作者要不要从本批起始章重新生成；只比章号不够，重写已有的章时旧大纲早就写到了那里。
- `kind: 'stopped'`：source-invalid：开跑时冻结的大纲按现行规则无效（升级前开跑、章节乱序或重复），只能读出与复制，不能续写或写回。
- `confirmedPrefix`：冻结大纲按现行规则无效（cursor 为 stopped/source-invalid）时为 null：没有可续写的前缀。
- `plotOutlineCoverageNote`：分批生成没写满全书时，应用写在大纲末尾的覆盖说明。写入、续批校验与清理旧说明都从这一句出发。
- `COVERAGE_NOTE_LINE`：任意章数的一行覆盖说明，由 COVERAGE_NOTE 生成：改措辞时清理与识别随之更新。
- `PlotOutlineRangeSource`：正式大纲里决定一批范围能否开跑、会替换哪几章的三项事实；主进程 begin 时取自 project_core。
- `PlotOutlineOrderIssue`：章节条目要按章号严格递增：同一章出现两次，或作者调乱了顺序，按位置截取的前缀与尾部会丢章或重复。
- `entry`：第 0 章（序章）也是合法章号
- `plotOutlineSourceInvalidText`：开跑时冻结的大纲来源无效、任务不能续写时给作者的说明；恢复稿入口与「断点续写」共用同一份措辞。
- `next`：开头的第 0 章（序章）是合法前缀；chapterOrderIssue 已保证它只出现一次且在最前。
- `PlotOutlineRangeEffect`：这一批交给主进程会怎样：invalid 为 begin 时 plotOutlineConfirmedPrefix 会拒绝；overwrite 为替换已有的第 from–to 章 （没有按章标题时 whole 为整份替换），其余章节由 renderPlotOutlineRange 原样保留，prologue 为开头有第 0 章序章（同样保留）； continue 为紧接已有章节往后写，after 为 0 即接在序章之后。
- `plotOutlineLastChapter`：已有大纲按章标题写到的最后一章；没有按章标题时为 null。只有第 0 章序章时为 0。
- `plotOutlineNextChapter`：下一批的默认起始章：已有大纲能紧接着往后写时取最后一章的下一章，否则从第 1 章起。
- `stripStaleCoverageNotes`：去掉末尾应用写的覆盖说明（章数不限：大纲改过章数或删过章节后留下的旧说明），可连续多条，说明不会是第一行。 逐行从末尾往前看，不用跨行正则：大量空行时正则回溯按平方增长。
- `withPlotOutlineCoverageNote`：去掉末尾所有应用写的覆盖说明，换成写到第 to 章的那一条；全书已写完时不写。
- `stripStandardTitle`：去掉第一个章节标题之前的那一行标准标题（可能写在作者前言之后、可能是 CRLF 换行）；其余前置文字原样保留。
- `renderPlotOutlineRange`：只替换显式提交的章节范围，保留周围来源文本（原文：Replace only the explicitly committed chapter range; keep the surrounding source text.）
- 已有章节都在第 1 章之前，只能是第 0 章序章：作者原文逐字留在前面、新章接在后面，按续批要求的形式重建标准标题与覆盖说明。 自定义顶层标题与其他前置文字一样算作者原文保留；原有的标准标题行和应用写的旧覆盖说明不再带入。
- `mergedEntryCutAt`：旧大纲里被第 chapter 章从中间切开的合并条目（如「第4–5章」）。
- `plotOutlineRecoveryDraft`：恢复稿正文只放连续写好的章节；停下那章的回复不进正文，见 rejectedReply。
- 来源无效时拼不回正式大纲，只留已生成的章节供复制。
- `plotOutlinePrologue`：开头的第 0 章序章条目（到下一章标题或末尾的覆盖说明为止）；没有序章时为空串。
- `accepted`：从第 1 章起的一批没有已确认前缀，但序章原样保留在最前（renderPlotOutlineRange），模型写第 1 章时要看到它。

### `src/shared/recovery-actions.ts`

- `editorCanContinue`：主进程决定列不列、运行侧页决定按钮能不能点，都按这里判断，两边不会对不上。

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/services/__tests__/architecture-service-status.test.ts`

- executeChapterOutline 提交后 saveNavigation(outline, true) 写下的检查点。

### `src/services/architecture-service.ts`

- `readArchCheckpointWithOutline`：读架构生成的分批检查点 partial_arch.json；没有、读不到或读失败都按没有检查点（undefined）。 大纲恢复稿已不再给作者时，去掉检查点里 synopsis_ 开头的部分，免得各处仍把它当成被打断的一批。 把判定用的那次读取一并交回（未读或读失败为 null），调用方不要再读一次，否则两次读到的判定可能不同。
- `archOutlineSource`：作品核心里情节大纲的范围来源：章数与写作语言以作品核心为准，作品核心读不到时用作品设置。
- 长度 > 50 才算真正已生成，前端可以直接用长度判断
- `checkArchConfirmed`：流程脊的架构四节是否已确认：与架构页徽标同一判定（judgeArchCore），角色名单要结构化名单就绪。

### `src/services/architecture-step-selection.ts`

- `archSectionHasContent`：一节有没有内容：去掉空白后不为空，作者写的短内容也算（要显示出来，生成时会被覆盖）。
- `judgeArchCore`：前提、世界观、情节大纲三节「有内容」与「已确认」的唯一判定，架构页、架构文档页的生成对话框与流程脊共用；角色名单由调用方按名单是否就绪补上。 有内容见 archSectionHasContent。 已确认：有内容，且前提、世界观超过 50 字，情节大纲按分批进度写满全书。
- `ARCH_STEP_NAMES`：架构四节的名字（中、英）。架构页、生成对话框、提交提示与单节文档标签共用这一张；名单页的图形视图叫「关系图谱」，不与名单混名。
