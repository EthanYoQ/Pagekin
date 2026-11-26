# 生成运行的状态与校验范围

2026-11-17，#702。本 ADR 先写审修循环校验范围（修复方案 S1）。运行索引（S2）和打开作品去掉重复劳动（S3）标为「后续」，由对应的 PR 补写。

## 背景

作品写到七八十章以后，各项操作开始假死。原因之一是审修循环的全书校验 `verifyM03ReviewCycle`：

- 仓库读写任何一条审修循环之前或之后，都要把全书每一条循环重新证明一遍，共 12 处。读一条循环的语句数随章数线性增长。112 章的手动夹具里，读一次审修循环（`db:review-cycle-get`）要 1.4 到 1.5 s（6 次中位数）。
- 打开作品时也跑一遍全书校验。同一夹具上打开作品要 2.6 s，其中约 1.4 s 是这次校验。
- 只要有一条循环不一致，整本书的所有循环都读写不了，整本书也打不开。

## 决定

1. **校验在写入、迁移、导入时做，不在无关的读取和打开时做。**
   - 仓库读写一条循环时，只校验被读写的那一条（`verifyM03ReviewCycleById`）。绑定修稿或调和丢弃修稿时，顺手摘下的同稿循环也算被写，一并校验。
   - 打开作品时做版本、`integrity_check`、外键检查、结构指纹，以及 M02、M07 的校验，不再跑全书 M03。
   - 书库里当前作品的概览（`ProjectPeekService.readCurrent`）只做打开作品时的这一套校验。
   - 书架上其他书的预览（`readPeekSnapshot`）只查版本、`integrity_check`、外键和结构指纹，不跑任何一步迁移的业务校验。结构指纹由主进程从迁移注册表取出、随任务传给预览 worker，worker 不再每次自己建一遍注册表。复制快照前后只比对文件大小、修改时间和 inode，不再对整个库文件算三遍哈希（#702）。
   - 迁移通道（升级旧版本作品、`verifyProjectSqlite`、`backupProjectSqlite`）、存档导出和存档导入仍跑全书校验，全书校验列出验不过的循环（`inspectM03ReviewCycles`）。外键、表结构和无主快照有问题时，三处都整本拒绝。各处对验不过的循环要求不同（#702）：
     - 升级用 no-new-failures：迁移前已经验不过的循环放行，迁移新弄坏一条就拒绝。打开作品时的升级和书库卡片的快照升级都用它。
     - 导出和云备份同样用 no-new-failures 取源库快照，然后在投影前从副本里删掉验不过的循环，连带它的意见和合并快照。存档最后仍按从严校验，证明存档里没有坏循环。结果里列出这些循环所在的章（章号、章名、是否在回收站），界面在成功提示后面接一句。去掉之后仍过不了投影的书照旧失败，提示指明章节。源库不改。
     - 导入、恢复和旧作品复制导入从严：存档或旧库里有一条验不过就拒绝。旧作品复制导入只收 v0 的库，那时还没有审修循环。
     - 章节只在循环自己的审稿证据指向这次审稿、冻结的来源与审稿行和草稿行一致时才报。对不上或读不出，就只说有记录没放进存档，不报章节。主键为 NULL 的循环无法按主键放行或删掉，三处都整本拒绝。
2. **全书校验等于外键与表结构检查，加上对每一条循环调用单条校验。** 单条校验和全书校验里的循环体是同一段代码。
3. **合并快照行数这条跨循环检查改写成单条的等价形式：已合并，当且仅当有一行合并快照。** 原来比的是快照行数等于已合并循环数。不属于任何循环的快照由 `review_cycle_merges.cycle_id` 的外键挡住：开着外键约束时写不进去，绕过约束写进去的，打开作品和全书校验里的外键检查会报出来。例外是 `cycle_id` 为 NULL 的快照：TEXT 主键允许 NULL，外键也不检查 NULL，所以全书校验单独拒绝这种行。打开作品不拦它，它不影响任何一条循环的读写。
4. **单条校验里不跑全库外键检查和表结构比对。** 单条校验只检查连接开着外键约束（`PRAGMA foreign_keys`）。全库外键检查、`integrity_check` 和结构指纹在打开作品时已经做过，每次读写一条循环再做一遍，成本随库大小增长。

## 对契约 C07「开库验证」的解释

C07 要求开库顺序由单一 schema lane 掌握：未知的较高版本只读拒写，旧的无版本库只能经有证据的结构指纹识别。本 ADR 把「开库验证」解释为验证库的版本和结构，不包括逐行重证每一条业务记录的证据链：

- 版本、结构指纹、`integrity_check`、外键检查照旧在打开时做。版本过高、结构不认识、损坏的库照旧拒绝打开。
- 审修循环的逐条证据在写入这条循环时证明，迁移和导入时再全书证明一遍。打开时不再重证。
- 打开作品时的校验写在 `verifyOpenedSchema`，对应 v10 迁移校验去掉全书 M03 的部分。库版本升级时要按新版本的迁移校验重新核对这里，有一条测试在版本号变化时提醒。

## 后果

- 某条循环记录不一致时，只有读写这一条会报错，错误码不变。其他章节照常审稿和修稿，整本书也照常打开。这放行了原来会拦住的操作，修复方案第 7 节第 1 条请维护者确认。
- 生成记录（账本四张表的六个 JSON 列）有一格读不出时，打开作品会把这一格换成中性值，并封存它所属的根（ADR-0030）。之后跨记录的查询和恢复不会再碰到读不出的格子。只有读写这一次生成的操作报错：它不能继续，根上的阻断码改成 `GENERATION_LEDGER_UNREADABLE`，原来的阻断码记进封存记录。这条根被审修循环引用时，那条循环验不过（根已封存即不可证，ADR-0030），按决定 1 放行升级，导出时留在存档外。
- 导出和云备份放过坏循环以后，存档里少的是这条循环的证据行，以及挂在它下面的审稿意见和合并快照（`review_findings`、`review_cycle_merges`）。审稿报告、作者确认、修稿正文和定稿都在。从这份存档恢复出的书没有坏循环，那一章要继续审修就重新审稿。源库里的坏循环还在，每次导出都会再提示一次。
- 导出按根省略，与 M03 同一单位：一条循环验不过，它所在的根上的循环一并留在存档外，根下的运行、尝试、产物都按普通记录投影。验不过的循环自己的链接不可信，导出只取它的根。应用每次首审都建新根，写不出同根多循环；手工并过根的书，同根的好循环会一起省略，这时指不准是哪一章，提示不报章节。
- 以后校验器若有误判，会把完好的循环留在存档外。提示会列出章节，源库不受影响。之前同样的误判会让整本书导不出、备份不了。
- 112 章手动夹具上修前修后交替各跑 6 次，取中位数：打开作品从 2.6 s 降到 1.2 s；读一次审修循环从约 1.4 s 降到约 26 ms；AI 审稿一章的主进程最长阻塞从 3.0 s 降到 0.6 s。
- 读写一条循环执行的语句数不再随章数变化。其中按 `root_action_id` 取生成尝试的那条语句在 `generation_attempts` 上没有索引，会扫全表，扫描行数仍随运行数增长。本 ADR 不加索引，加索引要迁移。
- 只调和两条已丢弃修稿中的一条，以前因为另一条不一致而被拒绝，现在会成功，另一条留到它自己被调和时再校验。

## 后续

- **S2 运行索引：** 运行索引是可以从账本重建的索引，不是第二个事实源（ADR-0018）。恢复列表跳过收据里记着正式效果的审稿、修稿、写稿运行，不再重证它们，证据对不上时也不标「部分读不出」（维护者 2026-11-19 同意）。启动与关闭只恢复还在 active、或有已预留、已派发尝试的根。跨记录按什么认运行，见 ADR-0030「跨记录认运行」。
  - 第三个 PR 把 `binding_json` 移出进门清单（ADR-0030 决定 1、4、7）。打开作品只查没静止的树的绑定，选树的条件和启动恢复共用一条查询。静止树里一条绑定坏了，打开时不封存、不提示，只有读写那一次生成的操作报「记录已损坏」。导出与备份前对全部记录再查一次，坏的照常封存，书仍能导出。
- **S3 打开作品去掉重复劳动：** 打开时的快照与哈希只保留必要的几遍（ADR-0001 的打开前探测）。由 S3 的 PR 补写。

## 渲染端其余口径（注释清理 #852 第 4 个 PR，src 其余）

### `src/stores/workflow-store.ts`

- 作者主动取消后安全退出；与失败分开，界面不当作出错。
- `WorkflowFailureCode`：现行规则：有界模型完成给出的稳定的非成功终态（原文：Stable non-success terminal state supplied by a bounded model completion.）
- `errorCode`：字段语义：抛出的错误带的非空机器可读码（原文：Non-empty machine-readable code supplied by the thrown error.）
- `failureCode`：字段语义：有界模型完成提前停止时的结构化失败原因（原文：Structured failure cause when a bounded model completion stopped early.）
- `promptBudgetReport`：字段语义：提示词预算预检失败时安全的结构化字节归因（原文：Safe structured byte attribution for a prompt-budget preflight failure.）
- `projectSession`：启动时从当前项目冻结；缺失时该 run 只能失败，不能执行项目级副作用。
- `chapterWordsTarget`：本次写作冻结的每章目标可见单位；不得在执行中重新读取全局配置。
- `resourceKeys`：该运行将生成或改写的逻辑资源；同项目内写入与任何其他声明互斥。
- `readResourceKeys`：该运行只读取的逻辑资源；多个读取者可以并发。
- `errorCode`：字段语义：从失败的当前步骤镜像来的机器可读错误码（原文：Machine-readable error code mirrored from the failed current step.）
- `failureCode`：字段语义：从失败的当前步骤镜像来的结构化终态原因（原文：Structured terminal cause mirrored from the failed current step.）
- `promptBudgetReport`：字段语义：从失败的当前步骤镜像来的安全结构化字节归因（原文：Safe structured byte attribution mirrored from the failed current step.）
- `mainGenerationRootHandle`：现行规则：主进程签发的身份，阶段变化保留根预算，恢复保留精确的运行（原文：Main-issued identities; stage changes keep the root budget, recovery keeps the exact run.）
- `requestMainGenerationCancellation`：现行规则：主进程适配器提供一个幂等的取消意图，包括阶段之间（原文：Main adapter supplies one idempotent cancellation intent, including between stages.）
- `runId`：本次运行的稳定身份，供事件消费者排除其他并发任务。
- `cancelRequested`：字段语义：仅导入使用的意图，当前有界效果在编排器应用取消之前就退出（原文：Import-only intent; the current bounded effect exits before the orchestrator applies cancellation.）
- `cancellationRequest`：现行规则：导入的取消意图必须在编排器写终态边界之前持久化（原文：Import cancellation intent must be durable before its orchestrator writes the terminal boundary.）
- `runId`：可由需要同步订阅事件的调用方预先分配。
- `onCancelRequested`：现行规则：先持久化取消，再等待当前操作让出（原文：Persist cancellation before waiting for the current operation to yield.）
- `onCancelledAtBoundary`：现行规则：到达步骤或暂停边界之后才提交终态取消（原文：Commit terminal cancellation after a step/pause boundary is reached.）
- `backgroundNotice`：完成或失败时，窗口不在前台则弹系统通知。
- `withoutWritingSkills`：不调用写作 Skill 的工作流不冻快照：冻一次要读两次盘，Windows 上每次 1.5 到 2.5 秒。
- `getResourceConflict`：返回占用同项目同一逻辑资源的活跃运行；不同资源仍可并发。
- `cancelProjectWorkflowsAndWait`：取消指定项目的全部工作流，并等待执行器真正退出 activeRuns。
- `stoppedByCancellation`：作者点了取消，而且这次中止就是取消造成的；取消窗口里的真实错误不算，照常记失败。
- 现行规则：调用方给定的持久运行 ID 同时是渲染端的单飞键，在读可变项目状态或建第二个上下文之前拒绝重复，原执行器与冻结上下文仍归第一次调用（原文：A caller-supplied durable run ID is also the renderer's single-flight key. Reject the duplicate before reading mutable project state or constructing a second context; the original executor and its frozen context remain owned by the first call.）
- `context`：运行一出现在界面上就有暂停、取消按钮，执行上下文要同时就位，否则写作 Skill 快照读取期间的点击会落空。
- `cancellationRequestSettled`：切换作品等的是活动列表清空，取消请求落盘之前运行不能离开；保存失败由 cancelWorkflow 记日志。
- 切换作品会先取消本作品的运行；作者已取消时，项目变了正是取消的结果，不是出错。
- 批量任务只在步骤之间暂停，避免中断一次正在进行的模型请求或后处理； 第一步之前点的暂停同样等这一章写完，与按钮说明「写完当前这一章后暂停」一致。
- `confirmed`：现行规则：先登记再发布等待状态，这样立即的界面确认不会丢（原文：Register before publishing waiting state so an immediate UI confirmation cannot be lost.）
- 作者取消引发的中止：这一步停在取消处，运行保持「正在取消」，由循环后的取消收尾记为已取消。
- 取消窗口里真实出错的运行已记失败，不能再改成已取消。
- 同步广播，并且必须发生在 activeRuns 清理之前。 消费者可用 runId/projectPath 精确识别本次完成，且不会因动态 import 延迟丢失事件。
- 保留在活跃列表中，直到当前执行器真正退出。项目切换/清空门禁据此继续生效。
- `recordRunGenerationModel`：记当前在用的模型：作者原稿导入先用定稿模型做后处理，再用规划模型反推。
- `advancesStep`：主进程每次快照都会重发相同的文本与进度，心跳只改耗时，所以这里比较取值，不看字段是否出现。
- `before`：只有一次请求开始时才不带诊断。
