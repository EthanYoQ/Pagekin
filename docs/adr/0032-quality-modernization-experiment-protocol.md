# 质量改造实验协议：协议是唯一权威，账本只增不改

2026-11-26，注释清理（#852）第 1 个 PR（scripts）。

## 背景

`scripts/quality-modernization-driver.mjs`、`quality-modernization-run.mjs`、`quality-modernization-receipt.mjs`、`scripts/fixtures/quality-modernization-production.fixture.mjs` 以及 `scripts/__tests__/quality-modernization-*.test.mjs` 实现一套预注册的质量对比实验：两臂（baseline 与 candidate）经生产代码跑同一批场景，物理请求记进一份追加式账本，收据再交独立评审裁定。这些文件里有约 280 处解释「为什么这样断言、这样登记」的注释。本 ADR 把其中的决定迁到一处，源码注释随之删除。

## 决定

### 一、协议决定一切，桥只执行

1. 生产桥只是协议的执行者。场景登记的 `phase`、`caseId`、`operation id` 必须逐字等于该阶段的预注册内容；不一致就在建任何目录前阻断，而不是跑一个没预注册的实验。未登记 operations 的阶段 fail closed。
2. 阶段场景是协议阶段在桥一侧的对应物，只说明哪些生产命令实现哪些 operation。runner 在开门前逐字段重核，所以桥里的漂移会 fail closed，而不是悄悄跑另一个实验。
3. 每个 operation 的 `kind`、`restore`、`caseIds` 从 v4 起也逐字对齐：哪一案执行哪些后处理与续写只由协议决定，登记的 operation 序由 driver 的选择函数与结果侧校验共用，不按下标切片。
4. baseline 臂跑冻结在历史提交的驱动、走 generation runtime；candidate 臂跑当前驱动、走 generation harness。
5. 门禁与运行后检查用与 `ReviewChapterCommand` 相同的生产解析器；固定历史输入只按字节读取，只有拷出来的 donor 才允许被 SQLite 打开。

### 二、账本：只增不改，终态必须落账

1. 一份追加式 campaign 文件，靠 `wx` 锁防并发预留；撕裂的末记录 fail closed。已 dispatch 或 unknown 的发送永不释放额度，登记按「固定登记」而不是按 invocation 或 SHA 计，所以重启不能退还槽位。
2. `dispatch` 之后必须落 `settle` 或 `unknown`，未知不退款。第二次 UNKNOWN 既不退还登记也不许继续。
3. 终态写入幂等：同一 `attemptId` 只写一条；先写账本再记终态，写失败（如 `LEDGER_BUSY`）不吞终态，调用方可重试；`dispatch` 之前的取消只走 `cancel`。
4. **结算守护。** 桥测试的 120 秒超时是进程内计时器，不投信号、不先跑 `finally`；供应商卡住时「等流结束再写终态」永远等不到，账本只剩 `reserve` 与 `dispatch`，花费不可审计。所以每个 dispatch 的发送各自持有一个短于桥测试超时的截止时间：到点先写 `unknown`（占用、不退款），再 `abort` 其 fetch，先落账、后失败；之后的 attempt 从各自 dispatch 起获得完整预算。
   - **被拒绝的备选：** 改用 process 信号或 `exit` 钩子收尾。超时是进程内计时器，不发信号，SIGTERM 处理器不会触发；`exit` 处理器必须同步、等不了未决的流；worker 被强杀时两者都不运行。守护计时器活在同一事件循环里，`await` 网络时循环空闲，它一定会跑，正常收尾时由 `dispose()` 清除。
5. 超时层级：单个 attempt 的桥内结算预算短于父进程 spawn 预算，spawn 预算短于 Vitest 超时，给 `unknown` 落账与进程收尾留余量。post-UI 每臂最多 15 个登记 attempt（目录 3、正文 8、首审 2、修稿 1、复评 1）；early-review 三次串行发送，外层预算须覆盖三个完整 attempt。压缩使一次 operation 多一个物理 attempt，外层测试预算按 8 个串行 attempt 计。
6. 发送规模证据只记 UTF-8 字节数（纯数字、可 grep，多字节按真实 UTF-8），取自真正出站的请求体，绝不记提示词原文或凭据，让两臂在不花真实调用时可比。确定性的出站检查在记账前失败，不进网络诊断；供应商传输失败只在 `fetchProviderResponse` 一处进入 `fetchFailures`。

### 三、调用额度：只分类，不拒发（用户 2026-09-18 决定，ADR-0019）

1. 用户移除了真实调用硬上限。计划分配总额只用于协议一致性校验与汇报，从不拒绝发送；账本仍逐条记每次占用，上限是决策，记账是证据。最坏情形（压缩 9 次）仍在失败/重试/修复余量 22 以内，总计仍 80。
2. 因此 campaign id 从预注册协议里的 `novel-quality-program-v3-80-v1` 改为 `...-uncapped-v1`，使「80 帽时期」与现在的收据不混成同一 campaign；协议字节保持预注册原样。账本与桥取同一个常量：提交 2f259cd 曾只改桥一侧，早门在第一次发送前就以 `INVALID_CAMPAIGN_BINDING` 阻断（0 真实调用，当时未发现）。取代关系只能写一处。
3. 分配桶由阶段决定：early 用 early 桶，post-UI 重跑用 post-UI 桶（协议 `postUiContext: 2`），不混用；同一 slot 的重复发送或超出计划样本量的发送归入失败/修复余量。

### 四、历史边界：只加性认证，不改判

1. 旧协议 hash 下的真实 invocation 以「历史边界」登记：冻结前缀按边界 hash 逐字节认证，其旧的协议选择与分配只是历史证据，不是当前修订的输入，只重核稳定外壳。
2. 边界记录只含身份与证据字段，不含任何可把该 invocation 解读为「通过/改判/补采」的结论字段；失败事实与独立评审结论只写在 `quality-protocol.md`。
3. 每段的 `fromEventCount` 必须恰为前一段的链末端，更早的起点不能替代本段；事件数与 attempt 数不符一律拒绝；前缀或本段内任一字节被改，整段前缀 hash 即拒绝；整链回放自冻结前缀起依次认证到链末端。
4. `armBindings` 只登记实际出现的臂，每臂 `codeSha`/`sourceHash`/`driverHash` 必填；`parityId` 要么整臂一个值写在 `armBindings`，要么逐 attempt 写在 `reserveAttempts`，二者恰选其一。单一 `armBindings` 无法同时认证两个不同的 candidate 代码身份，所以按代码身份分成相邻两段登记。新段的三项身份都须不同于更早段（`driverHash` 与相邻段相同时用更早段身份替换才能证明三项独立）。
5. 旧协议 hash 的新 reserve 未登记为历史时，一律按当前协议拒绝；协议 hash 必须是候选代码提交里那份 `protocol.json` 的字节 hash（可复核时才断言）。
6. 版本不兼容的旧策略（如 post-UI 评审策略 v2）保留为历史 revision，不再作为可校验策略，旧目标因协议 hash 漂移被拒。前向资格只管新登记，历史 Pro 与 R3 登记保留各自身份；R3 保持八次总调用预算，每个原生审稿用途可替换一次 LENGTH 结果。

### 五、场景修订与「唯一压缩」

1. 场景修订键之间的关系：v3 只改登记（`attemptPolicy` 增加唯一压缩），作者世界设定输入与 v2 逐字相同，沿用语义源里登记给 v2 的同一条附加行，不改动冻结的语义源。场景登记的附加行只追加到作者世界设定，其余 revision 字节不变。
2. 唯一压缩（`draftCondense`）是产品原生能力的登记，不是任意失败的新重试权：只在同一 run/root/项目/epoch 的 `chapter-draft` 首请求已结算为 `stop`、其 hash 可复核的输出按生产计数超出 `draftTargetUnitRange` 上限时，许可一次 `chapter-draft-condense`；正式效果只落在末次 attempt；压缩不能作为首请求，也不能用于未登记的 operation。按臂生效：`draftCondense.arms` 缺省沿用 `attemptPolicy.arms`，post-UI v3 与 full v2 显式只给 candidate，baseline 因此从不获压缩许可、也不加载生产压缩常量。
3. **不对称必须在策略本身披露**，随协议、manifest 与每臂 receipt 的 `evaluationPolicy` 一并给出：candidate 有压缩、baseline 没有，不得据此单独声称相对改善。
4. 判定口径：压缩稿由主进程按同一份生产清洗从末次压缩原文组合（`draft-visible-v1` 组合；清洗只删不增，故结果侧「按生产计数超限」是触发压缩的必要条件，不放宽任何门）；首稿是否超长按首稿物理输出判，压缩稿是否落入范围按压缩稿自身判，最终稿（有修稿时是修稿产物）的范围由原字数门另判。post-UI 被审稿必须是压缩稿而不是被取代的首稿，full 每章没有审修链、保存稿必须就是压缩稿；修稿使最终稿越界时不归因于压缩登记；压缩稿仍越界时产品按原失败语义停下，不能因最终稿在范围内放行。
5. 压缩请求必须带全局写作要求（蓝图块之后紧接标题恰为【全局写作要求】），未登记用途一律拒绝；JSON 块止于其后第一个标题行，初始请求里空的【后续章节大纲预告】会被产品整段删去，此时接下一个标题。
6. 只有登记了压缩的 post-UI 才走 owner artifact 证据；early 与 v2 登记读到的是审稿证据，压缩因此无法放行。原生恢复只读该 attempt 的原始 artifact 与正式效果，同一草稿的旧审稿不代替本次 owner 证据。

### 六、恢复案与重新定稿后处理

1. C17-B 恢复副本内重新定稿后，登记的 notes/cards 后处理 operation 经与 C16 同一的 `RunFinalizePostProcessCommand` 执行，必须绑定替换后的新 `finalizationId`；notes 持久投影与 cards derived provenance 都要回读到同一来源。否则只会读回恢复前已冻结的旧效果。
2. 恢复类型取自本案唯一的续写 operation，而不是首项（C17-B 的首个 operation 是后处理，取首项会整段跳过恢复；开发合成曾实测复现）。`refinalize` 本身只提交定稿，harness 不重写后处理。
3. `physicalProject.readback.predecessors` 是续写实际纳入的必需前驱；替换后 readback 与 parity 同步改为替换后的来源（替换前原样另存），`parityHash` 仍须等于 readback 的 hash，续写 `materialDecision` 须纳入同一来源与 revision。
4. 登记续写的首个物理请求是唯一一次生成前定稿对账（v5），提示与输出落盘并以 hash 绑定；对账之后的写稿请求出站前先等对账流结算，才能从落盘输出重算注入块。
5. 定稿后处理（notes/cards）的原生 repair 与 C17/C18、post-UI 的唯一压缩同规则：同一 operation 只有末次 attempt 带正式效果，各自独立计数、最多两次。

### 七、夹具边界与证据口径

1. 适配器只替换 Electron 传输，不替换任何命令、运行时或仓库；最后一道 provider fetch 是合成与真实响应的唯一开关。真实账本只读认证，不写任何一行。
2. 每条前驱必须在使用前从生产 IPC 原样读回，命令只消费这些 readback，绝不旁路注入正文；第二章前驱须由本臂自己的库提供，不借另一臂输出；`accepted` 只是实验终点而非定稿章节，每次消费前重读真实行；生成的蓝图与正文因臂而异，只有原始作者输入定义初始 parity。
3. 进程内 harness 没有 Electron dialog、不能走选择器，所以与选择器同一 owner（`externalFileGrants`）为本 sender 直接签发一次性精确授权，恢复 IPC 只收授权标识（生产控制器会拒绝原始路径）。导出目标是尚不存在的子项，归档读取授权要求文件已存在，故须在导出成功之后再签发。
4. 证据缺失或畸形一律 fail closed；内部错误身份可安全暴露，自由文本、路径、供应商载荷、凭据保持脱敏；流事件只记形状与标准终态枚举，绝不记供应商文本、ID 或推理。
5. 评分规则变更（用户批准，c16-c18 v3）：作者值始终由桥断言保全；是否出现冲突候选只在模型正式生效输出确实提议改写 `mentalState` 时才要求，证据须绑定末次正式 attempt 的 hash 可复核产物并由生产解析器解析，不读自由文本；合成模式的 transport 必定提议冲突值，因此仍强制冲突候选。

## 测试口径

- 断言「拒绝」的用例按变异列表逐项构造（改 `attemptId`、改 hash、对调顺序、替换身份等），每项独立红。
- 历史账本的行数、hash 与 invocation 清单是快照，不写进注释；以代码里的登记表为准。
- 重复使用同一参数的 `continuityResults` 只落盘一次、之后给深拷贝（每次重建约 150 ms，会让用例堆积），参数一变就重建，盘上文件始终属于最近一次构建。
- 99 次真实持久化更新需要集成测试时限，该用例验证记账合同，不是性能合同。

### 夹具与驱动的口径

这些原先写在测试、夹具和 driver 的注释里，每条解释「这样构造是为了验证什么」。

- 冻结模块的私有状态要初始化成它的仓储 getter 真正读取的那一份。收据消费者的测试围绕真实的原生命令与库内证明执行，派发源是本地替身，不创建任何实验收据或账本；真实注册保持不可变，测试用显式的测试来源身份调用实际消费者。历史上冻结的原生默认租约按原注册回放，不改注册。
- 完整适配器把已接受的完整前驱经冻结命令既有的 `reviewFocus` 传入。C17-A 的公共消费者围绕真实已存的审稿与修订行，只有前序的 draft 与 outline 派发是本地夹具证据；渲染端审稿构造器对真实主进程备好的上下文执行，包括合法参考输入。
- 生产夹具的匿名消费者只供给词法输入后原样执行。夹具里的失败要发生在任何 refine 请求之前（被采纳的必现 unknown 缺产品 finding 时）；既有库持有冻结上下文与原始产物，收据只补它们的原生引用；完整保存报告校验通过后才接受空的、被取代的 LENGTH 产物；不完整的报告中止命令时，仍复用 owner 的安全终态元数据。
- 已登记的额外调用必须在 campaign reserve 之前带上真实产品用途。phase、caseId、operation 全部取自本次选定的协议阶段，账本按协议逐字校验。
- 从 dispatch 起由守护接管：到点先为这次发送写 unknown，再 abort 下面的 fetch。合成审稿只回应本臂生产代码实际冻结并发出的必现目标，未明示的记 unknown，补写后给逐字证据。
- 每臂的请求规模证据只含数字，不含提示词原文与凭据，两臂因此能在不花真实调用时比较。
- 合成篇幅文本与生产计数用与桥里完全相同的 `syntheticDraftText`、`syntheticDraftUnitsGoal` 源码：既不低于 70% 下限，也不触发自动续写。开发合成篇幅只让登记的案例首稿超出上限，压缩回复按登记结局落入目标或仍越界；其余请求与冻结、真实执行都返回目标本身，不改变既有合成行为。
- 登记的唯一压缩与续写携带同一作者资料块（【本章蓝图】紧接【全局写作要求】）。场景 revision 在语义源登记的作者设定附加行只追加到有登记的场景，其余 revision 的字节不变；产品冻结目标只在新场景 revision 下多出 `ch1:mustShow:1`，其余事实、事件与字数不变。
- driver 的几条边界：只选正式原始报告里出现的发现，规范化不算发现；baseline 的私有解析与展示从冻结源运行，不带候选的目标投影；只解析已登记的桥回退，原生 owner 预算与派发门禁仍是权威；前向实验把保存的偏好与每臂自然的传输线路分别验证；一次引文输入抽取请求的全部检查都在 campaign reserve 之前做完；已采纳的同臂库来源与发给 draft 请求的原生摘录分别验证；只从不可变的原始可见输出重放产品的有界 draft 路径。
- 登记为定稿角色状态的 operation（含 C17-B 重新定稿后的后处理）共用产品原生 repair 的门禁规则。评审包的对账摘要如实列出注入与否、冲突数、失败原因与落盘路径，不含判断；只有独立裁决过的案例进入计算，技术完成另算。

### 压缩登记（S14B）的测试口径

- post-UI v3 与 full v2 里，只有登记的臂（candidate）和 operation 可多出唯一一次压缩 attempt，baseline 与其余 operation 仍恰一次。逐臂生效：candidate 取到登记，baseline 从不，其 gate 的 `draftCondense` 恒为 null、不加载生产压缩常量；基础 early 登记与其它阶段取不到新压缩；C16–C18 沿用 `attemptPolicy.arms`（仅 candidate），登记不变；early milestone 的历史场景与 revision 不变；协议与 driver 逐字一致，full 仍是唯一的 final 里程碑，`operations` 与 `caseIds` 不变。
- 放行条件：同 run、root、项目、epoch，首稿已 `stop` 结算、hash 可复核、按生产计数超上限，才恰放行一次压缩。恰在上限不算越界，不许压缩；第二次压缩、续写冒充压缩、首请求不是 `chapter-draft`、未登记的 operation 或未登记本策略的旧门，一律在 reserve 前拒绝。DAV 续写同样登记，两个操作各自计数、互不借用。首稿产物在结算后被改写、owner artifact 或物理输出不符、首稿事实未全发出、身份错位，均拒绝。非 draft operation（首审）在 post-UI 仍走原审稿证据。
- 收据分类：合法形状是首稿超上限、恰一次压缩、保存的是压缩稿，两臂其余链条不变，仍只到独立评审待判；首稿在范围内的候选只有一个 draft attempt，同样通过。被审稿（无修稿时即保存稿）必须等于末次 draft attempt 的可见输出，生产清洗（`draft-visible-v1`）只删不增，所以仅可去除的尾随空行不算不一致。正式效果只在末次压缩；压缩 attempt 非 `stop`、正式效果错位、用途或顺序错位，均拒绝。压缩是普通可记账的物理 attempt，调用计数必须包含它；压缩与首稿必须同 run、同 root。
- 压缩后仍越界：产品保留原稿并以 `GENERATION_DRAFT_LENGTH_OUT_OF_RANGE` 停下，收据为失败且无保存与审修链，原失败语义保留；即使收据谎称 passed，保存稿仍越界时也不能进入独立评审待判。保存的仍是被压缩取代的首稿、下一章前驱仍取首稿（前驱链断裂）、baseline 出现压缩、压缩出现在 directory operation（登记只含「连续章节正文」），都拒绝。
- 开发合成默认是 24 步加候选场景 1/2 的 1 次压缩，共 25 次合成 dispatch；正式合成（无 development）不带计划，24 次、无压缩，即使被传入计划也不带。still-over 用来复现压缩后仍越界的原失败语义，full 在该步停发并保留未运行列表。前驱链上，候选场景 1/3 的前驱是场景 1/2 保存的压缩稿，baseline 不受影响。不对称披露：candidate 有压缩、baseline 无，两臂长度差异来自该不对称，不得据此单独声称相对改善。

### 后处理、恢复案与评分的测试口径

- 后处理 operation 的首请求必须是 `finalized-character-state`，notes 后处理没有 repair 权；cards 的原生 repair 同一 operation 至多三次，repair 用途按序号，只有末次带正式效果，物理计数含 repair。后处理的正式效果缺失、步骤不全、来源仍是替换前的旧 `finalizationId`，都失败；C16-C 受同一规则约束；C17-B 缺后处理即拒。后处理 attempt 必须在恢复副本的项目内，派发到原项目即失败。新 operation 只对登记的 C17-B 有效，C16 与其他恢复案都拒绝。
- 案例的定稿替换：C16-B、C16-C 在原项目重新定稿，C17-B 在恢复副本内重新定稿，后处理与续写都绑定替换后的新来源。桥侧恢复副本重新定稿后，登记的后处理 operation 走与 C16 同一的 `RunFinalizePostProcessCommand`，来源必须等于替换后的新来源，并按生产 IPC 回读 notes 投影与 cards provenance 落盘。抽取案恰为 notes 与 cards；恢复案恰一个同 kind 续写，只有带 `sourceSuffix` 的恢复案（C17-B）前置重新定稿后处理。协议从 v4 起让每个 operation 的 kind、restore 与 caseIds 逐字对齐：哪一案执行哪些后处理或续写只由协议决定。
- readback 与 parity：原缺陷是 readback 仍停在替换前的状态，即使 parity 自洽也拒绝；readback 被改写但 `parityHash` 没随之更新也拒绝，parity 绑定不放宽；续写的 `materialDecision` 没纳入 readback 记录的来源或 revision，拒绝；其他恢复案同样要求 readback 必需的前驱与续写实际纳入的来源一致，登记的唯一压缩 attempt 也须纳入同一来源。桥侧替换后按同一 `parityPredecessors` 重算 readback 与 parity，替换前的原样另存，其后的 dispatch 绑定新 parity；生产桥入口在建任何目录前同样逐字比对。其他阶段的策略保持原样：early-review 仍没有额外尝试权，early-budget 仍只有原两类修复。
- 授权：归档读取授权要求文件已存在，所以导出之前签发必失败、导出之后才成立，并且不能被换成写入用途或他窗口使用；恢复目标同样是尚不存在的子项，已被占用的目录不会因此授权到覆盖之外的任何位置。四条生产 IPC 只携带授权标识，原始路径形状不再出现在夹具里；断言不放宽，恢复出的目标必须正是授权解析出的「规范父目录加子项名」，来源项目与新身份检查照旧。
- 评分规则（c16-c18 v3）：真实模式下模型正式输出没提议改写 `mentalState` 时是 untriggered，不因缺冲突候选失败；提议了不同值就必须存在冲突候选；合成模式的 transport 必提议冲突值，未提议或无候选都失败。绑定的必须是末次正式 attempt（cards 有被取代的前序 attempt 时指向它即失败）；正式产物文件缺失即失败，字节被改写由既有 owner 核对先行拒绝。proposed 只由末次正式 attempt 的 hash 可复核 owner 产物经生产解析器得出；作者值保全的断言对全部模式不变。
- 其余变异：必现 unknown 被采纳时，合成修订逐字补写目标，真实模式原样返回模型输出位置的正文；candidate（及未声明臂）采纳的必现 unknown 必须带产品 review-cycle 的 findingId，baseline 没有 review-cycle，不要求；C16 三案的 oracle（提取 notes 与 cards 的计划状态记录）保持原文；产品删去空的【后续章节大纲预告】整段后，初始请求的蓝图块止于下一个标题，夹带非 JSON 文本仍拒；两个不同臂的槽位吃满 earlyContext 的协议分配额，同槽重试只吃失败与修复余量；错 caseId、错 operation、未登记阶段（full 只有 caseIds）一律拒绝。

### 账本边界与发送守护的测试口径

- 真实账本只读认证：字节与 sha256 前后不变，按当前协议的全部边界链回放，不写任何一行。合成账本里，登记为历史的各段之后，当前 reserve 通过；缺该段则同一段按当前协议被拒。新协议下仍带旧协议 hash 的新 reserve（未登记为历史）一律按当前协议拒绝；整链回放要求全部边界自冻结前缀起依次认证到链末端。新协议字节的 hash 与被取代的旧值不同，runner 的读写两个入口都按链末端取历史范围。
- 每一段都只加性追加：前缀的原字节仍是前一段认证的整本账本，之后账本继续追加，本段前缀 hash 仍须成立；前缀或本段内任一字节被改、本段内多出一行（重复一个事件）都使前缀 hash 漂移而拒绝，少一行或缺整段则前缀不足。`fromEventCount` 必须恰为前一段的链末端，更早的起点不能替代；跳过前段直接登记本段拒绝；事件数与 attempt 数不符（多或少一个事件、多或少登记一次 attempt）拒绝；attempt 顺序即账本顺序，对调相邻两个 `attemptId` 即拒绝；`parityId` 错位拒绝，逐 attempt 的 parityId 顺序即案序；账本里 reserve 的案序、臂序与 operation 序要与自动阶段收据 `results[].attempts` 的顺序一致。
- 两臂边界：baseline 整臂一个 parity（登记在 `armBindings`），candidate 逐 attempt 登记 parity；缺任一臂的绑定、两臂绑定错位、把一臂三项身份逐项替换成另一臂的值（相同则换成全 f），均拒绝；终态、`attemptId`、`invocationId` 逐项核对，任一项改成 unknown、写错或换成别的 invocation 都拒绝；candidate 的身份可以不同于上一段（`codeSha` 是其后的提交），`driverHash` 也不同于上一段，旧值不能替代。边界记录的协议 hash 必须是候选代码提交里 `protocol.json` 的字节 hash，可复核时才断言。单一 `armBindings` 无法同时认证两次不同的 candidate 代码身份，这正是分段登记的原因。
- 只登记 candidate 的单臂边界：baseline 的 reserve 或 attempt 一律拒绝，parityId 必须恰在一处登记；边界通过之后，新 reserve 按当前协议继续，不登记则同一段被当作当前协议而得 `PROTOCOL_DRIFT`；边界内 reserve 的 `invocationId`、`protocolHash`、`codeSha`、逐 attempt `parityId` 不符都拒绝。既有两臂边界（`armBindings` 含整臂 `parityId`）的语义不变。
- 发送守护：取消发生在 dispatch 之前的预留必须保持「未发送」，不被守护伪造成已发送；幂等，晚到的终态不能改写同一次发送，也不能再多落一行；dispatch 过的发送只能是 settle 或 unknown，不能取消释放，也不能重开同一个 attempt。先写账本再记终态：写失败（例如 `LEDGER_BUSY`）不吞终态，调用方仍可重试。
